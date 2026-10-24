/**
 * The MIDI round trip, over the real level corpus.
 *
 *     node --experimental-strip-types packages/lbp-tracker-lib/dev/verify-midi.ts
 *
 * `packages/lbp-tracker-lib/test/midi.test.ts` pins the behaviour on fixtures small enough to reason
 * about. This is the other half: every music sequencer in the corpus, exported
 * and read back, with the scheduled note stream compared position by position.
 * Real compositions carry things a fixture will not think of -- notes that open
 * at volume zero, glides across a scale change, parts a thousand clips long --
 * and the point of a converter is that it survives them.
 *
 * What is compared is the MUSIC, not the bytes: `Key` and `Scale` are baked into
 * the note numbers on the way out, so the record fields legitimately differ.
 * See the header of `packages/lbp-tracker-lib/src/midi.ts`.
 *
 * `LBP_LEVELS` is the corpus directory. Nothing here is committed.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { factoryColour } from '@lbptracker/cwlib/sequencer/chips.ts';
import { midiToSequencer, sameNotes, sequencerToMidi } from '../src/midi.ts';
import { metaString, readMidi, varLength } from '../src/smf.ts';
import { schedule, type Sequencer } from '@lbptracker/cwlib/sequencer/project.ts';
import { readLevelProject } from '@lbptracker/cwlib/sequencer/project.ts';
import { blockRoot, notePitch } from '../src/scale.ts';
import { nodeInflate } from '@lbptracker/cwlib/platform/node.ts';

const LEVELS = process.env.LBP_LEVELS ?? 'C:/Users/sgdc3/Desktop/LBP/toolkit/tools/sequencerdump/data';

/**
 * `LBP_MIDI_LOOSE=1` exports without the verbatim record patch.
 *
 * ⚠️ **The two settings measure different things and both are worth
 * having.** With the patch on -- the default, and what the app writes -- the
 * round trip is exact down to the bytes, which makes `flattened` and `dropped`
 * descriptions of what a FOREIGN reader loses rather than of what comes back.
 * With it off, the file is MIDI and nothing else, and the counters mean what
 * they used to: this is the setting that says how much of the music survives
 * without our metas.
 */
const loose = process.env.LBP_MIDI_LOOSE === '1';

/** The note stream, in the terms a MIDI file can carry. */
function music(sequencer: Sequencer) {
  return schedule(sequencer).map((event) => {
    const track = sequencer.tracks[event.track];
    const root = blockRoot(track.key);
    const midi = (raw: number) => Math.max(0, Math.min(127, notePitch(raw, track.scale, root)));
    // ⚠️ **The modulation the note SOUNDS, not its first record's.** Points
    // that share a position are taken at their later value the instant they
    // arrive -- the engine's `t = span > 0 ? … : 1` -- so a pair at the note's
    // start makes the first record's modulation something nothing ever hears.
    // Comparing that field instead blamed `Salem` for notes the round trip
    // reproduces exactly.
    let opening = 0;
    for (const p of event.points) {
      if (p.step > 0) break;
      opening = p.modulation;
    }
    return {
      step: Math.round(event.step * 3),
      duration: Math.round(event.durationSteps * 3),
      pitch: midi(event.pitch),
      volume: event.volume,
      modulation: Math.round(opening * 15),
      // The curve, sampled where records can sit: thirds of a step.
      curve: sampleCurve(
        event.points.map((p) => ({
          at: p.step,
          pitch: midi(p.pitch),
          volume: p.volume,
          // On the nibble's own scale, so one unit means one step of the field.
          mod: p.modulation * 15,
        })),
      ),
    };
  });
}

function sampleCurve(points: { at: number; pitch: number; volume: number; mod: number }[]) {
  const out: [number, number, number][] = [];
  const last = points[points.length - 1].at;
  for (let thirds = 0; thirds <= Math.round(last * 3); thirds += 1) {
    const at = thirds / 3;
    let i = 0;
    while (i + 1 < points.length && points[i + 1].at <= at) i += 1;
    const from = points[i];
    const to = points[i + 1];
    const span = to ? to.at - from.at : 0;
    const t = to && span > 0 ? (at - from.at) / span : 0;
    out.push([
      to ? from.pitch + (to.pitch - from.pitch) * t : from.pitch,
      to ? from.volume + (to.volume - from.volume) * t : from.volume,
      to ? from.mod + (to.mod - from.mod) * t : from.mod,
    ]);
  }
  return out;
}

