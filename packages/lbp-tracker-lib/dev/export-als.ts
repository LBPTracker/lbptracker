/**
 * The Ableton export, over the real level corpus -- and one set written to disk.
 *
 *     node packages/lbp-tracker-lib/dev/export-als.ts
 *     LBP_UID=723339 LBP_ALS_OUT=fixtures/out/song.als node packages/lbp-tracker-lib/dev/export-als.ts
 *
 * Without `LBP_ALS_OUT` it exports every music sequencer in `LBP_LEVELS` and
 * prints what the set could not say, summed: the counters on `AlsExportResult`.
 * With it, it writes one set -- `LBP_UID`'s, or the largest -- gzipped, which is
 * what an `.als` is, for opening in Live.
 *
 * ⚠️ **Nothing here can tell whether Live will show what the file says.** Live
 * 11 opens a set with members missing and fills them with defaults, without a
 * word in its log; that is how `sequencerdump`'s sets open with every clip
 * gone. The check is to open the file in Live and look -- `tools.md` has how.
 * What this does check is that the XML is well-formed and every id is unique,
 * which are the two things a string builder gets wrong silently.
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { readLevelProject, type Sequencer } from '@lbptracker/cwlib/sequencer/project.ts';
import { nodeInflate } from '@lbptracker/cwlib/platform/node.ts';
import { loadResource } from '@lbptracker/cwlib/io/resource.ts';
import { alsProjectFiles, sequencerToAls } from '../src/als.ts';
import type { AlsInstrumentSource } from '../src/als-sampler.ts';
import { readInstrument, usedSlots, type RInstrument } from '@lbptracker/cwlib/resources/instrument.ts';
import { MASTER_DEFAULTS } from '../src/audio/master.ts';

const LEVELS = process.env.LBP_LEVELS ?? 'C:/Users/sgdc3/Desktop/LBP/toolkit/tools/sequencerdump/data';
const out = process.env.LBP_ALS_OUT;
const wantUid = Number(process.env.LBP_UID ?? 0);
const bakeSwing = process.env.LBP_BAKE_SWING === '1';
/** `LBP_ALS_INSTRUMENTS=1`: a Sampler per track from `fixtures/rinst` and `fixtures/smp`, and `LBP_ALS_OUT` becomes a project folder. */
const withInstruments = process.env.LBP_ALS_INSTRUMENTS === '1';
/** `LBP_ALS_MASTER=<glue 0..10>`: the tracker's master bus on the master track, at that glue. */
const masterBus = process.env.LBP_ALS_MASTER === undefined
  ? undefined
  : { amount: Number(process.env.LBP_ALS_MASTER), ceilingDb: MASTER_DEFAULTS.ceilingDb };

const names = await readFile('fixtures/rinst/manifest.json', 'utf8')
  .then((text) => new Map((JSON.parse(text) as { guid: number; file: string }[])
    .map((row) => [row.guid, row.file.replace(/\.rinst$/, '')])))
  .catch(() => new Map<number, string>());
const instrumentName = (guid: number) => names.get(guid);

/**
 * Tags balanced, and no id of one space given twice.
 *
 * Not an XML parser: the builder writes one tag per line and never a `<` in
 * text, so a stack over the lines is enough to catch a tag left open.
 */
function check(xml: string): string[] {
  const problems: string[] = [];
  const stack: string[] = [];
  for (const tag of xml.matchAll(/<(\/?)([A-Za-z][\w.]*)[^>]*?(\/?)>/g)) {
    const [, close, name, self] = tag;
    if (self) continue;
    if (!close) stack.push(name);
    else if (stack.pop() !== name) {
      problems.push(`</${name}> closes something else`);
      break;
    }
  }
  if (stack.length > 0) problems.push(`left open: ${stack.slice(-3).join(' > ')}`);
  const ids = new Set<string>();
  for (const m of xml.matchAll(/<(?:AutomationTarget|ModulationTarget|Pointee|ControllerTargets\.\d+|\w+ModulationTarget) Id="(\d+)"/g)) {
    if (ids.has(m[1])) {
      problems.push(`id ${m[1]} given twice`);
      break;
    }
    ids.add(m[1]);
  }
  const next = Number(/<NextPointeeId Value="(\d+)"/.exec(xml)?.[1]);
  const highest = Math.max(0, ...[...ids].map(Number));
  if (!(next > highest)) problems.push(`NextPointeeId ${next} is not past ${highest}`);
  return problems;
}

const manifest = async (dir: string) => new Map((JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as { guid: number; file: string }[]).map((r) => [r.guid, r.file]));

/**
 * The instruments a sequencer uses, without their samples, from the extracted
 * fixtures -- what every set needs, as the page fetches them for every export:
 * the echo send the engine plays is the instrument's own (`instrumentSettings`).
 */
const parsed = new Map<number, RInstrument | undefined>();
async function loadSettings(seq: Sequencer): Promise<Map<number, RInstrument>> {
  const rinst = await manifest('fixtures/rinst').catch(() => new Map<number, string>());
  const out = new Map<number, RInstrument>();
  for (const guid of new Set(seq.tracks.map((t) => t.guid))) {
    if (!parsed.has(guid)) {
      const file = rinst.get(guid);
      parsed.set(guid, file === undefined ? undefined
        : readInstrument((await loadResource(new Uint8Array(await readFile(path.join('fixtures/rinst', file))), nodeInflate)).data));
    }
    const instrument = parsed.get(guid);
    if (instrument !== undefined) out.set(guid, instrument);
  }
  return out;
}

