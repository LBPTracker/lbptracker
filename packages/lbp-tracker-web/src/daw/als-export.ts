/**
 * The song out as an Ableton Live set: a `.als` Live 11 and later opens -- or,
 * with its option on, a Live project holding the set, a Sampler per track and
 * the game's samples, as a zip.
 *
 * The writing is `@lbptracker/lib/als.ts` and `als-sampler.ts`, which is where
 * the schema and the reasons for it live. This is the view around it: the
 * options, the button, the tally that says what the set could not hold, and
 * the fetching of the instruments and samples, which only the page can do.
 *
 * ❗ **An `.als` is gzipped XML, and the gzip is done here.** The library hands
 * back the text so it stays free of a platform API; the browser's own
 * `CompressionStream` does the rest, the same way `webDeflate` does for a plan.
 *
 * ⚠️ **The instruments are off by default**, and that is the owner's rule: on,
 * the download carries Sony / Media Molecule's samples (`game-assets.md`,
 * *Asset licensing*), and a set of notes alone is the plainer thing to hand
 * someone.
 */

import { createApp, watch } from 'vue';
import ControlPanel from '../controls/ControlPanel.vue';
import { als } from '../controls/als.ts';
import { engine } from '../controls/engine.ts';
import { CONTROLS } from '../controls/kit.ts';
import { alsProjectFiles, sequencerToAls, type AlsExportResult } from '@lbptracker/lib/als.ts';
import type { AlsInstrumentSource } from '@lbptracker/lib/als-sampler.ts';
import { MASTER_DEFAULTS, type MasterSettings } from '@lbptracker/lib/audio/master.ts';
import { readInstrument, usedSlots, type RInstrument } from '@lbptracker/cwlib/resources/rinstrument.ts';
import { type Sequencer } from '@lbptracker/cwlib/sequencer/project.ts';
import { loadResource } from '@lbptracker/cwlib/io/resource.ts';
import { webInflate } from '@lbptracker/cwlib/platform/web.ts';
import { writeZip } from '@lbptracker/cwlib/archives/zip.ts';

import { asset } from '../assets.ts';
import { download } from '../song-file.ts';
import { currentSequencer, ensureAssets, rinstIndex, setStatus, smpIndex, state } from './session.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A file name for a set: the song's name, made safe, plus the suffix. */
export function alsFileName(name: string): string {
  return `${name.replace(/[^\w .-]+/g, '_').trim() || 'song'}.als`;
}