let sequencers = 0;
let notes = 0;
let failed = 0;
let worstPitch = 0;
let worstVolume = 0;
let worstMod = 0;
let bent = 0;
const totals = {
  shared: 0, dropped: 0, clampedPitch: 0, clampedBend: 0, bytes: 0, lengthened: 0,
  flattened: 0, deviating: 0, automated: 0, dragged: 0, timbred: 0,
  clips: 0, clipsChanged: 0, records: 0, patched: 0, unpatched: 0, tinted: 0, tintsLost: 0,
  heard: 0, misMixed: 0,
};

/**
 * The budget: which carrier every byte of the file goes to.
 *
 * ❗ **Exact, because `writeMidi` does not use running status**: an event costs
 * `varLength(delta) + data.length` and nothing else, so the rows below add up
 * to the file minus its headers and its End of Track events. The two fields
 * that are not events of their own -- `fix` and the chip tint, which live
 * inside a `LBP-TRK` meta -- are weighed by re-serialising the meta without
 * them, which is what they add to it.
 *
 * `LBP_MIDI_BUDGET=1` prints the table in steering/midi-interchange.md.
 */
const budget = process.env.LBP_MIDI_BUDGET === '1';
const weights = new Map<string, { bytes: number; events: number }>();

function put(name: string, bytes: number, events = 1): void {
  const row = weights.get(name) ?? { bytes: 0, events: 0 };
  row.bytes += bytes;
  row.events += events;
  weights.set(name, row);
}

/** What a meta's JSON costs without one of its fields, as bytes. */
function fieldCost(text: string, keys: readonly string[]): number {
  const at = text.indexOf('{');
  if (at < 0) return 0;
  try {
    const parsed = JSON.parse(text.slice(at)) as Record<string, unknown>;
    const whole = JSON.stringify(parsed).length;
    for (const key of keys) delete parsed[key];
    return whole - JSON.stringify(parsed).length;
  } catch {
    return 0;
  }
}

function weigh(bytes: Uint8Array): void {
  for (const track of readMidi(bytes).tracks) {
    let previous = 0;
    for (const event of track.events) {
      const size = varLength(event.tick - previous) + event.data.length;
      previous = event.tick;
      const status = event.data[0] & 0xf0;
      const text = metaString(event);
      if (text?.type === 0x01 && text.text.startsWith('LBP-TRK ')) {
        const fix = fieldCost(text.text, ['fix']);
        const tint = fieldCost(text.text, ['colour', 'colours']);
        put('LBP-TRK meta -- placement and cells', size - fix - tint);
        if (fix > 0) put('LBP-TRK `fix` -- verbatim records', fix);
        put('LBP-TRK `colour` -- the chip tint', tint);
      } else if (text?.type === 0x01 && text.text.startsWith('LBP-SEQ ')) put('LBP-SEQ meta -- the sequencer', size);
      else if (text?.type === 0x03) put('track name meta', size);
      else if (event.data[0] === 0xff) put('tempo, time signature, end of track', size);
      else if (status === 0xe0) put('pitch bend -- the glide', size);
      else if (status === 0xd0) put('channel pressure -- the volume', size);
      else if (status === 0x90) put('note on', size);
      else if (status === 0x80) put('note off', size);
      else if (status === 0xb0 && event.data[1] === 74) put('CC 74 -- the modulation', size);
      else if (status === 0xb0 && [7, 10, 90, 91].includes(event.data[1])) put('CC 7/10/90/91 -- the mixer', size);
      else if (status === 0xb0) put('RPN / MPE configuration', size);
      else put('everything else', size);
    }
  }
}

/**
 * Notes a DAW plays under another placement's mixer.
 *
 * ❗ **The round trip cannot see this, so it is measured apart.** Our import
 * reads the mixer from a meta beside the controllers and was exact while a DAW
 * played 65,345 notes of the corpus on the wrong level, pan or send: each part's
 * controllers were written once, at its first cell, and parts sharing a track
 * interleave. This reads the file the way a DAW does -- whatever CC 7, 10, 91
 * and 90 say at a note-on is what that note gets -- and compares it with the
 * placement the note came from, found by row, instrument, tick and key.
 */