/** The instruments a sequencer uses, with their samples, from the extracted fixtures. */
async function loadInstruments(seq: Sequencer): Promise<Map<number, AlsInstrumentSource>> {
  const smp = await manifest('fixtures/smp');
  const out = new Map<number, AlsInstrumentSource>();
  for (const [guid, instrument] of await loadSettings(seq)) {
    const samples = new Map<number, { name: string; bytes: Uint8Array }>();
    for (const { guid: sampleGuid } of usedSlots(instrument)) {
      const name = smp.get(sampleGuid);
      if (name) samples.set(sampleGuid, { name, bytes: new Uint8Array(await readFile(path.join('fixtures/smp', name))) });
    }
    out.set(guid, { instrument, samples });
  }
  return out;
}

const sequencers: { level: string; seq: Sequencer }[] = [];
for (const entry of await readdir(LEVELS, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  try {
    const project = await readLevelProject(
      entry.name,
      new Uint8Array(await readFile(path.join(LEVELS, entry.name))),
      nodeInflate,
    );
    for (const seq of project.sequencers) sequencers.push({ level: entry.name, seq });
  } catch (error) {
    console.log(`${entry.name}: ${(error as Error).message}`);
  }
}

if (out !== undefined) {
  const pick = wantUid
    ? sequencers.find((s) => s.seq.uid === wantUid)
    : [...sequencers].sort((a, b) => b.seq.tracks.length - a.seq.tracks.length)[0];
  if (!pick) throw new Error(`no sequencer ${wantUid} in ${LEVELS}`);
  const instruments = withInstruments ? await loadInstruments(pick.seq) : undefined;
  const instrumentSettings = await loadSettings(pick.seq);
  const result = sequencerToAls(pick.seq, { instrumentName, bakeSwing, instruments, instrumentSettings, masterBus });
  const problems = check(result.xml);
  if (problems.length > 0) throw new Error(problems.join('; '));
  if (instruments) {
    // A project folder: the set, its samples, and `Ableton Project Info`.
    for (const file of alsProjectFiles(pick.seq.name, gzipSync(result.xml), result.samples)) {
      const at = path.join(out, file.name);
      if (file.name.endsWith('/')) await mkdir(at, { recursive: true });
      else {
        await mkdir(path.dirname(at), { recursive: true });
        await writeFile(at, file.bytes);
      }
    }
    console.log(
      `${result.instrumentTracks} Samplers, ${result.samples.length} samples; ` +
      `${result.offModulation} notes off their track's modulation (level and cutoff follow; the rest is the track's)`,
    );
  } else {
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, gzipSync(result.xml));
  }
  console.log(
    `${pick.level} "${pick.seq.name}" uid ${pick.seq.uid}: ${result.tracks} tracks from ` +
    `${result.parts} parts, ${result.switches} mixer switches, ` +
    `${result.clips} clips from ${result.placements} placements, ${result.notes} notes, ` +
    `${result.glides} glides -> ${out}`,
  );
} else {
  const sum = {
    tracks: 0, parts: 0, switches: 0, clips: 0, placements: 0, notes: 0, glides: 0, clampedPitch: 0, clampedBend: 0, clampedSlide: 0,
    overlapping: 0, instrumentTracks: 0, offModulation: 0,
  };
  let bytes = 0;
  let broken = 0;
  let sampleBytes = 0;
  for (const { level, seq } of sequencers) {
    const instruments = withInstruments ? await loadInstruments(seq) : undefined;
    const instrumentSettings = await loadSettings(seq);
    const result = sequencerToAls(seq, { instrumentName, instruments, instrumentSettings, masterBus });
    sampleBytes += result.samples.reduce((n, s) => n + s.bytes.length, 0);
    const problems = check(result.xml);
    if (problems.length > 0) {
      broken += 1;
      console.log(`${level} "${seq.name}": ${problems.join('; ')}`);
    }
    for (const key of Object.keys(sum) as (keyof typeof sum)[]) sum[key] += result[key];
    bytes += gzipSync(result.xml).length;
  }
  console.log(`${sequencers.length} sequencers, ${broken} malformed`);
  console.log(
    `${sum.tracks} tracks from ${sum.parts} parts, ${sum.switches} mixer switches, ` +
    `${sum.clips} clips from ${sum.placements} placements, ${sum.notes} notes, ` +
    `${sum.glides} glides, ${(bytes / 1e6).toFixed(1)} MB gzipped`,
  );
  console.log(
    `clamped: ${sum.clampedPitch} keys, ${sum.clampedBend} bend points, ${sum.clampedSlide} slide points; ` +
    `${sum.overlapping} notes overlap one of their own key`,
  );
  if (withInstruments) {
    console.log(
      `instruments: ${sum.instrumentTracks} of ${sum.tracks} tracks got a Sampler, ` +
      `${(sampleBytes / 1e6).toFixed(1)} MB of samples; ${sum.offModulation} notes off their track's modulation (level and cutoff follow; the rest is the track's)`,
    );
  }
}