/** Bytes from the deployment's own assets, by path. */
async function fetchBytes(path: string): Promise<Uint8Array> {
  const response = await fetch(asset(path));
  if (!response.ok) throw new Error(`${response.status} fetching ${path}`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * An instrument a song uses, without its samples, fetched once.
 *
 * ❗ **Every set needs these, the instruments option or not**: the echo send
 * the engine plays is the instrument's own `Params[25]`, which the placement
 * only bends (`AlsExportOptions.instrumentSettings`). A `.rinst` is 149 to
 * 298 bytes, and only a number off it goes into the set.
 */
const settings = new Map<number, Promise<RInstrument | undefined>>();
function settingsFor(guid: number): Promise<RInstrument | undefined> {
  let hit = settings.get(guid);
  if (hit === undefined) {
    hit = (async () => {
      const row = rinstIndex?.get(guid);
      if (!row) return undefined;
      return readInstrument((await loadResource(await fetchBytes(`fixtures/rinst/${row.file}`), webInflate)).data);
    })();
    // A failure is forgotten, so the next export tries again.
    hit.catch(() => settings.delete(guid));
    settings.set(guid, hit);
  }
  return hit;
}

async function settingsOf(seq: Sequencer): Promise<Map<number, RInstrument>> {
  const out = new Map<number, RInstrument>();
  await Promise.all([...new Set(seq.tracks.map((t) => t.guid))].map(async (guid) => {
    const instrument = await settingsFor(guid);
    if (instrument) out.set(guid, instrument);
  }));
  return out;
}

/**
 * The instruments a song uses and the samples they play, fetched once each.
 *
 * Kept across exports: a second export of the same song, or of the next one,
 * fetches only what it has not seen.
 */
const sources = new Map<number, Promise<AlsInstrumentSource | undefined>>();
function sourceFor(guid: number): Promise<AlsInstrumentSource | undefined> {
  let hit = sources.get(guid);
  if (hit === undefined) {
    hit = (async () => {
      const instrument = await settingsFor(guid);
      if (!instrument) return undefined;
      const samples = new Map<number, { name: string; bytes: Uint8Array }>();
      await Promise.all(usedSlots(instrument).map(async ({ guid: sampleGuid }) => {
        const file = smpIndex?.get(sampleGuid)?.file;
        if (file) samples.set(sampleGuid, { name: file, bytes: await fetchBytes(`fixtures/smp/${file}`) });
      }));
      return { instrument, samples };
    })();
    // A failure is forgotten, so the next export tries again.
    hit.catch(() => sources.delete(guid));
    sources.set(guid, hit);
  }
  return hit;
}

async function instrumentsOf(seq: Sequencer): Promise<Map<number, AlsInstrumentSource>> {
  const out = new Map<number, AlsInstrumentSource>();
  await Promise.all([...new Set(seq.tracks.map((t) => t.guid))].map(async (guid) => {
    const source = await sourceFor(guid);
    if (source) out.set(guid, source);
  }));
  return out;
}

export function mountAlsExport(opts: {
  isActive: () => boolean;
  onShow: (listener: () => void) => void;
  log: (text: string, bad?: boolean) => void;
}): void {
  const button = $<HTMLButtonElement>('cv-alsSave');
  const optionsApp = createApp(ControlPanel);
  optionsApp.provide(CONTROLS, als);
  optionsApp.mount('#cv-alsOptions');

  let result: AlsExportResult | undefined;
  let songName = 'song';
  /** Which conversion is the latest: an older one finishing late must not win. */
  let generation = 0;

  const plural = (n: number, one: string) => `${n.toLocaleString()} ${one}${n === 1 ? '' : 's'}`;

  async function convert(): Promise<void> {
    const mine = ++generation;
    button.disabled = true;
    $('cv-alsReport').classList.remove('on');
    if (state.song.clips.length === 0) return;
    const seq = currentSequencer();
    // The chips as drawn, taken with the song they belong to (the fetch below
    // can outlast an edit): `sequencerFromSong` makes one track per clip, in
    // order, and a grid's length is the one thing it cannot carry.
    const clipSteps = state.song.clips.map((clip) => clip.steps);
    const withInstruments = als.on('instruments');
    // The master bus as the engine has it: one glue knob, in the Song/Mixer card.
    const masterBus: MasterSettings | undefined = als.on('masterBus')
      ? { amount: engine.raw('masterAmount'), ceilingDb: MASTER_DEFAULTS.ceilingDb }
      : undefined;
    button.textContent = withInstruments ? 'Download .zip' : 'Download .als';
    let instruments: Map<number, AlsInstrumentSource> | undefined;
    let instrumentSettings: Map<number, RInstrument> | undefined;
    // The settings alone are small and kept, so they fetch without a word.
    if (withInstruments) setStatus('fetching the instruments and their samples…');
    try {
      if (withInstruments) instruments = await instrumentsOf(seq);
      else instrumentSettings = await settingsOf(seq);
    } catch (error) {
      if (mine === generation) setStatus(`could not fetch the instruments: ${(error as Error).message}`, true);
      return;
    }
    if (mine !== generation) return;
    result = sequencerToAls(seq, {
      bakeSwing: als.on('bakeSwing'),
      mergeRows: als.on('mergeRows'),
      instrumentName: (guid: number) => rinstIndex?.get(guid)?.file.replace('.rinst', ''),
      instruments,
      instrumentSettings,
      clipSteps,
      masterBus,
    });
    songName = seq.name;

    const lost: string[] = [];
    if (result.clampedBend > 0) {
      lost.push(`${plural(result.clampedBend, 'control point')} glided further than Live’s ±48 semitones and stop there.`);
    }
    if (result.clampedSlide > 0) {
      lost.push(`${plural(result.clampedSlide, 'control point')} move the filter further than the Sampler’s slide reaches, six octaves, and stop there.`);
    }
    if (result.clampedPitch > 0) lost.push(`${plural(result.clampedPitch, 'note')} fell outside MIDI’s 0–127 and were clamped.`);
    if (result.offModulation > 0) {
      lost.push(`${plural(result.offModulation, 'note')} use a modulation other than the one their track’s instrument ` +
        'is set at: their level and filter cutoff follow it, their envelopes and resonance are the track’s.');
    }
    // Parts of one track in different keys are not here either: with a Sampler
    // each note plays its own zone at its own pitch (`als.ts`, the raw note).
    // Notes of one key overlapping are not here: Live keeps both, as the game
    // does (measured, `AlsExportResult.overlapping`), so nothing is lost.
    const sampleBytes = result.samples.reduce((n, s) => n + s.bytes.length, 0);
    const items = [
      { value: String(result.tracks), label: result.tracks === result.parts ? 'tracks' : `tracks for ${result.parts} parts` },
      ...(result.switches > 0 ? [{ value: result.switches.toLocaleString(), label: 'mixer changes' }] : []),
      { value: result.clips.toLocaleString(), label: 'clips' },
      { value: result.notes.toLocaleString(), label: 'notes' },
      { value: result.glides.toLocaleString(), label: 'glides' },
      ...(masterBus ? [{ value: `glue ${masterBus.amount}`, label: 'master bus' }] : []),
      ...(withInstruments ? [
        { value: String(result.instrumentTracks), label: 'instruments' },
        { value: `${(sampleBytes / 1e6).toFixed(1)} MB`, label: `in ${plural(result.samples.length, 'sample')}` },
      ] : []),
      ...(lost.length === 0 ? [{ value: '✓', label: 'nothing lost' }] : []),
    ];
    $('cv-alsTally').innerHTML = items
      .map((item) => `<span class="item"><b>${item.value}</b><span>${item.label}</span></span>`)
      .join('');
    $('cv-alsLost').innerHTML = lost.map((line) => `<li>${line}</li>`).join('');
    $('cv-alsReport').classList.add('on');
    button.disabled = false;
    if (withInstruments) setStatus(`${seq.name || 'untitled'}: ${plural(result.instrumentTracks, 'instrument')} ready`);
  }

  button.addEventListener('click', () => {
    const made = result;
    if (!made) return;
    void gzip(made.xml).then((set) => {
      if (made.samples.length === 0 && !als.on('instruments')) {
        const name = alsFileName(songName);
        download(name, set, 'application/octet-stream');
        opts.log(`saved ${name}, ${(set.length / 1024).toFixed(0)} kB`);
        setStatus(`saved ${name}`);
        return;
      }
      // The project: the set, its samples and `Ableton Project Info`, which is
      // what lets Live find the samples by their relative path.
      const zip = writeZip(alsProjectFiles(songName, set, made.samples));
      const name = alsFileName(songName).replace(/\.als$/, ' Project.zip');
      download(name, zip, 'application/zip');
      opts.log(`saved ${name}, ${(zip.length / 1e6).toFixed(1)} MB, ${plural(made.samples.length, 'sample')}`);
      setStatus(`saved ${name}`);
    });
  });

  watch(
    () => [als.on('bakeSwing'), als.on('mergeRows'), als.on('instruments'), als.on('masterBus'), engine.raw('masterAmount')],
    () => { if (opts.isActive()) void convert(); },
  );
  // The song changed while the view is up: re-run, but not on every pixel of a drag.
  let timer = 0;
  state.onChange(() => {
    if (!opts.isActive()) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void convert(), 250);
  });
  // The instrument names come from the manifest, so wait for it the way the MIDI export does.
  opts.onShow(() => void ensureAssets().then(() => convert(), () => convert()));
}