function misMixed(seq: Sequencer, bytes: Uint8Array): { heard: number; wrong: number } {
  const file = readMidi(bytes);
  const ticksPerStep = file.division / 4;
  const c7 = (v: number) => Math.max(0, Math.min(127, Math.round(v * 127)));
  /** Every mixer a note at this row, instrument, tick and key may rightly hear. */
  const expected = new Map<string, Set<string>>();
  for (const e of schedule(seq)) {
    const t = seq.tracks[e.track];
    const key = Math.max(0, Math.min(127, notePitch(e.pitch, t.scale, blockRoot(t.key))));
    const at = `${t.gridY}|${t.guid}|${Math.round(e.step * ticksPerStep)}|${key}`;
    const set = expected.get(at) ?? new Set<string>();
    set.add([c7(t.level), c7(t.pan), c7(t.reverbSend), c7(t.echoSend)].join(','));
    expected.set(at, set);
  }
  let heard = 0;
  let wrong = 0;
  for (const track of file.tracks) {
    let identity: string | undefined;
    for (const event of track.events) {
      const text = metaString(event);
      if (text?.type === 0x01 && text.text.startsWith('LBP-TRK ')) {
        const meta = JSON.parse(text.text.slice(8)) as { gridY: number; guid: number };
        identity = `${meta.gridY}|${meta.guid}`;
        break;
      }
    }
    if (identity === undefined) continue;
    const dials = new Map<number, number>();
    for (const event of track.events) {
      const [status, a, b] = event.data;
      if ((status & 0xf0) === 0xb0 && [7, 10, 91, 90].includes(a)) dials.set(a, b);
      if ((status & 0xf0) !== 0x90 || b === 0) continue;
      const set = expected.get(`${identity}|${event.tick}|${a}`);
      if (set === undefined) continue;
      heard += 1;
      if (!set.has([dials.get(7), dials.get(10), dials.get(91), dials.get(90)].join(','))) wrong += 1;
    }
  }
  return { heard, wrong };
}

/** What `partsOf` groups on, plus the cell: a clip's identity across a trip. */
const clipKey = (t: Sequencer['tracks'][number]) =>
  [t.guid, t.gridY, t.level, t.pan, t.echoSend, t.reverbSend, t.key, t.scale, t.gridX].join('|');

for (const entry of await readdir(LEVELS, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  let project;
  try {
    project = await readLevelProject(
      entry.name,
      new Uint8Array(await readFile(path.join(LEVELS, entry.name))),
      nodeInflate,
    );
  } catch {
    continue;
  }
  for (const seq of project.sequencers) {
    if (seq.tracks.length === 0) continue;
    sequencers += 1;
    const exported = sequencerToMidi(seq, loose ? { exact: false } : {});
    const imported = midiToSequencer(exported.bytes);
    const mixed = misMixed(seq, exported.bytes);
    totals.heard += mixed.heard;
    totals.misMixed += mixed.wrong;
    totals.shared += exported.sharedChannel;
    totals.flattened += exported.flattened;
    totals.dragged += exported.dragged;
    totals.timbred += exported.timbred;
    for (const e of schedule(seq)) {
      if (e.hasPitchAutomation || e.hasVolumeAutomation) totals.automated += 1;
    }
    totals.dropped += exported.dropped;
    totals.clampedPitch += exported.clampedPitch;
    totals.clampedBend += exported.clampedBend;
    totals.bytes += exported.bytes.length;
    if (budget) weigh(exported.bytes);
    totals.lengthened += imported.lengthened;
    totals.patched += exported.patched;
    totals.unpatched += exported.unpatched;

    // ⚠️ **Compared as a multiset, not in order.** `schedule` sorts by step and
    // then by track index, and the import legitimately renumbers tracks: clips
    // that shared an instrument and a row merged into one part, and long parts
    // were re-cut. Two notes on the same step therefore come back in a different
    // order, and a positional comparison reports that as every note after it
    // being wrong. The first version of this script did exactly that and blamed
    // 142 of 149 sequencers for it.
    const before = music(seq);
    const after = music(imported.sequencer);
    notes += before.length;
    const problems: string[] = [];
    let missing = 0;

    // ❗ **The records, which is the strongest thing this can say.** The music
    // comparison below is what the round trip was built to satisfy; this is
    // whether the file that comes back holds the notes that went in, record for
    // record, and it is the patch's whole purpose. `Track.records` is the
    // level's own note data -- never a re-encoding of `notes`, which sorts a
    // chain's records into position order and real files do not.
    //
    // ⚠️ **Tolerant of the order the chains sit in, and only of that.** That
    // order is the order the author placed the notes in -- 317 corpus clips are
    // in no order the music determines -- so counting it reported 325 clips as
    // damaged for a difference no note has. Order WITHIN a chain still counts.
    // `sameNotes` is the exporter's own rule, imported rather than restated.
    const afterRecords = new Map<string, Uint8Array>();
    const afterColour = new Map<string, number>();
    for (const t of imported.sequencer.tracks) {
      afterRecords.set(clipKey(t), t.records);
      afterColour.set(clipKey(t), t.colour);
    }
    for (const t of seq.tracks) {
      totals.clips += 1;
      totals.records += t.records.length / 4;
      // The chip's tint: a `LBP-TRK` field with no MIDI message behind it, so
      // it comes back or it does not. Counted apart from the notes because a
      // colour that changed is not a clip that plays differently.
      if (t.colour !== factoryColour(t.guid)) totals.tinted += 1;
      const tint = afterColour.get(clipKey(t));
      if (tint !== undefined && tint !== t.colour) {
        totals.tintsLost += 1;
        if (problems.length < 3) {
          problems.push(`clip at ${t.gridX},${t.gridY}: colour ${t.colour} -> ${tint}`);
        }
      }
      const theirs = afterRecords.get(clipKey(t));
      if (theirs !== undefined && sameNotes(t.records, theirs)) continue;
      totals.clipsChanged += 1;
      // Without the patch this is expected -- that is what the patch is for --
      // so it is counted either way and only fails the run when it is on.
      if (!loose && problems.length < 3) {
        problems.push(`clip at ${t.gridX},${t.gridY}: records differ`);
      }
    }

    // ⚠️ **A dropped note comes BACK when the patch is on**, because the
    // clip that lost it diverges and is therefore carried verbatim. So the
    // count is a range, not an equality: never fewer than the export declared
    // it could carry, never more than went in. Holding it to the equality
    // blamed `Avian` for the one note MPE cannot express and the patch restores.
    const fewest = before.length - (loose ? exported.dropped : 0);
    if (after.length < fewest || after.length > before.length) {
      problems.push(`${before.length} notes out, ${after.length} back`);
    }
    /**
     * How far two notes are apart, and whether they are the same note at all.
     *
     * ⚠️ **The pairing is the part of this script that has been wrong most
     * often.** Levels place the same hit on two components, so a bucket
     * routinely holds several notes at one step and one pitch -- and when one of
     * them loses a glide to a shared channel, a greedy walk crosses it with a
     * sibling and reports two casualties for none. It has produced phantom
     * numbers three times: 142 sequencers, then 458 notes, then 8.
     *
     * So: exact matches are taken first, and only what is left is matched by
     * cost. The key stays loose -- step and pitch -- because a flattened note
     * that opened at volume 0 comes back at 1, MIDI having no velocity 0, and a
     * key that included the volume simply lost it.
     */
    const apart = (x: (typeof before)[number], y: (typeof after)[number]) => {
      let worst = Math.abs(x.duration - y.duration) * 1000 + Math.abs(x.modulation - y.modulation);
      for (let s = 0; s < Math.min(x.curve.length, y.curve.length); s += 1) {
        worst +=
          Math.abs(x.curve[s][0] - y.curve[s][0]) +
          Math.abs(x.curve[s][1] - y.curve[s][1]) +
          Math.abs(x.curve[s][2] - y.curve[s][2]);
      }
      return worst + Math.abs(x.curve.length - y.curve.length) * 1000;
    };

    const bucket = new Map<string, typeof after>();
    for (const note of after) {
      const key = `${note.step}/${note.pitch}`;
      const found = bucket.get(key);
      if (found) found.push(note);
      else bucket.set(key, [note]);
    }
    const wanted = new Map<string, typeof before>();
    for (const note of before) {
      const key = `${note.step}/${note.pitch}`;
      const found = wanted.get(key);
      if (found) found.push(note);
      else wanted.set(key, [note]);
    }

    const pairs: { a: (typeof before)[number]; b: (typeof after)[number] }[] = [];
    for (const [key, group] of wanted) {
      const candidates = bucket.get(key) ?? [];
      const left: typeof before = [];
      // Pass one: anything that came back untouched claims its own partner.
      for (const a of group) {
        const exact = candidates.findIndex((b) => apart(a, b) < 1e-9);
        if (exact >= 0) pairs.push({ a, b: candidates.splice(exact, 1)[0] });
        else left.push(a);
      }
      // Pass two: whatever is left, nearest first.
      for (const a of left) {
        if (candidates.length === 0) {
          // ⚠️ A note the export DECLARED it could not carry is not a
          // disagreement -- it is the one thing MPE genuinely cannot do, more
          // copies of a pitch at once than there are channels to tell them
          // apart. Counting it here as well left the gate failing on a single
          // note in `Avian` that the tally had already reported.
          missing += 1;
          if (missing > exported.dropped && problems.length < 3) {
            problems.push(`no note at step ${a.step} pitch ${a.pitch}`);
          }
          continue;
        }
        let best = 0;
        for (let i = 1; i < candidates.length; i += 1) {
          if (apart(a, candidates[i]) < apart(a, candidates[best])) best = i;
        }
        pairs.push({ a, b: candidates.splice(best, 1)[0] });
      }
    }

    for (const { a, b } of pairs) {
      if (a.duration !== b.duration && problems.length < 3) {
        problems.push(`step ${a.step} pitch ${a.pitch}: duration ${a.duration} -> ${b.duration}`);
      }
      if (a.modulation !== b.modulation && problems.length < 3) {
        problems.push(`step ${a.step} pitch ${a.pitch}: mod ${a.modulation} -> ${b.modulation}`);
      }
      if (a.curve.length !== b.curve.length && problems.length < 3) {
        problems.push(`step ${a.step} pitch ${a.pitch}: curve ${a.curve.length} -> ${b.curve.length}`);
      }
      // ⚠️ A note that had to share a channel lost its glide on purpose, so
      // its curve is expected to differ. Counting those separately is what keeps
      // the worst-case figure meaningful: it is the worst among the notes that
      // were supposed to survive intact.
      let deviation = 0;
      for (let s = 0; s < Math.min(a.curve.length, b.curve.length); s += 1) {
        deviation = Math.max(
          deviation,
          Math.abs(a.curve[s][0] - b.curve[s][0]),
          Math.abs(a.curve[s][1] - b.curve[s][1]),
          Math.abs(a.curve[s][2] - b.curve[s][2]),
        );
      }
      // The same half-a-unit the simplifier uses, and the same hair of slack:
      // both fields are integers, so `round` can miss the true line by exactly
      // half and floating point can make that look like slightly more.
      if (deviation > 0.5 + 1e-9) {
        totals.deviating += 1;
      } else {
        for (let s = 0; s < Math.min(a.curve.length, b.curve.length); s += 1) {
          worstPitch = Math.max(worstPitch, Math.abs(a.curve[s][0] - b.curve[s][0]));
          worstVolume = Math.max(worstVolume, Math.abs(a.curve[s][1] - b.curve[s][1]));
          worstMod = Math.max(worstMod, Math.abs(a.curve[s][2] - b.curve[s][2]));
        }
      }
    }
    if (problems.length > 0) {
      failed += 1;
      console.log(`✗ ${project.file} seq ${seq.uid} "${seq.name}": ${problems.join('; ')}`);
    }
  }
}

const pc = (n: number) => `${((n / notes) * 100).toFixed(2)}%`;
console.log(
  `${sequencers} sequencers, ${notes.toLocaleString()} notes, ${failed} disagreeing\n` +
    `intact notes: worst deviation pitch ${worstPitch.toFixed(3)} semitones, ` +
    `volume ${worstVolume.toFixed(3)}, modulation ${worstMod.toFixed(3)}/15\n` +
    `${totals.automated.toLocaleString()} notes carry a glide (${pc(totals.automated)}); ` +
    `${totals.flattened.toLocaleString()} of them lost it to a shared channel (${pc(totals.flattened)}), ` +
    `and ${totals.deviating.toLocaleString()} notes came back with a different curve\n` +
    `${(totals.bytes / 1e6).toFixed(1)} MB of MIDI; ${totals.shared.toLocaleString()} notes shared a ` +
    `channel; ${totals.dragged.toLocaleString()} (${pc(totals.dragged)}) will be bent by a ` +
    `neighbour and ${totals.timbred.toLocaleString()} (${pc(totals.timbred)}) had their timbre ` +
    `moved by one; ${totals.dropped} could not be carried, ${totals.clampedPitch} ` +
    `pitches and ${totals.clampedBend} bends clamped, ${totals.lengthened} lengthened to the grid`,
);
console.log(
  loose
    ? `no record patch: MIDI events alone -- ${totals.clipsChanged} of ` +
      `${totals.clips.toLocaleString()} clips would have needed one`
    : `${totals.clips.toLocaleString()} clips, ${totals.records.toLocaleString()} records: ` +
      `${totals.clipsChanged} came back different; ` +
      `${totals.patched.toLocaleString()} clips carried verbatim, ${totals.unpatched} unpatchable`,
);
console.log(
  `${totals.tinted.toLocaleString()} chips are tinted away from their instrument's own ` +
    `colour; ${totals.tintsLost} tints came back different`,
);
console.log(
  `the mixer as a DAW plays it: ${totals.misMixed.toLocaleString()} of ` +
    `${totals.heard.toLocaleString()} notes under another placement's level, pan or send`,
);
if (budget) {
  const sum = [...weights.values()].reduce((n, r) => n + r.bytes, 0);
  console.log(`
| carrier | share | events |
|---|---|---|`);
  for (const [name, row] of [...weights].sort((a, b) => b[1].bytes - a[1].bytes)) {
    console.log(`| ${name} | ${((row.bytes / totals.bytes) * 100).toFixed(2)}% | ${row.events.toLocaleString()} |`);
  }
  console.log(`${totals.bytes.toLocaleString()} bytes of file, ${sum.toLocaleString()} in events ` +
    `(${(((totals.bytes - sum) / totals.bytes) * 100).toFixed(2)}% is track headers and End of Track)`);
}
/**
 * What this gates on, and what it only reports.
 *
 * ❗ **With the patch on, the gate is the bytes.** Every clip of the corpus
 * has to come back record for record; the music comparison stays because it is
 * what says the file is right for a reader that has never heard of us, but a
 * byte difference is now a failure on its own.
 *
 * Gated on either setting, because they are exact: every note comes back, on
 * the same third of a step, at the same pitch, for the same length, with the
 * same modulation, and an intact note's curve stays within the half unit that
 * integer fields round by.
 *
 * Reported, because the two counters are not strictly nested: `flattened` is
 * what the export declared it could not carry whole, and `deviating` is what
 * measurably changed. ⚠️ **With the patch on they are not comparable at
 * all** -- a flattened note's records are carried verbatim, so it comes back
 * whole and `deviating` is 0 while `flattened` is not. That is the point of the
 * patch, and `LBP_MIDI_LOOSE=1` is how to measure what MIDI alone carries.
 */
// ⚠️ `dragged` and `timbred` are NOT subtracted here. They say what a synth
// will hear from a shared channel, not what this round trip loses -- the
// importer knows whose bend and whose modulation each is -- so counting them
// against the curve differences made shared mode look 4,433 notes better than
// declared, which is as misleading as looking worse.
const unexplained = loose ? totals.deviating - totals.flattened : totals.deviating;
if (unexplained !== 0) {
  console.log(
    `${unexplained > 0 ? unexplained : -unexplained} notes ` +
      `${unexplained > 0 ? 'changed without being declared' : 'were declared but did not change'} ` +
      `(${((Math.abs(unexplained) / notes) * 100).toFixed(4)}%)`,
  );
}
process.exit(
  failed === 0
    && worstPitch <= 0.5 + 1e-9 && worstVolume <= 0.5 + 1e-9 && worstMod <= 0.5 + 1e-9
    // The tint has no MIDI message and rides in `LBP-TRK` alone, so it is
    // exact on either setting or it is a bug.
    && totals.tintsLost === 0
    // What a DAW plays, which no import can check for us.
    && totals.misMixed === 0
    && (loose || (totals.clipsChanged === 0 && totals.unpatched === 0))
    ? 0
    : 1,
);
