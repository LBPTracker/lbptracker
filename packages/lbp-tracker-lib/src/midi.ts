/**
 * A sequencer to a MIDI file and back.
 *
 * `sequencerdump` already did the export half, and its author has ruled that
 * layer out as a reference; `../cwlib-ts/steering/lbp-modding-toolchain.md` lists the
 * divergences. This module is the version with those fixed, so it is worth
 * saying which is which:
 *
 * | # | There | Here |
 * |---|---|---|
 * | 1 | grid `floor(x / 52.5)` | never re-derived: `Track.gridX` already carries the game's own `floor(2x/105 - 0.5)` |
 * | 2 | `volume`/`timbre` read as signed bytes | unsigned, from `decodeRecord` |
 * | 3 | duration from the record chain, extra point pushed at `step+1` | `endPosition - startPosition + 1`, the measured reading |
 * | 4 | triplets `group*96 + pos*32`, overrunning the quarter | `step + subStep/3`, exact at 480 PPQ: a third of a step is 40 ticks |
 * | 5 | mixer ignored, tracks grouped by row + instrument | `NumChannels` and `Volume[0..5]` travel in the header meta |
 *
 * And the sixth, which is the reason this file is long: **a note is a chain of
 * control points, not a value.** 53.9% of the corpus's notes carry more than
 * one, and the engine glides linearly between them. A converter that writes the
 * first point and drops the rest loses every pitch bend and every fade in the
 * game. MPE is what lets them survive -- a channel per sounding note, so the
 * glide belongs to the note instead of to the whole part -- and it is why this
 * exports MPE by default.
 *
 * ⚠️ **What a round trip preserves is the music, not the bytes.** Export bakes
 * `Key` and `Scale` into the note numbers, because a MIDI file has to play in
 * something that has never heard of an LBP scale; import therefore produces a
 * chromatic sequencer in C whose record pitches are MIDI note numbers. The
 * scheduled stream matches; the record bytes do not. Clip boundaries move too:
 * a step field is seven bits, so an imported part is re-cut into 128-step clips
 * wherever they fall.
 */

import { factoryColour } from '@lbptracker/cwlib/chips.ts';
import { encodeRecord, readNotes, NOTE_RECORD_SIZE, type NoteRecord } from '@lbptracker/cwlib/notes.ts';
import {
  CHANNEL_COUNT,
  STEPS_PER_CELL,
  schedule,
  type ScheduledNote,
  type Sequencer,
  type Track,
} from '@lbptracker/cwlib/project.ts';
import { authorHandle } from '@lbptracker/cwlib/project.ts';
import { blockRoot, notePitch, unquantise } from './scale.ts';
import { swungFrame } from './swing.ts';
import {
  channelPressure,
  controlChange,
  meta,
  metaString,
  metaText,
  noteOff,
  noteOn,
  pitchBend,
  readMidi,
  sortEvents,
  tempoEvent,
  tempoFrom,
  timeSignature,
  writeMidi,
  type MidiEvent,
  type MidiTrack,
} from './smf.ts';

/** Sequencer steps in a quarter note: the grid is sixteenths. */
export const STEPS_PER_QUARTER = 4;

/**
 * Ticks per quarter note.
 *
 * ⚠️ **480 is not decoration: it is what makes triplets exact.** A step is
 * 120 ticks and a third of a step is 40, both whole numbers, so a note at
 * `step + 1/3` lands on a tick rather than between two. `sequencerdump`'s 96
 * PPQ could not do that -- its own triplet arithmetic overruns the quarter on
 * the fourth slot -- and the rounding is audible as a triplet passage that
 * sounds swung.
 */
export const DEFAULT_PPQ = 480;

/** MPE's own default: 48 semitones at full bend on a member channel. */
export const DEFAULT_BEND_RANGE = 48;

/** The text meta events that carry what MIDI has no room for. */
const SEQ_TAG = 'LBP-SEQ ';
const TRK_TAG = 'LBP-TRK ';

export interface MidiExportOptions {
  /**
   * A MIDI channel per sounding note, so bend and pressure are the note's own.
   * Off, every note of one part shares a channel and the glides have to be
   * dropped -- there is no third option, and that is MIDI, not a shortcoming.
   */
  readonly mpe?: boolean;
  /** Semitones at full bend. Wide by default: real glides reach +27. */
  readonly bendRange?: number;
  /**
   * Write the swung positions rather than the straight grid.
   *
   * Off by default, because the straight grid is what the sequencer holds and
   * what an import can give back; the swing rides along in the header meta. On
   * is for a DAW that has to sound like the game without knowing about it.
   */
  readonly bakeSwing?: boolean;
  readonly ppq?: number;
  /**
   * One MIDI track per board row and instrument, not per placement.
   *
   * ⚠️ **A placement's identity is eight fields and a track list shows two.**
   * The same kit on the same row at two different pans is two placements to the
   * game; merging puts both on one track and writes the mixer as CC automation
   * stepping wherever one's note starts after the other's (`mixerEvents`), which
   * is what a DAW does with a mixer that changes during a song. Measured over the
   * corpus: **a third fewer tracks.**
   *
   * ❗ **Placements whose notes overlap in time are NOT merged**, because one
   * track has one mixer state and there is no honest way to give two sounding
   * placements different pans on it. They fall back to separate tracks, told
   * apart by the `#2` the label already carries. Over the corpus that is 2 row
   * groups of 850 -- and it is what makes merging free rather than a trade.
   *
   * ⚠️ Overlapping does NOT mean two Things in one place: no two placements
   * of a row group ever share a cell (0 of 62,158). It means a clip started at
   * an earlier cell is still sounding when a later one begins, which a cell of
   * 16 steps and a clip of up to 128 makes easy.
   *
   * ❗ A fader move still comes back: the import reads each controller in force
   * at one of the placement's own notes.
   *
   * Two placements of DIFFERENT instruments on one row stay separate whatever
   * this says. There is one instrument per track and the label names it.
   */
  readonly mergeRows?: boolean;
  /**
   * A GUID to a readable instrument name, for the track names.
   *
   * ⚠️ **`PInstrument` has no name field worth printing.** `Track.name` comes
   * from the Thing and is empty on 93% of the corpus's placements -- and the
   * 7% that have one carry the editor's own default label, `Synth: Ray Gun`,
   * not the instrument's file name. Without this a DAW shows `guid 148321` and
   * nobody can tell it is the drum kit. The caller has the resolver -- the extracted `.rinst` manifest -- and
   * this module has no business fetching anything.
   */
  readonly instrumentName?: (guid: number) => string | undefined;
  /**
   * How often a glide is resampled, in steps; 0 writes only the control points.
   *
   * ⚠️ **A glide written as two events is not a glide.** The engine ramps
   * linearly between control points; MIDI pitch bend holds its value until the
   * next message, so two events an octave apart are a step, not a slide. The
   * resampling is what turns one into the other, and the import folds it back
   * up again -- collinear points are dropped, so a round trip returns the two
   * points it started with.
   *
   * ⚠️ **It is rounded to a multiple of a third of a step, and that is not
   * a detail.** A record's position is `step + subStep/3`, so a third is the
   * finest place an imported point can land. Resampling on quarters -- which
   * this did, and which is the obvious choice -- puts the sample taken at 0.25
   * onto the record at 1/3, where its value is simply wrong: a fade measured at
   * a quarter of the way in, filed as though it were a third of the way in. The
   * round trip came back at volume 4 where the file said 5.29, and the
   * off-grid points could not be simplified away either, so a two-point glide
   * returned as ten.
   */
  readonly glideStep?: number;
  /**
   * Verify the export by importing it, and carry whatever did not survive.
   *
   * ⚠️ **This is what makes the round trip byte-exact rather than merely
   * faithful.** Everything MIDI can say is said in MIDI; a handful of clips
   * still come back with their records cut differently -- a ramp re-simplified
   * onto the staircase its own rounding makes, a coincident record the engine
   * would replace in the same instant, a note that fits two overlapping clips.
   * None of it is audible, all of it is a different file. So the exporter runs
   * its own importer, compares the records clip by clip, and writes the
   * originals verbatim for the ones that differ.
   *
   * Measured over the corpus: **686 clips of 62,158 (1.10%)**, costing
   * **0.735%** of the file, and it is what takes 1,206 differing notes to 0.
   * The cost of leaving it on is that every export runs an import as well.
   *
   * On by default. `false` writes a plain MIDI file with the mixer and board
   * metas but no record patch -- which still round-trips the MUSIC exactly, and
   * is what to use if the file is going somewhere that will edit it, since a
   * patch describes records that the edited notes no longer match.
   */
  readonly exact?: boolean;
}

export interface MidiExportResult {
  readonly bytes: Uint8Array;
  readonly notes: number;
  /**
   * Parts written: an instrument, a row and a mixer each (`partKey`).
   *
   * ⚠️ **Not the MIDI tracks.** `mergeRows` puts several parts on one track and
   * `laneOf` spreads a busy one over several: `This Is Halloween` is 124 parts
   * on 46 tracks. This said "MIDI tracks written" until 2026-09-24, and a
   * reading that trusted it concluded `mergeRows` merged nothing. To count
   * tracks, count the `MTrk` chunks in `bytes`.
   */
  readonly parts: number;
  readonly events: number;
  /**
   * Notes that had to share a member channel because all 15 were busy.
   *
   * ⚠️ **Rare now, and never a glide.** A part over fifteen at once is split
   * across MIDI tracks, so running out takes a shape the polyphony count does
   * not see: one long note whose span crosses a run of glides that start later,
   * each of which the gliding pass has already parked on a channel of its own.
   * 30 notes of the corpus's 953,791, all of them flat, none of them dragged.
   */
  readonly sharedChannel: number;
  /**
   * Sharers that a neighbour's bend actually reaches.
   *
   * A subset of `sharedChannel`, and much the smaller number: most sharing is
   * free, because the channel is not being bent while the sharer sounds. These
   * are the ones a synth will pull out of tune -- this file's own importer
   * knows whose the bend is and is not fooled.
   */
  readonly dragged: number;
  /**
   * Notes whose timbre a sharer's CC 74 moved.
   *
   * A sharer keeps its own modulation -- losing it reads every `Params` range
   * from the wrong end -- at the cost of overwriting the modulation of whatever
   * is already on the channel. These are the notes that paid for that.
   */
  readonly timbred: number;
  /** Notes whose pitch left MIDI's 0..127 and was clamped to it. */
  readonly clampedPitch: number;
  /** Control points whose bend exceeded the range and was clamped. */
  readonly clampedBend: number;
  /** Notes whose glides could not be written, in plain (non-MPE) mode. */
  readonly droppedGlides: number;
  /**
   * Notes that had to share a channel AND carried a glide, so lost it.
   *
   * A subset of `sharedChannel`. Sharing costs a note its expression because
   * bend and pressure belong to the channel, not to the note -- see the note
   * in `sequencerToMidi` where it happens.
   */
  readonly flattened: number;
  /**
   * Clips whose records are carried verbatim because MIDI could not say them.
   *
   * Zero means the file's own note events reproduce every record exactly. See
   * `MidiExportOptions.exact`.
   */
  readonly patched: number;
  /**
   * Clips the reconstruction invented, which a patch cannot repair.
   *
   * A patch replaces a clip the author had; a clip that only the round trip
   * produces has no original to replace, and its notes would then exist twice.
   * The exporter refuses to patch a part in that state and says so here rather
   * than writing a file that imports to more notes than it holds.
   */
  readonly unpatched: number;
  /**
   * Notes MPE could not carry at all.
   *
   * ✅ **0 everywhere since lanes became unconditional.** What produced these
   * was more than fifteen copies of one pitch sounding at once, leaving no
   * channel where a note could be told apart from one already there; a part
   * that dense is now written across enough MIDI tracks to hold it, and the
   * corpus's one such note in `Avian` survives. It is kept, and no shape could
   * be constructed that reaches it -- but proving something unreachable is not
   * the same as it being unreachable, and dropping notes without saying so is
   * how a converter earns its reputation.
   */
  readonly dropped: number;
}

const clamp7 = (v: number) => (v < 0 ? 0 : v > 127 ? 127 : Math.round(v));

/**
 * Base64, ours, because a text meta has to be text.
 *
 * Not `btoa`: that is a DOM function with a Node deprecation notice on it, and
 * this module runs in both. Twenty lines is cheaper than a platform hook.
 */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? '=' : B64[c & 63];
  }
  return out;
}

function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let at = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n =
      (B64.indexOf(clean[i]) << 18) |
      (B64.indexOf(clean[i + 1]) << 12) |
      (B64.indexOf(clean[i + 2] ?? 'A') << 6) |
      B64.indexOf(clean[i + 3] ?? 'A');
    if (at < out.length) out[at++] = (n >> 16) & 0xff;
    if (at < out.length) out[at++] = (n >> 8) & 0xff;
    if (at < out.length) out[at++] = n & 0xff;
  }
  return out;
}

/**
 * A clip's records as the set of note chains it holds, order between them lost.
 *
 * ⚠️ **The order chains appear in is authoring order and nothing recovers
 * it.** 317 of the corpus's clips are not written in any order the music
 * determines -- `Ascetic` has a cell holding steps 64, 0, 96, 32 in that order
 * -- so a comparison that counts it reports 325 clips as damaged for a
 * difference no note has. Two clips holding the same chains are the same clip.
 *
 * ❗ **Order WITHIN a chain still counts**, which is why this splits on the end
 * flag and keeps each chain's bytes verbatim rather than going through
 * `groupNotes`: `makeNote` sorts a chain into position order, and a chain whose
 * records are stored out of it puts its end flag somewhere else. Records after
 * the last end flag are a run of their own and stay where they are.
 */
function chainsOf(records: Uint8Array): { chains: string[]; trailing: string } {
  const chains: string[] = [];
  let from = 0;
  for (let at = 0; at < records.length; at += NOTE_RECORD_SIZE) {
    if ((records[at + 1] & 0x80) === 0) continue;
    // ❗ **The records of a chain, sorted, with the end flag masked off.** Which
    // record carries the flag is not information: it delimits the chain, and
    // `makeNote` sorts the chain into position order anyway, so two chains
    // holding the same records decode to the same note whatever order the file
    // stored them in. `Wayward` writes one step 28 first and step 23 second,
    // with the flag on the second; re-encoding puts the flag on step 28. 45
    // clips of the corpus needed a verbatim patch for that alone.
    const own: string[] = [];
    for (let one = from; one <= at; one += NOTE_RECORD_SIZE) {
      own.push([
        records[one], records[one + 1] & 0x7f, records[one + 2], records[one + 3],
      ].join(','));
    }
    own.sort();
    chains.push(own.join('|'));
    from = at + NOTE_RECORD_SIZE;
  }
  chains.sort();
  return { chains, trailing: String(records.subarray(from)) };
}

/**
 * Whether two clips hold the same notes, however they are ordered.
 *
 * Exported so `packages/lbp-tracker-lib/dev/verify-midi.ts` gates on the same rule the exporter decides
 * a patch by; two definitions of "the same clip" would drift apart.
 */
export function sameNotes(a: Uint8Array, b: Uint8Array): boolean {
  const one = chainsOf(a);
  const two = chainsOf(b);
  return one.trailing === two.trailing
    && one.chains.length === two.chains.length
    && one.chains.every((chain, i) => chain === two.chains[i]);
}

/** What `partsOf` groups on, plus the cell: a clip's identity across a trip. */
const clipKey = (t: Track) =>
  [t.guid, t.gridY, t.level, t.pan, t.echoSend, t.reverbSend, t.key, t.scale, t.gridX].join('|');

/**
 * The note's modulation onto CC 74, and back.
 *
 * ⚠️ **It is a FOUR-bit field**, `(byte3 & 0x0f) / 15`, riding on a seven-bit
 * controller. The pair below is exact over all sixteen values -- `packages/lbp-tracker-lib/test/midi.test.ts`
 * checks every one -- which is what lets a round trip return the same nibble
 * rather than one a step away.
 */
const modTo7 = (mod: number) => clamp7(mod * 127);
const modFrom7 = (value: number) => value / 127;

/**
 * What has to happen first when several things land on one tick.
 *
 * ⚠️ **Notes are not written in time order any more.** Gliding notes are
 * allocated before flat ones, so a flat note ending at tick T is written after
 * a gliding note starting at T, and push order would put the note-on first. A
 * reader pairing by channel and pitch then ends the note that just began -- a
 * held note came back one step long, 728 of them across the corpus.
 *
 * The order is: what the track says, then everything that is finishing, then
 * the expression a starting note is about to need, then the notes themselves.
 * CC 74 rides with the note-on rather than with the other expression, because
 * it is read per note at the note-on and separating them lets a neighbour's
 * timbre be picked up instead.
 */
const rank = (event: MidiEvent): number => {
  const status = event.data[0];
  if (status === 0xff || status === 0xf0 || status === 0xf7) return 0;
  const kind = status & 0xf0;
  if (kind === 0x80) return 1;
  if (kind === 0xe0 || kind === 0xd0) return 2;
  return 3;
};

/* ------------------------------------------------------------------- export */

/**
 * The distinct voices in a sequencer: what a listener would call a part.
 *
 * A sequencer holds one placement per board cell, so `Ascetic` has 1150 of
 * them -- writing a MIDI track each would be unreadable in any DAW. Clips that
 * share an instrument, a row and every mixer setting are the same part played
 * at different times, and `stepOffset` is already absolute in the schedule, so
 * they merge. The 1150 become a handful.
 */
interface Part {
  readonly track: Track;
  readonly tracks: number[];
  /**
   * Each clip as `[gridX, steps]`, the cell it sits in and how far its own
   * notes reach.
   *
   * ⚠️ **The length is what makes the layout recoverable.** Clips of one part
   * overlap heavily -- a cell is 16 steps and a clip may hold 128 -- so on the
   * cells alone **86.50% of the corpus's notes fit more than one clip** and an
   * importer has to guess. With each clip's own extent as well that falls to
   * **0.09%**: 99.91% of notes fit exactly one. One number per clip.
   */
  readonly clips: (
    | [number, number]
    | [number, number, number]
    | [number, number, number, string]
  )[];
  /**
   * Byte 3's bit 6 at rest, which the engine reads only when bit 7 is set.
   *
   * ⚠️ **It is a real per-record bit that carries no sound, and dropping it
   * made 78% of the corpus's clips come back different.** A record's position
   * is `step + subStep/3` with `subStep = bit7 << bit30`, so bit 30 -- byte 3's
   * bit 6 -- means "the second third" only on a record whose bit 7 is set. On
   * every other record it is inert, and the editor still writes it: measured
   * over 1,448,224 corpus records, 971,954 of the 1,439,351 records at sub-step
   * 0 carry it and 467,397 do not.
   *
   * What decides it is the level, not the note. Eight of the ten level files
   * set it on every record, one (revision **0x3b8**, the oldest) on none, and
   * the two either side of the change -- 0x3e2 and 0x3e6 -- hold both, which is
   * what a level saved across an editor change looks like. So it is carried as
   * a default here, overridden per clip in the `clips` tuple's third slot for
   * the 31 clips of 62,106 that are not uniform.
   *
   * ❗ It applies to sub-step 0 only. A record at sub-step 1 must have the bit
   * CLEAR or it reads as sub-step 2, and one at sub-step 2 must have it set.
   */
  readonly rest: number;
}

/** Whether byte 3's bit 6 is set on a track's inert (sub-step 0) records. */
function restingBit(track: Track): number {
  let set = 0;
  let clear = 0;
  for (const note of track.notes) {
    for (const record of note.points) {
      if (record.subStep !== 0) continue;
      if ((record.timbre & 0x40) !== 0) set += 1;
      else clear += 1;
    }
  }
  return set >= clear && set > 0 ? 1 : 0;
}

/**
 * A clip whose inert records do not agree, as one bit per record.
 *
 * ❗ **31 of the corpus's 62,158 clips mix the two values**, and they used to be
 * the largest single family in the verbatim record patch -- a clip in the patch
 * is a clip whose bytes go stale the moment a DAW edits its notes, so carrying
 * an inert bit was costing the whole clip. 93 bytes of bitmap over the corpus
 * replaces all of it.
 *
 * ⚠️ **The hypothesis this replaced was wrong and is worth not repeating.**
 * Steering proposed a run length, on the reasoning that a level saved across the
 * editor change would hold its old notes first and its new ones after. Measured:
 * only **11** of the 31 are two runs; the rest scatter over as many as **11**,
 * and the longest sample reads `10110111111111111010101111`. There is no run
 * structure to exploit and there never was.
 *
 * One bit per record, in the clip's own record order, LSB first. A DAW that
 * edits the notes misaligns it -- and the bit is inert, so nothing is heard.
 */
function restingBits(track: Track, rest: number): string | undefined {
  const records = track.records;
  const count = Math.floor(records.length / NOTE_RECORD_SIZE);
  const bits = new Uint8Array(Math.ceil(count / 8));
  let mixed = false;
  for (let i = 0; i < count; i += 1) {
    const at = i * NOTE_RECORD_SIZE;
    // A record at sub-step 1 or 2 spends this bit on the sub-step; only the
    // ones at rest carry a free one, and only those can disagree.
    if ((records[at] & 0x80) !== 0) continue;
    const bit = (records[at + 3] & 0x40) !== 0 ? 1 : 0;
    if (bit !== rest) mixed = true;
    if (bit) bits[i >> 3] |= 1 << (i & 7);
  }
  return mixed ? toBase64(bits) : undefined;
}

/** One clip's entry: its cell, its extent, its resting bit and, if mixed, a bitmap. */
function clipEntry(
  track: Track,
  steps: number,
): [number, number, number] | [number, number, number, string] {
  const rest = restingBit(track);
  const bits = restingBits(track, rest);
  return bits === undefined
    ? [track.gridX, steps, rest]
    : [track.gridX, steps, rest, bits];
}

/**
 * Which part a placement belongs to: its instrument, its row and every mixer
 * setting. Exported so `als.ts` groups exactly as this does -- two definitions
 * of a part would put the same song on different tracks in the two exports.
 */
export function partKey(track: Track): string {
  return [
    track.guid, track.gridY, track.level, track.pan,
    track.echoSend, track.reverbSend, track.key, track.scale,
  ].join('|');
}

/**
 * A part's name in a DAW: **`row 4 - saw_wave`**. See `nameOf` in
 * `sequencerToMidi` for why it is the instrument and never `Track.name`.
 */
export function partLabel(
  track: Track,
  instrumentName?: (guid: number) => string | undefined,
): string {
  return `row ${track.gridY} - ${instrumentName?.(track.guid) || `guid ${track.guid}`}`;
}

/**
 * Which parts share one DAW track: indices into `parts`, one array per track,
 * in board order.
 *
 * Without `mergeRows` a group is one part. With it, a group is a board row and
 * an instrument -- see `MidiExportOptions.mergeRows` -- except that parts
 * sounding at the same time never share: one track has one mixer state.
 * Exported so `als.ts` merges exactly as this does.
 *
 * `parts` must already be in board order (row, then first cell, then GUID):
 * the merge is greedy in that order.
 */
export function rowGroups(
  sequencer: Sequencer,
  parts: readonly { readonly track: Track; readonly tracks: readonly number[] }[],
  mergeRows: boolean,
): number[][] {
  const cellOf = (part: { tracks: readonly number[] }) =>
    Math.min(...part.tracks.map((index) => sequencer.tracks[index].gridX));
  /** When each placement is sounding, as coalesced step intervals. */
  const spansOf = parts.map((part) => {
    const spans: [number, number][] = [];
    for (const index of part.tracks) {
      const clip = sequencer.tracks[index];
      for (const note of clip.notes) {
        spans.push([
          clip.stepOffset + note.startPosition,
          clip.stepOffset + note.endPosition + 1,
        ]);
      }
    }
    spans.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const span of spans) {
      const last = merged[merged.length - 1];
      if (last !== undefined && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
      else merged.push([...span]);
    }
    return merged;
  });
  /** Whether two placements are ever sounding at the same time. */
  const clash = (a: [number, number][], b: [number, number][]) => {
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i][0] < b[j][1] && b[j][0] < a[i][1]) return true;
      if (a[i][1] <= b[j][1]) i += 1;
      else j += 1;
    }
    return false;
  };

  const groups: number[][] = [];
  const byRow = new Map<string, number[]>();
  parts.forEach((part, index) => {
    const key = mergeRows ? `${part.track.gridY}|${part.track.guid}` : `#${index}`;
    const found = byRow.get(key);
    if (found) found.push(index);
    else byRow.set(key, [index]);
  });
  for (const row of byRow.values()) {
    // ❗ Greedy, in the order the parts already sit in, which is board order:
    // a placement joins the first track whose placements it never overlaps.
    const made: number[][] = [];
    const spans: [number, number][][] = [];
    for (const index of row) {
      let at = made.findIndex((_, k) => !clash(spans[k], spansOf[index]));
      if (at < 0) {
        at = made.length;
        made.push([]);
        spans.push([]);
      }
      made[at].push(index);
      spans[at] = [...spans[at], ...spansOf[index]].sort((a, b) => a[0] - b[0]);
    }
    groups.push(...made);
  }
  // Board order again, since the row map lost it.
  return groups.sort((a, b) => {
    const x = parts[a[0]].track;
    const y = parts[b[0]].track;
    return x.gridY - y.gridY || cellOf(parts[a[0]]) - cellOf(parts[b[0]]) || x.guid - y.guid;
  });
}

function partsOf(sequencer: Sequencer): Part[] {
  const byKey = new Map<string, Part>();
  sequencer.tracks.forEach((track, index) => {
    const key = partKey(track);
    // How far the clip's own notes reach, which is its window.
    const steps = Math.min(
      128,
      Math.max(1, track.notes.reduce((most, note) => Math.max(most, note.endStep + 1), 0)),
    );
    const found = byKey.get(key);
    if (found) {
      found.tracks.push(index);
      found.clips.push(clipEntry(track, steps));
    } else {
      byKey.set(key, {
        track, tracks: [index], clips: [clipEntry(track, steps)], rest: 0,
      });
    }
  });
  // The part's own default is whichever its clips mostly use, and a clip only
  // spells the bit out when it disagrees.
  return [...byKey.values()].map((part) => {
    let set = 0;
    for (const clip of part.clips) if (clip[2] === 1) set += 1;
    const rest = set * 2 >= part.clips.length ? 1 : 0;
    return {
      ...part,
      rest,
      clips: part.clips.map((clip) =>
        // ⚠️ A clip with a bitmap keeps its own bit as well: the bitmap is
        // indexed by record and the bit is the fallback for the records the
        // bitmap does not decide, so dropping either is not the same file.
        clip.length === 3 && clip[2] === rest ? ([clip[0], clip[1]] as [number, number]) : clip),
    };
  });
}

/**
 * Member channels for one MPE lower zone: master on 1, notes on 2..16.
 *
 * Zero-based here, so the master is 0 and the members are 1..15.
 */
const MEMBERS = Array.from({ length: 15 }, (_, i) => i + 1);
/** Channel 1, zero-based. It carries the zone's settings and, at a pinch, notes. */
const MASTER = 0;

/**
 * Which member channel each note gets.
 *
 * ⚠️ **Two notes of the same pitch must never share a channel**, whatever else
 * has to give: their note-offs are indistinguishable, so the second would end
 * the first and leave the second hanging. Everything below is arranged around
 * that one invariant -- a free channel when there is one, the emptiest safe
 * channel when there is not, and a refusal when even that is impossible.
 */
interface Span {
  readonly note: number;
  readonly from: number;
  readonly until: number;
  /** The note's modulation, to see whose timbre a newcomer's CC 74 moves. */
  readonly mod: number;
  /** Set once this note's timbre has been moved by somebody else's CC 74. */
  disturbed: boolean;
  gliding: boolean;
  /** Give up this span's glide, because something had to be placed in front. */
  demote(): void;
}

class VoicePool {
  /** Every span ever placed, per member channel. Append-only; see `rewind`. */
  private readonly placed: Span[][];
  /** The ones that can still overlap what is being asked about now. */
  private live: Span[][];
  /** The same two lists for the master channel, which is the overflow. */
  private readonly placedMaster: Span[] = [];
  private liveMaster: Span[] = [];
  private readonly freedAt: number[];
  shared = 0;
  refused = 0;
  /** Glides given up so that a note could be placed in front of them. */
  demoted = 0;
  /** Sharers that will hear somebody else's bend; see `take`. */
  dragged = 0;
  /**
   * Notes whose timbre a newcomer's CC 74 moves.
   *
   * ⚠️ **The other direction from `dragged`.** A sharer writes no bend and no
   * pressure but it does write its modulation, because losing that reads every
   * `Params` range from the wrong end. The price is that the note already on
   * the channel has its own modulation overwritten -- unless the two agree,
   * which they usually do, 80.74% of records being 0.
   */
  timbred = 0;

  constructor() {
    this.placed = MEMBERS.map(() => []);
    this.live = MEMBERS.map(() => []);
    this.freedAt = MEMBERS.map(() => 0);
  }

  /**
   * Start the clock again at zero without forgetting anything.
   *
   * \u26a0\ufe0f **The second pass goes back to the beginning of the song**, and the
   * live lists are pruned as the tick advances -- so without this they would be
   * empty of everything the first pass placed early, and flat notes would be
   * handed channels that gliding notes were already sounding on. Two notes of
   * one pitch then landed on one channel, whose note-offs are indistinguishable,
   * and the corpus check went from 0 sequencers disagreeing to 111.
   */
  rewind(): void {
    this.live = this.placed.map((spans) => [...spans]);
    this.liveMaster = [...this.placedMaster];
  }

  /**
   * `gliding` says whether this note will write bend and pressure of its own,
   * which is what makes exclusivity worth spending a channel on.
   */
  /**
   * Count a note whose timbre somebody else's CC 74 moved -- once, not once per
   * neighbour. A busy channel would otherwise report 434,674 casualties among
   * its 27,210 sharers, which is a count of disturbances and not of notes.
   */
  private disturb(span: Span): void {
    if (span.disturbed) return;
    span.disturbed = true;
    this.timbred += 1;
  }

  take(
    tick: number,
    note: number,
    until: number,
    gliding: boolean,
    mod: number,
    placement: { exclusive: boolean },
  ): { channel: number; exclusive: boolean } {
    // Pruning is by `until <= tick` only -- correct because the tick only moves
    // forward within a pass. What is left may still start after this note ends,
    // so the overlap test needs both ends.
    const clashes = (span: Span) => span.from < until;
    let free = -1;
    for (let i = 0; i < MEMBERS.length; i += 1) {
      this.live[i] = this.live[i].filter((b) => b.until > tick);
      // Least recently freed first, so channels rotate: a receiver's release
      // tail on the channel it just let go is the one thing round-robin buys.
      if (!this.live[i].some(clashes) && (free < 0 || this.freedAt[i] < this.freedAt[free])) {
        free = i;
      }
    }
    let best = free;
    let exclusive = true;
    if (best < 0) {
      /*
       * Nothing free, so something has to give. What follows tries the ways of
       * sharing in order of what they cost.
       *
       * ⚠️ **A sharer writes no expression of its own**, because bend and
       * pressure belong to the channel and setting them would drag whatever is
       * already sounding there. So a reader can only tell whose the channel's
       * bend is by asking who arrived first -- and that answer is only useful if
       * the note with the glide is always the earlier one. When a flat note was
       * allowed to start in front of a glide, the glide lost its whole tail: in
       * `Rain` a 32-step fade stopped at volume 30 instead of reaching 0,
       * because the newcomer had claimed the channel and the rest of the ramp
       * went to it.
       *
       *   QUIET     a channel nobody is bending at all
       *   MASTER    channel 1, which MPE lets carry notes and where nothing is
       *             ever bent, so a note parked there is never dragged
       *   BEHIND    one whose glides all began before this note. Our own
       *             importer knows whose the bend is (see `owners`), but a
       *             synth does not: this note WILL be dragged by it, which is
       *             what `dragged` counts and why the master comes first.
       *   DISPLACE  a channel where a glide has to be given up for this note
       *
       * The last one is a real loss and is counted. Refusing instead of
       * displacing cost 426 notes across the corpus, and a lost note is worse
       * than a lost glide.
       */
      const inFront = (i: number) =>
        this.live[i].filter(clashes).filter((b) => b.gliding && b.from > tick);

      for (const how of ['quiet', 'master', 'behind', 'displace'] as const) {
        if (how === 'master') {
          this.liveMaster = this.liveMaster.filter((b) => b.until > tick);
          if (this.liveMaster.some((b) => b.note === note && b.from < until)) continue;
          const span: Span = {
            note, from: tick, until, mod, disturbed: false, gliding: false, demote: () => {},
          };
          for (const other of this.liveMaster) if (other.mod !== mod) this.disturb(other);
          this.liveMaster.push(span);
          this.placedMaster.push(span);
          this.shared += 1;
          return { channel: MASTER, exclusive: false };
        }
        for (let i = 0; i < MEMBERS.length; i += 1) {
          const here = this.live[i].filter(clashes);
          // Never two of one pitch on a channel: their note-offs are the same
          // three bytes, so the second would end the first.
          if (here.some((b) => b.note === note)) continue;
          if (how === 'quiet' && here.some((b) => b.gliding)) continue;
          if (how !== 'displace' && inFront(i).length > 0) continue;
          if (best < 0) {
            best = i;
          } else if (
            how === 'displace'
              ? inFront(i).length < inFront(best).length
              : here.length < this.live[best].filter(clashes).length
          ) {
            best = i;
          }
        }
        if (best >= 0) {
          // Whatever this displaces stops being a glide: its owner is rewritten
          // flat, which is why allocation happens before anything is written.
          for (const span of inFront(best)) span.demote();
          break;
        }
      }
      if (best < 0) {
        // ⚠️ **Last resort: the master channel.** Fifteen member channels all
        // holding this pitch already leaves nowhere to put it that a note-off
        // could tell apart -- and MPE allows notes on the master channel, which
        // is exactly what it is for. They get no per-note expression there,
        // which costs nothing: a note that reaches this point had none to give.
        // Four notes in the corpus's 953,791 land here, all in one unison-heavy
        // passage of `Avian`, and before this they were dropped outright.
        this.liveMaster = this.liveMaster.filter((b) => b.until > tick);
        if (this.liveMaster.some((b) => b.note === note && b.from < until)) {
          this.refused += 1;
          return { channel: -1, exclusive: false };
        }
        const onMaster: Span = {
          note, from: tick, until, mod, disturbed: false, gliding: false, demote: () => {},
        };
        for (const other of this.liveMaster) if (other.mod !== mod) this.disturb(other);
        this.liveMaster.push(onMaster);
        this.placedMaster.push(onMaster);
        this.shared += 1;
        return { channel: MASTER, exclusive: false };
      }
      this.shared += 1;
      exclusive = false;
      // ⚠️ **Sharing a channel is usually free, and the raw count says
      // otherwise.** On `Ascetic` 124 notes share and only 18 of them ever have
      // a bend land on their channel; the rest sit on one that stays centred for
      // their whole life and lose nothing at all. This is the number worth
      // showing anyone.
      if (this.live[best].filter(clashes).some((b) => b.gliding)) this.dragged += 1;
      // And whoever is already here and disagrees about the modulation has its
      // own timbre moved by this note's CC 74 -- the other direction.
      for (const other of this.live[best].filter(clashes)) {
        if (other.mod !== mod) this.disturb(other);
      }
    }
    const span: Span = {
      note, from: tick, until, mod, disturbed: false, gliding: gliding && exclusive,
      demote: () => {
        if (!span.gliding) return;
        span.gliding = false;
        this.demoted += 1;
        placement.exclusive = false;
      },
    };
    this.live[best].push(span);
    this.placed[best].push(span);
    this.freedAt[best] = Math.max(this.freedAt[best], until);
    return { channel: MEMBERS[best], exclusive };
  }
}

/**
 * A range wide enough for the music, and no wider.
 *
 * ⚠️ **MPE's default of 48 semitones is not enough for this corpus.** 582 of
 * its 1,448,224 control points glide further than that -- the widest is 62 --
 * and a clamped bend is a note that arrives at the wrong pitch. Nothing reaches
 * 96, which is MIDI's own ceiling for the range, so widening only when the
 * music asks costs the ordinary file nothing: 48 stays 48, and the resolution
 * that comes with it stays too.
 */
function widestBend(sequencer: Sequencer): number {
  let widest = 0;
  for (const event of schedule(sequencer)) {
    if (!event.hasPitchAutomation) continue;
    const track = sequencer.tracks[event.track];
    const root = blockRoot(track.key);
    const base = notePitch(event.pitch, track.scale, root);
    for (const point of event.points) {
      widest = Math.max(widest, Math.abs(notePitch(point.pitch, track.scale, root) - base));
    }
  }
  return Math.max(DEFAULT_BEND_RANGE, Math.ceil(widest));
}

export function sequencerToMidi(
  sequencer: Sequencer,
  options: MidiExportOptions = {},
): MidiExportResult {
  const mpe = options.mpe ?? true;
  const bendRange = Math.max(
    1,
    Math.min(96, Math.round(options.bendRange ?? widestBend(sequencer))),
  );
  const ppq = options.ppq ?? DEFAULT_PPQ;
  const bakeSwing = options.bakeSwing ?? false;
  // Thirds of a step, always: see `glideStep`.
  const glideThirds = Math.max(1, Math.round((options.glideStep ?? 1 / 3) * 3));
  const ticksPerStep = ppq / STEPS_PER_QUARTER;

  const at = (position: number) =>
    Math.round(bakeSwing ? swungFrame(position, ticksPerStep, sequencer.swing) : position * ticksPerStep);

  /**
   * A part's MIDI track name: **`row 4 - saw_wave`**.
   *
   * ❗ **The label is the part's identity, not decoration**, and it is the only
   * way a DAW can move a part to another row or another instrument. A program
   * change cannot carry the second of those -- seven bits against a six-digit
   * GUID -- and there is no MIDI message at all for the first, so the name is
   * where they go. `midiToSequencer` reads both back, and an `instrumentGuid`
   * resolver turns the name into a GUID again.
   *
   * ⚠️ **The instrument, never the placement's own name.** `Track.name` is
   * the Thing's label, empty on 93% of the corpus's placements and one of the
   * editor's 23 default strings on the rest; putting it here would hide the
   * instrument behind `Synth: Ray Gun` and leave a rename with nothing to mean.
   * It rides in the meta, where nothing else claims it.
   */
  const instrumentOf = (track: Track) =>
    options.instrumentName?.(track.guid) || `guid ${track.guid}`;
  const nameOf = (track: Track) => partLabel(track, options.instrumentName);
  /**
   * The parts in board order, so a DAW's track list reads like the board.
   *
   * ❗ **`gridY` is the Thing's own y, negated**: `boardToGrid` computes
   * `floor(-y / 105)`, so row 0 is the top of the board and the number grows
   * downward. Ascending is therefore top to bottom, which is how the sequencer
   * draws it and how a listener describes it.
   *
   * ⚠️ **The level's own order is not board order.** Placements come out of
   * the Thing graph in whatever order the level stored them: of the corpus's
   * 149 sequencers, exactly **one** already has its tracks in ascending row
   * order. The rows run 0..24 and are never negative.
   *
   * The cell breaks a tie so two parts on one row read left to right, and the
   * GUID breaks what is left so the order is total and the file is
   * reproducible.
   */
  const cellOf = (part: Part) => Math.min(...part.clips.map((clip) => clip[0]));
  const parts = partsOf(sequencer).sort((a, b) =>
    a.track.gridY - b.track.gridY
    || cellOf(a) - cellOf(b)
    || a.track.guid - b.track.guid);
  /**
   * The parts that share one MIDI track, and which track each part is on.
   *
   * Without `mergeRows` a group is one part and everything below behaves as it
   * did. With it, a group is a board row and an instrument -- see the option.
   */
  const mergeRows = options.mergeRows ?? true;
  const groups = rowGroups(sequencer, parts, mergeRows);
  const groupOf: number[] = [];
  groups.forEach((group, index) => {
    for (const part of group) groupOf[part] = index;
  });

  /**
   * Which of the TRACKS sharing a label this one is: `... #2`, `... #3`.
   *
   * ⚠️ **A label names two of a placement's eight fields, and half the corpus
   * needs more.** `row 0 - baiyon_drums_1` twice in `Ascetic` is the same kit on
   * the same row at pan 0.60 with no reverb and at pan 0.30 with 0.20 of it --
   * different placements to the game, indistinguishable in a track list.
   * Measured: **2,539 of 4,911 part tracks (51.7%) share a label**, separated by
   * level (466 groups), pan (444), the reverb send (391), the echo send (195)
   * and the key (10).
   *
   * The index says nothing about WHAT differs, deliberately: the mixer is on
   * CC 7, 10, 91 and 90 now, so a DAW already shows each track's fader and pan.
   * The label only has to be something you can point at.
   */
  const dupOf = new Map<number, number>();
  {
    const seen = new Map<string, number>();
    groups.forEach((group, index) => {
      const label = nameOf(parts[group[0]].track);
      const n = (seen.get(label) ?? 0) + 1;
      seen.set(label, n);
      if (n > 1) dupOf.set(index, n);
    });
  }

  const partOfTrack = new Map<number, number>();
  parts.forEach((part, index) => {
    for (const track of part.tracks) partOfTrack.set(track, index);
  });

  /**
   * One channel pool per lane, and a lane never meets another.
   *
   * ⚠️ **A file's tracks do NOT get a channel space each** -- the header can
   * declare 65,535 of them and the channel still lives in the status byte, so
   * two tracks writing `0x93` address the same channel 4. What makes this safe
   * is the reader: a DAW that imports a format 1 file as separate project
   * tracks gives each one its own instrument, and that instrument only ever
   * sees its own track's events. Reaper does this, and so does everything else
   * that lands one project track per MIDI track.
   *
   * ❗ **So the file is written for that reader and for no other.** Played as a
   * single stream -- a hardware module, a plain player -- parts collide on the
   * same channels and two notes of one pitch have indistinguishable note-offs.
   * `splitSequencerToMidi` is the option for a destination that cannot promise
   * separate tracks: one file per group of parts, packed by polyphony.
   *
   * The counters are summed over the pools, so nothing downstream has to know
   * how many there are.
   */
  const pools = new Map<number, VoicePool>();
  const poolFor = (lane: number) => {
    const found = pools.get(lane);
    if (found) return found;
    const made = new VoicePool();
    pools.set(lane, made);
    return made;
  };
  const tally = (pick: (p: VoicePool) => number) =>
    [...pools.values()].reduce((sum, p) => sum + pick(p), 0);
  /**
   * Events that must sort AFTER the note-on at their own tick.
   *
   * ❗ **`rank` cannot tell them apart, because it only sees the bytes.** A
   * coincident pair's jumped-to pressure has to land after the note-on so the
   * import reads it as a control point rather than as the opening volume -- and
   * pressure ranks 2 against a note-on's 3, so pushing it later was not enough:
   * it sorted in front anyway. CC 74 escaped this only because it happens to
   * share rank 3 with the note-on.
   */
  const late = new Set<MidiEvent>();
  const ranked = (event: MidiEvent) => (late.has(event) ? 4 : rank(event));
  let clampedPitch = 0;
  let clampedBend = 0;
  let droppedGlides = 0;
  let flattened = 0;
  let notes = 0;

  // Plain mode spends channels on instruments instead of on notes. Channel 10
  // is skipped: nothing here is General MIDI, but every DAW will treat it as
  // percussion, and a part that silently becomes a drum kit is a bad surprise.
  const plainChannels = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15];

  // ⚠️ The test is on the SEMITONES, not on the 14-bit value. A glide of
  // exactly `bendRange` maps to 16384, one past the top of the range, and
  // saturating there costs 1/8192 of the range -- 0.008 semitones at 62, which
  // is nothing. Counting it as a clamped bend reported 120 casualties in a
  // corpus that has none.
  const bendValue = (semitones: number) => {
    if (Math.abs(semitones) > bendRange + 1e-9) clampedBend += 1;
    return 8192 + (semitones / bendRange) * 8192;
  };

  /**
   * Which notes need a channel to themselves.
   *
   * ⚠️ **The order these are allocated in is the whole of the shared-channel
   * problem.** A zone has fifteen member channels and this engine has
   * thirty-two voices, so a dense passage runs out -- but only 9.3% of notes
   * carry a glide, and measured across the corpus only **1,172 notes arrive
   * while more than fifteen glides are already sounding**. Allocating in plain
   * time order let a flat note take the last channel a moment before a gliding
   * one needed it, and 3,593 notes lost a glide where at most 1,172 had to.
   * Two passes, the gliding notes first, is the fix.
   *
   * A note that opens at volume zero counts too: MIDI has no note-on velocity
   * of 0, so its opening level has to travel as pressure, which only an
   * exclusive channel may write.
   */
  const needsChannel = (event: ScheduledNote) =>
    event.hasPitchAutomation ||
    event.hasVolumeAutomation ||
    // ⚠️ **The modulation counts too, and leaving it out was a silent loss.**
    // It rides on CC 74, which belongs to the channel exactly as bend and
    // pressure do, so a note that ramps it needs a channel of its own for the
    // same reason. Without this, a note whose pitch and volume are flat but
    // whose modulation moves was allocated as flat -- and if it then had to
    // share, it lost the ramp with nothing counting it. That is where shared
    // mode's undeclared notes came from, once the corpus check started looking
    // at the modulation at all.
    event.points.some((point) => point.modulation !== event.points[0].modulation) ||
    clamp7(event.volume) === 0;

  const all = schedule(sequencer);

  /**
   * Which MIDI track each note is written to.
   *
   * ⚠️ **A part is not always one track.** Fifteen member channels is the
   * ceiling on how many notes of a part can sound at once and keep their own
   * bend, and a part can pass it on its own -- the corpus's busiest single part
   * reaches 26. Splitting such a part across two tracks gives it thirty, and a
   * DAW that lands one project track per MIDI track plays them on two instances
   * of the same instrument, which is the same sound. Without this, 825 notes
   * lost a glide with nowhere else they could have gone.
   *
   * The split is by NOTE, not by clip: a single clip can be polyphonic enough on
   * its own. Greedy in time order into the first lane with room, which is
   * optimal for intervals.
   */
  const laneOf = new Map<ScheduledNote, number>();
  // Per GROUP, because a group is what becomes a MIDI track and a track is what
  // gets its own fifteen channels.
  const laneCount = groups.map(() => 1);
  {
    const byGroup: ScheduledNote[][] = groups.map(() => []);
    for (const event of all) {
      const part = partOfTrack.get(event.track);
      if (part !== undefined) byGroup[groupOf[part]].push(event);
    }
    byGroup.forEach((own, index) => {
      const sounding: number[][] = [];
      for (const event of own) {
        const from = at(event.step);
        const until = Math.max(from + 1, at(event.step + event.durationSteps));
        let lane = 0;
        while (lane < sounding.length) {
          sounding[lane] = sounding[lane].filter((end) => end > from);
          if (sounding[lane].length < MEMBERS.length) break;
          lane += 1;
        }
        if (lane === sounding.length) sounding.push([]);
        sounding[lane].push(until);
        laneOf.set(event, lane);
      }
      laneCount[index] = Math.max(1, sounding.length);
    });
  }
  /** Where each group's lanes begin in `bodies`. */
  const laneBase: number[] = [];
  let bodyCount = 0;
  for (const count of laneCount) {
    laneBase.push(bodyCount);
    bodyCount += count;
  }
  const bodies: MidiEvent[][] = Array.from({ length: bodyCount }, () => []);
  const bodyOf = (event: ScheduledNote): number | undefined => {
    const part = partOfTrack.get(event.track);
    return part === undefined ? undefined : laneBase[groupOf[part]] + (laneOf.get(event) ?? 0);
  };

  const gliding = all.filter(needsChannel);
  const flat = all.filter((e) => !needsChannel(e));
  const order = [...gliding, ...flat];

  /**
   * Who gets a channel, decided before anything is written.
   *
   * ⚠️ **Allocating and writing have to be separate steps.** Placing a note
   * can take the exclusivity away from one already placed -- see `demote` -- and
   * a loop that wrote as it went would already have written that note's glide.
   */
  const placements = new Map<ScheduledNote, { channel: number; exclusive: boolean; base: number }>();
  if (mpe) {
    for (const event of order) {
      if (event === flat[0]) for (const p of pools.values()) p.rewind();
      const body = bodyOf(event);
      if (body === undefined) continue;
      const track = sequencer.tracks[event.track];
      const value = notePitch(event.pitch, track.scale, blockRoot(track.key));
      if (value < 0 || value > 127) clampedPitch += 1;
      const base = clamp7(value);
      const startTick = at(event.step);
      const endTick = Math.max(startTick + 1, at(event.step + event.durationSteps));
      const place = { channel: -1, exclusive: true, base };
      const taken = poolFor(body).take(
        startTick, base, endTick, needsChannel(event), event.modulation, place,
      );
      place.channel = taken.channel;
      place.exclusive = place.exclusive && taken.exclusive;
      placements.set(event, place);
    }
  }

  for (const event of order) {
    const partIndex = bodyOf(event);
    if (partIndex === undefined) continue;
    const track = sequencer.tracks[event.track];
    const root = blockRoot(track.key);
    // ❗ The pitch clamp is counted during allocation, not here: this runs over
    // the same notes a second time and would double every casualty.
    const toMidi = (raw: number) => clamp7(notePitch(raw, track.scale, root));

    const place = placements.get(event);
    const base = place ? place.base : toMidi(event.pitch);
    const startTick = at(event.step);
    const endTick = Math.max(startTick + 1, at(event.step + event.durationSteps));
    const out = bodies[partIndex];

    if (!mpe) {
      const channel = plainChannels[partIndex % plainChannels.length];
      out.push(noteOn(startTick, channel, base, Math.max(1, clamp7(event.volume))));
      out.push(noteOff(endTick, channel, base));
      if (event.hasPitchAutomation || event.hasVolumeAutomation) droppedGlides += 1;
      notes += 1;
      continue;
    }

    if (place === undefined || place.channel < 0) continue;
    const { channel, exclusive } = place;

    // ⚠️ **Points that share a position collapse, and the LAST one wins.**
    // The engine's interpolator is `t = span > 0 ? (elapsed - from) / span : 1`,
    // so a zero-length segment is taken at its far end the instant it arrives --
    // two records on the same step are authoring debris and the later value is
    // the one that sounds. Written naively they became a glide of zero length
    // whose every sample fell on the note's own start tick and was skipped, so
    // the second value was simply dropped: a note written 17 then 16 came back
    // as 17.
    const raw = event.points.map((p) => ({
      step: p.step,
      semitones: toMidi(p.pitch) - base,
      volume: p.volume,
      // ⚠️ **Per point, because the engine ramps it.** `sub_0x3930` writes a
      // slide rate for the modulation beside the ones for volume and pitch and
      // `sub_0x1c60` advances it every chunk, so a note that moves it changes
      // its filter, level, LFOs and drive as it sounds. Carrying only the
      // opening value lost that on 34,449 corpus notes -- every one of them.
      modulation: p.modulation,
    }));
    const points: typeof raw = [];
    for (const point of raw) {
      const last = points[points.length - 1];
      // ⚠️ **Only at the note's own start.** A coincident pair anywhere else
      // is a value that JUMPS at that instant, and the zero-length segment
      // below writes exactly that -- but a pair at position 0 would write both
      // of its samples onto the note-on's own tick, where they are skipped, so
      // that one collapses and the import rebuilds it from the opening bend.
      //
      // Collapsing everywhere erased the segment *leading into* the pair: a
      // note in `Diode` that dives from 68 to 37 over two steps and snaps back
      // came out flat at 68, because dropping the (6, 37) record left the ramp
      // before it with nowhere to go. It was the last two notes in the corpus
      // whose curve the round trip could not explain.
      if (last !== undefined && last.step === point.step && point.step === 0) {
        points[points.length - 1] = point;
      } else {
        points.push(point);
      }
    }
    const opening = points[0];

    // MPE's own ordering: the note's opening expression, then the note-on. A
    // receiver that saw the note first would sound one frame of it unbent.
    //
    // ❗ **A coincident pair states BOTH modulations, in order, the way it
    // already states both pitches.** The first record's value is not decoration
    // that the collapse can drop: `voice+0x28` is set from the note word that
    // triggers the voice, and the stack loop at `fmodextinput.prx` `0x1ae7`
    // reads `Params[0..2]` -- the per-layer detune, spread and random start --
    // through it ONCE, before any ramp runs. The zero-length segment then jumps
    // to the second value for everything that is read per chunk. So the engine
    // hears both, and so does the file: CC 74 before the note-on carries the
    // value the voice starts at, CC 74 immediately after it carries the value it
    // jumps to. That is ordinary MIDI, in the order a synth would want it.
    //
    // ⚠️ This used to send only the collapsed value, on the reasoning that
    // "the file must not disagree with itself: pitch and volume from one record,
    // modulation from another". The reasoning was right and the conclusion was
    // backwards -- the cure for disagreeing is to say both, which is what the
    // opening bend had been doing for the pitch all along.
    out.push(controlChange(startTick, channel, 74, modTo7(raw[0].modulation)));
    if (exclusive) {
      out.push(pitchBend(startTick, channel, bendValue(opening.semitones)));
      out.push(channelPressure(startTick, channel, clamp7(raw[0].volume)));
    }
    out.push(noteOn(startTick, channel, base, Math.max(1, clamp7(raw[0].volume))));
    // ❗ AFTER the note-on, so the import reads these as the note's own first
    // control point rather than as its opening value. Both are rank 3, so the
    // order they are pushed in is the order they are written in.
    //
    // ❗ **A coincident pair states both VOLUMES too**, the way it already
    // states both pitches and both modulations. `Jarred` writes a note as
    // 48 at volume 27 and 75 at volume 96 on one step; the first is replaced in
    // the same instant, so nothing hears it -- but it is in the file, and 23
    // clips needed a verbatim patch for want of one channel-pressure message.
    // Unlike the modulation this is an encoding difference and not a fidelity
    // one: the opening modulation is read ONCE for `Params[0..2]` before any
    // ramp runs, and the opening volume is not read for anything.
    if (exclusive && clamp7(opening.volume) !== clamp7(raw[0].volume)) {
      const jump = channelPressure(startTick, channel, clamp7(opening.volume));
      late.add(jump);
      out.push(jump);
    }
    if (opening.modulation !== raw[0].modulation) {
      out.push(controlChange(startTick, channel, 74, modTo7(opening.modulation)));
    }

    // ❗ **A sharer still writes its CC 74**, unlike its bend and its pressure,
    // and that is a deliberate asymmetry. Losing a note's modulation outright
    // means every `Params` range reads from the wrong end -- a wrong cutoff, a
    // wrong resonance, wrong envelope times, all at once -- where the cost of
    // writing it is that a neighbour's timbre moves for as long as this note
    // lasts. 80.74% of records carry modulation 0, so in most sharing the value
    // written is the value already there and nothing moves at all.
    //
    // ⚠️ **A note sharing a channel writes no bend and no pressure at all.**
    // Both are per channel, so a newcomer that reset them to its own values
    // would drag whatever is already sounding there with it -- and the note
    // already there is, by construction, the one that got the channel to itself
    // and was written with its full glide. This was not hypothetical: in
    // `Twitch` a flat note at step 1062 came back four semitones sharp, having
    // inherited the tail of somebody else's slide. Its own expression is lost
    // instead, which is the smaller lie and is counted as `flattened`.
    if (!exclusive) {
      // ⚠️ **A silent opening counts too, not just a glide.** A shared note's
      // volume has to ride on its note-on velocity, and MIDI has no velocity 0 --
      // that byte is a note-off. So a note written at volume 0 comes back at 1,
      // and it is only ever 0 in the first place as the foot of a fade-in, which
      // is a shape worth being honest about losing.
      if (needsChannel(event)) flattened += 1;
      out.push(noteOff(endTick, channel, base));
      notes += 1;
      continue;
    }

    /**
     * The last value actually sent for each field, so a REPEAT can mean
     * something.
     *
     * ❗ **The resampler never sends a value twice, and that is what lets a
     * repeated one mark a control point.** A rounded ramp is a staircase, so
     * resampling naturally produces runs of equal values; suppressing them
     * costs a receiver nothing (sending 57 twice is a no-op) and buys the one
     * signal MIDI otherwise has no room for: an author's control point where
     * nothing moves. 526 of the corpus's lost control points sit on a flat run
     * -- against 6 on a moving ramp -- so this is nearly all of them.
     */
    let sentBend = bendValue(opening.semitones);
    let sentPress = clamp7(opening.volume);
    let sentMod = modTo7(opening.modulation);

    for (let i = 0; i + 1 < points.length; i += 1) {
      const from = points[i];
      const to = points[i + 1];
      const moves =
        from.semitones !== to.semitones ||
        from.volume !== to.volume ||
        from.modulation !== to.modulation;
      if (!moves) {
        // ❗ **A control point where nothing moves is still a control point**,
        // and one strictly inside a flat run is the only kind that gets lost.
        // The value holds either way, so this event changes nothing a receiver
        // hears -- it is a repeat, and by the rule above only a control point
        // can produce one. Without it the record vanished: a note written as
        // four identical records came back as two.
        //
        // ⚠️ **Only strictly inside**, which is the difference between 8,600
        // markers and 281,000. A point where a flat run meets a moving one is a
        // corner and the importer's simplifier keeps it anyway; marking every
        // stationary point cost half a megabyte over the corpus to save forty
        // kilobytes of patch, a trade twelve times the wrong way round.
        // The point is `to`, and its neighbours are `from` and the one after it.
        // Three equal values in a row means the middle one is redundant for
        // interpolation and the importer would simplify it away.
        const after = points[i + 2];
        const same = (a: typeof to, b: typeof to) =>
          a.semitones === b.semitones && a.volume === b.volume && a.modulation === b.modulation;
        if (after !== undefined && same(to, after)) {
          const tick = at(event.step + to.step);
          if (tick > startTick && tick < endTick) {
            out.push(channelPressure(tick, channel, sentPress));
          }
        }
        continue;
      }
      const span = to.step - from.step;
      // Spans are whole thirds, because both ends are `step + subStep/3`.
      const thirds = Math.round(span * 3);
      const steps = thirds > 0 ? Math.max(1, Math.round(thirds / glideThirds)) : 1;
      // ⚠️ **From k = 0, not k = 1: a moving segment has to state where it
      // starts.** A segment where nothing moves writes no events at all, which
      // is right -- the value simply holds -- but it means the next segment's
      // opening value has never been sent. A note that sat at volume 96 for two
      // steps and then faded to nothing came back fading from the very first
      // frame, because the import saw 96 at the note-on and 0 at the end and had
      // no reason to believe there was a plateau between them.
      for (let k = 0; k <= steps; k += 1) {
        const t = k / steps;
        const position = from.step + span * t;
        const tick = at(event.step + position);
        if (tick <= startTick || tick >= endTick) continue;
        const semitones = from.semitones + (to.semitones - from.semitones) * t;
        const volume = from.volume + (to.volume - from.volume) * t;
        const modulation = from.modulation + (to.modulation - from.modulation) * t;
        // ⚠️ **`k === 0` is exempt from the de-duplication, because it is a
        // deliberate repeat.** A moving segment has to state where it starts,
        // and where it starts is usually where the plateau before it ended --
        // the same value. Suppressing it took the patch from 352 clips to
        // 1,077: a note that sat at 96 for two steps and then faded came back
        // fading from its very first frame, which is the trap the loop's own
        // comment above already warned about.
        //
        // ❗ **And `k === steps` for the same reason at the other end.** The
        // resampled values are rounded, so a ramp reaches its final value one
        // or two thirds BEFORE the control point the author wrote; suppressing
        // the last sample as a repeat then leaves the segment's end unstated
        // and the importer folds the ramp back onto the last change instead.
        // `17:57 -> 31:46` came back as `30+2/3:46` for exactly that. Worth 20
        // clips of question 24's patch, and the symmetry is the argument: a
        // moving segment states both of its ends or neither.
        const edge = k === 0 || k === steps;
        if (from.semitones !== to.semitones) {
          const value = bendValue(semitones);
          if (edge || value !== sentBend) out.push(pitchBend(tick, channel, value));
          sentBend = value;
        }
        if (from.volume !== to.volume) {
          const value = clamp7(volume);
          if (edge || value !== sentPress) out.push(channelPressure(tick, channel, value));
          sentPress = value;
        }
        if (from.modulation !== to.modulation) {
          const value = modTo7(modulation);
          if (edge || value !== sentMod) out.push(controlChange(tick, channel, 74, value));
          sentMod = value;
        }
      }
    }
    out.push(noteOff(endTick, channel, base));
    // ⚠️ **A glide is undone when it ends.** Nothing else resets a member
    // channel, so the next note to land there would inherit the bend this one
    // finished on -- and a note that shares the channel while this one is still
    // sounding is being dragged by it until this fires. An exclusive note sets
    // its own bend on the way in, so this only matters for the ones that cannot.
    if (points.length > 1 && points[points.length - 1].semitones !== 0) {
      out.push(pitchBend(endTick, channel, bendValue(0)));
    }
    notes += 1;
  }

  /* --------------------------------------------------------- the conductor */
  const head: MidiEvent[] = [
    // ❗ **The real name, empty or not.** This is where the sequencer's name
    // lives now, so substituting a friendly default for a blank one would
    // rename 10 of the corpus's 149 sequencers on the way back. A DAW showing an
    // unnamed conductor track is the level being honest about itself.
    metaText(0, 0x03, sequencer.name),
    tempoEvent(0, sequencer.tempo),
    timeSignature(0, 4, 2),
    // ⚠️ **Only what MIDI has no message for.** The name is the track name
    // meta, the tempo is the tempo event, the bend range is RPN 0, and whether
    // this is an MPE file is the MCM -- all four used to be duplicated here, and
    // a duplicated field is a field that can disagree with itself. `tempo` did:
    // a file re-tempoed in a DAW imported at the level's old tempo, because the
    // meta won. `stepsPerQuarter` was written and never read.
    metaText(0, 0x01, SEQ_TAG + JSON.stringify({
      v: 2,
      uid: sequencer.uid,
      swing: sequencer.swing,
      swingBaked: bakeSwing,
      echoFeedback: sequencer.echoFeedback,
      echoTime: sequencer.echoTime,
      echoMix: sequencer.echoMix,
      reverb: sequencer.reverb,
      loop: sequencer.loop,
      startPoint: sequencer.startPoint,
      numChannels: sequencer.numChannels,
      // ❗ MIDI has no board, and the board's height is what bands a track to a
      // channel -- see `channelVolume`. Without it a re-imported file routes
      // every track by the fallback modulo instead, which is a different mix.
      boardRows: sequencer.boardRows,
      volumes: sequencer.volumes,
      // ❗ **The author has no MIDI message.** FF 02 is a *copyright notice*,
      // and writing a PSN handle there would state something about rights on
      // somebody's behalf that the game's file never said. Omitted when the
      // sequencer names nobody, which 61 of the corpus's 210 do.
      ...(sequencer.author ? { author: sequencer.author } : {}),
    })),
  ];
  if (mpe) {
    // The MPE Configuration Message -- RPN 6 on the master channel -- then the
    // bend range. RPN 0 goes on the first member channel, which is where a
    // zone's own range is set, and on the master for its own smaller one.
    head.push(
      controlChange(0, 0, 101, 0), controlChange(0, 0, 100, 6), controlChange(0, 0, 6, 15),
      controlChange(0, 1, 101, 0), controlChange(0, 1, 100, 0), controlChange(0, 1, 6, bendRange),
      controlChange(0, 0, 101, 0), controlChange(0, 0, 100, 0), controlChange(0, 0, 6, 2),
    );
  }

  /**
   * The file, with an optional verbatim record patch per part.
   *
   * Built as a function because the patch can only be computed by importing
   * what this produces, so the file is assembled twice: once to find out what
   * MIDI could not say, and once to say it. Nothing but the `LBP-TRK` metas
   * differs between the two, so the second import reconstructs exactly what the
   * first one did and the patch it carries still describes the right clips.
   */
  /**
   * Each track's mixer, as controller events: a step wherever a part's note
   * starts after another part's, carrying the dials that differ.
   *
   * ❗ **At every note of a part, that part's own dials are in force.** That is
   * the invariant, it is what a DAW plays, and it is what the import reads back
   * (`readPart`, at one of the part's own notes). It is not "once per part":
   * parts sharing a track interleave -- A at cell 0, B at cell 2, A again at
   * cell 4 -- and until 2026-09-24 each part's values were written once, at its
   * first cell, so a DAW played A's cell 4 on B's mixer. Measured then:
   * 65,345 of the 381,082 notes on merged tracks, in 102 of the 150 corpus
   * sequencers. Our own import read the right value at the first cell and never
   * noticed.
   *
   * The step sits on the note-on's own tick and sorts before it: the mixer goes
   * into the event list ahead of the notes, and a controller and a note-on
   * share a rank.
   */
  const mixerEvents: MidiEvent[][] = groups.map(() => []);
  {
    const starts: { tick: number; part: number }[][] = groups.map(() => []);
    for (const event of all) {
      const part = partOfTrack.get(event.track);
      if (part !== undefined) starts[groupOf[part]].push({ tick: at(event.step), part });
    }
    groups.forEach((members, gi) => {
      const list = starts[gi].sort((a, b) => a.tick - b.tick);
      // A track with no note at all still says its mixer, where its first clip is.
      if (list.length === 0) {
        list.push({ tick: at(cellOf(parts[members[0]]) * STEPS_PER_CELL), part: members[0] });
      }
      const held = new Map<number, number>();
      let current = -1;
      for (const { tick, part } of list) {
        if (part === current) continue;
        current = part;
        const t = parts[part].track;
        const dials: [number, number][] = [
          [7, clamp7(t.level * 127)],
          [10, clamp7(t.pan * 127)],
          [91, clamp7(t.reverbSend * 127)],
          [90, clamp7(t.echoSend * 127)],
        ];
        for (const [cc, value] of dials) {
          // A repeat says nothing a DAW can use and nothing the import needs.
          if (held.get(cc) === value) continue;
          held.set(cc, value);
          mixerEvents[gi].push(controlChange(tick, MASTER, cc, value));
        }
      }
    });
  }

  const assemble = (patch?: Map<number, Record<string, string>>): MidiTrack[] => {
    const tracks: MidiTrack[] = [{ events: sortEvents(head, rank) }];
    groups.forEach((members, gi) => {
      const lead = parts[members[0]].track;
      for (let lane = 0; lane < laneCount[gi]; lane += 1) {
        // A lane is a continuation of the track, and says so in both places: the
        // name so a DAW's track list reads, and the meta so the import merges.
        // `row 0 - kit #2 (1)`: the duplicate index, then the lane. Both come
        // off again exactly, because the meta says what each of them is.
        const dup = dupOf.get(gi);
        const named = dup === undefined ? nameOf(lead) : nameOf(lead) + ' #' + dup;
        const label = laneCount[gi] > 1 ? named + ' (' + (lane + 1) + ')' : named;
        const header: MidiEvent[] = [metaText(0, 0x03, label)];

        /**
         * The mixer: `mixerEvents`, the same on every lane of the track.
         *
         * ❗ **The mixer on the controllers MIDI has for it.** Level, pan and
         * both sends are CC 7, 10, 91 and 90 -- so a DAW plays the level's own
         * mix instead of every part flat and centred, and a fader move survives
         * the trip back. On a merged track they become automation, which is what
         * a DAW does with a mixer that changes during a song.
         *
         * ⚠️ **CC 90 is UNDEFINED in the specification, and that is why it
         * was chosen.** A delay send has no controller of its own anywhere in
         * MIDI: 91 is reverb, 92 tremolo, 93 chorus, 94 celeste/detune, 95
         * phaser. 94 was tried first because some synths read it as a delay
         * depth -- but many more read it as detune, and a value landing on the
         * wrong one of those is audibly wrong rather than merely ignored. 90
         * sits in the undefined block (85-90), so nothing can mistake it for
         * something else: a reader that does not know it ignores it, and one
         * that does gets the send. Inert everywhere beats right sometimes and
         * wrong the rest. A judgement, made deliberately -- not a measurement.
         *
         * The meta keeps the exact value beside them, and the rule when they
         * disagree is the tempo's: seven bits cannot hold the editor's steps
         * (pan is exact at 7 bits on 8.9% of the corpus's placements), so the
         * meta wins while the controller still AGREES to within its own
         * resolution, and the controller wins the moment it does not.
         *
         * ⚠️ On the master channel, which is where MPE puts a control that
         * belongs to the whole zone. And `level` alone, not level times the
         * channel volume: folding the mixer stage in would make it
         * un-invertible, and 308 of the corpus's 338 sequencers have one channel
         * at a uniform 0.75, which is a constant and not a balance.
         */
        const mixer = mixerEvents[gi];

        // ❗ **One meta per placement on the track.** A merged track holds
        // several, each with its own cells and its own mixer, and the import
        // hands a note to whichever declared the cell it falls in.
        for (const index of members) {
          const part = parts[index];
          const t = part.track;
          // ❗ On the FIRST lane only. Lanes merge into whichever part the
          // import meets first, so a copy on each is bytes nobody reads.
          const fix = lane === 0 ? patch?.get(index) : undefined;
          const odd: Record<string, string> = {};
          // The chip tints of a part's clips, where one disagrees with the
          // part's own -- the same shape as `names`, and for the same reason:
          // a part is a group of placements that share a mixer, and neither
          // the tint nor the label is in that key.
          const tints: Record<string, number> = {};
          for (const at2 of part.tracks) {
            const clip = sequencer.tracks[at2];
            if (clip.name !== t.name) odd[String(clip.gridX)] = clip.name;
            if (clip.colour !== t.colour) tints[String(clip.gridX)] = clip.colour;
          }
          header.push(metaText(0, 0x01, TRK_TAG + JSON.stringify({
            // ⚠️ **No `name`.** It is the track name meta, and carrying a
            // second copy here meant the copy won: renaming a part in a DAW came
            // back as the name the level had. Everything else that has a
            // controller keeps its exact value here as well, because seven bits
            // cannot hold the editor's steps -- see the CCs above.
            guid: t.guid, gridY: t.gridY,
            // ❗ **The instrument's name as well as its GUID**, so the meta is a
            // complete carrier and the import never *depends* on the track name.
            // A mangled or missing label leaves everything standing; the label
            // is read only to see whether it says something DIFFERENT from
            // this, which is what tells an edit from a round trip. Without the
            // name here, any resolver hit overrode the GUID -- so a manifest
            // that mapped the same name to a different GUID silently changed
            // the instrument on a file nobody had touched.
            instrument: instrumentOf(t),
            // ⚠️ **The Thing's own label, which is NOT always empty.** This
            // used to say "empty on every placement of all 22 corpus levels" and
            // that was simply wrong: 4,353 of the 62,158 (7.0%) carry one,
            // though only 23 distinct strings -- the editor's own defaults,
            // `Synth: Ray Gun` and the like. The track name does not carry it.
            ...(t.name ? { name: t.name } : {}),
            // ❗ And per clip where a part's clips disagree, which 7 parts of
            // 4,909 do. Without this their 84 clips came back unnamed.
            ...(Object.keys(odd).length > 0 ? { names: odd } : {}),
            // ❗ **The chip's tint, which MIDI has no message for.** It is
            // `PInstrument.Colour`, packed RGBA, and the game draws it; a
            // controller would be seven bits of a colour and a synth would act
            // on it. Written for every part, because the alternative -- writing
            // it only where it differs from `factoryColour` -- makes the file
            // depend on our own table to be read back, and 4,911 numbers are
            // 0.3% of the corpus's export.
            colour: t.colour,
            ...(Object.keys(tints).length > 0 ? { colours: tints } : {}),
            level: t.level, pan: t.pan, echoSend: t.echoSend, reverbSend: t.reverbSend,
            key: t.key, scale: t.scale, clips: part.clips,
            // Written only when it is not the game's current default, which is
            // what a file from a DAW should become. See `Part.rest`.
            ...(part.rest === 1 ? {} : { rest: part.rest }),
            ...(laneCount[gi] > 1 ? { lane } : {}),
            ...(dupOf.has(gi) ? { dup: dupOf.get(gi) } : {}),
            ...(fix ? { fix } : {}),
          })));
        }
        tracks.push({
          events: [...header, ...sortEvents([...mixer, ...bodies[laneBase[gi] + lane]], ranked)],
        });
      }
    });
    return tracks;
  };

  let tracks = assemble();
  let bytes = writeMidi({ format: 1, division: ppq, tracks });
  let patched = 0;
  let unpatched = 0;
  if (options.exact !== false) {
    const diff = divergences(sequencer, parts, midiToSequencer(bytes).sequencer);
    patched = diff.patched;
    unpatched = diff.unpatched;
    if (patched > 0) {
      tracks = assemble(diff.patch);
      bytes = writeMidi({ format: 1, division: ppq, tracks });
    }
  }
  return {
    bytes,
    notes,
    parts: parts.length,
    patched,
    unpatched,
    events: tracks.reduce((sum, t) => sum + t.events.length, 0),
    sharedChannel: tally((p) => p.shared),
    dragged: tally((p) => p.dragged),
    timbred: tally((p) => p.timbred),
    flattened,
    clampedPitch,
    clampedBend,
    droppedGlides,
    dropped: tally((p) => p.refused),
  };
}

/**
 * Which clips a round trip does not return byte for byte.
 *
 * ⚠️ **Compared as records, not as music.** The music already matches --
 * that is what `packages/lbp-tracker-lib/dev/verify-midi.ts` measures -- and what is left is how the
 * same curve is cut into records. Three things do it, all of them harmless and
 * all of them a different file: a rounded ramp re-simplified onto the staircase
 * the rounding actually makes (tighter to the curve than the original, which is
 * why it cannot simply be loosened away), a coincident record the engine
 * replaces in the same instant, and a note that fits two overlapping clips.
 *
 * ❗ **A part that gained a clip is refused rather than patched.** A patch
 * replaces a clip the author had; if the reconstruction invented one, its notes
 * have nowhere to be removed from and patching the rest would import them
 * twice. That is counted and reported, never papered over.
 */
function divergences(
  sequencer: Sequencer,
  parts: readonly Part[],
  back: Sequencer,
): { patch: Map<number, Record<string, string>>; patched: number; unpatched: number } {
  const after = new Map<string, Uint8Array>();
  for (const track of back.tracks) after.set(clipKey(track), track.records);

  const patch = new Map<number, Record<string, string>>();
  let patched = 0;
  let unpatched = 0;
  parts.forEach((part, index) => {
    const fix: Record<string, string> = {};
    let count = 0;
    let invented = 0;
    for (const at of part.tracks) {
      const track = sequencer.tracks[at];
      const mine = track.records;
      const theirs = after.get(clipKey(track));
      if (theirs === undefined) {
        // The cell list is written from these very tracks, so a clip with no
        // counterpart means the import merged or moved one -- not patchable.
        invented += 1;
        continue;
      }
      after.delete(clipKey(track));
      // ❗ The same notes in a different order are the same clip. See `chainsOf`.
      if (sameNotes(mine, theirs)) continue;
      fix[String(track.gridX)] = toBase64(mine);
      count += 1;
    }
    if (invented > 0) {
      unpatched += count + invented;
      return;
    }
    if (count > 0) {
      patch.set(index, fix);
      patched += count;
    }
  });
  // Anything left in `after` is a clip the round trip produced and the level
  // does not have; the part it belongs to cannot be patched safely.
  for (const [key] of after) {
    const owner = parts.findIndex((part) =>
      part.tracks.some((at) => clipKey(sequencer.tracks[at]).split('|').slice(0, 8).join('|')
        === key.split('|').slice(0, 8).join('|')));
    if (owner >= 0 && patch.delete(owner)) {
      unpatched += 1;
      patched -= 1;
    }
  }
  return { patch, patched, unpatched };
}

/* ------------------------------------------------------------------- import */

export interface MidiImportResult {
  readonly sequencer: Sequencer;
  /** True when the file carried this project's own meta events. */
  readonly ours: boolean;
  readonly notes: number;
  /** Notes shorter than the sixteenth grid, lengthened to one step. */
  readonly lengthened: number;
  /** Notes dropped because their part ran past a clip and could not be cut. */
  readonly dropped: number;
  /** Note-ons with no matching note-off, ended at the last event instead. */
  readonly unmatched: number;
  readonly clips: number;
}

interface RawNote {
  readonly channel: number;
  readonly note: number;
  readonly velocity: number;
  /**
   * The pressure and bend sent AT the note-on's own tick, if any.
   *
   * ⚠️ **This is how a note that opens at volume zero survives.** MIDI has no
   * note-on velocity of 0 -- that byte means note-off -- so the opening volume
   * of a fade-in cannot ride on the velocity and travels as the pressure MPE
   * puts immediately before the note. Reading it back off the velocity instead
   * returned volume 1, and the one-unit error then moved the reference line
   * under every resampled point of the glide: a two-point fade came back as
   * eighteen, and a re-export would have grown it again. `Northern Lights`
   * opens 96 of its notes at zero.
   */
  readonly opening?: number;
  readonly openingBend?: number;
  readonly startTick: number;
  endTick: number;
  readonly modulation: number;
  /** Bend, pressure and CC 74 while it sounded, absolute ticks. */
  readonly bends: { tick: number; semitones: number }[];
  readonly presses: { tick: number; volume: number }[];
  readonly mods: { tick: number; value: number }[];
}

/** A part being assembled, before it is cut into clips. */
interface RawPart {
  name: string;
  guid: number;
  gridY: number;
  level: number;
  pan: number;
  echoSend: number;
  reverbSend: number;
  key: number;
  scale: number;
  /**
   * The chip's tint, when the file says it.
   *
   * ⚠️ **Undefined is not a colour**: a file that is not ours carries no tint
   * at all, and the chip then takes the instrument's own factory value --
   * which needs the GUID, and the GUID is only known once the meta and the
   * track name have both been read. So it is resolved where the clip is built.
   */
  colour?: number;
  /** Byte 3's inert bit 6 for this part's records; see `Part.rest`. */
  rest: number;
  /** Clips whose own `Track.name` differs from the part's, by `gridX`. */
  names: Map<number, string>;
  /** Clips whose tint differs from the part's, by `gridX`. */
  colours: Map<number, number>;
  /**
   * Clips whose records the file carries verbatim, by `gridX`.
   *
   * ⚠️ **A patched clip ignores the notes reconstructed for it.** The
   * exporter only writes one after checking that every clip of the part is
   * accounted for, so a note that landed in the wrong clip is corrected on both
   * sides at once -- see `divergences`. It is written by
   * `MidiExportOptions.exact` and is the difference between a round trip that
   * plays the same and one that IS the same.
   */
  fix: Map<number, Uint8Array>;
  /**
   * The clips this part had, `[gridX, steps, rest]`, when the file remembers
   * them. `rest` is byte 3's inert bit 6 -- see `Part.rest`.
   */
  cells: [number, number, number, string?][];
  notes: RawNote[];
}

/**
 * Neutral placement settings for a file that is not ours.
 *
 * ✔ **Measured, 2026-09-10**: every one of the game's 68 `instrument_*.plan`
 * popit items places a `PInstrument` holding exactly these -- unity level,
 * centred, no sends -- so they are what a chip the game has just made carries
 * rather than a guess (`tools/InstrumentColours.java`). This used to say the
 * opposite, and the numbers happened to be right.
 *
 * ⚠️ The tint is not here: it belongs to the instrument, not to the placement,
 * and `factoryColour` is where an unstated one comes from.
 */
const NEUTRAL = { level: 1, pan: 0.5, echoSend: 0, reverbSend: 0 };

/**
 * Key 12 and scale 0: `notePitch(p, 0, blockRoot(12)) === p`.
 *
 * That identity is the whole of the pitch import. `blockRoot(12)` is 12 and the
 * chromatic scale passes notes through, so a record's pitch field IS the MIDI
 * note number and nothing has to be inverted. Anything else would need
 * `quantise` run backwards, which has no inverse -- several notes snap to one.
 */
const CHROMATIC_C = { key: 12, scale: 0 };

export interface MidiImportOptions {
  /** What to call a sequencer whose file does not name one. */
  readonly fallbackName?: string;
  /**
   * A track label's instrument name back to a GUID.
   *
   * ❗ **This is what makes changing the instrument in a DAW possible.** A
   * program change is seven bits and a GUID is six digits, so the instrument
   * travels in the track name -- `row 4 - saw_wave` -- and only the caller
   * knows what `saw_wave` is. It is the same map that named it on the way out,
   * read backwards; without one the meta's GUID simply stands and a rename
   * changes nothing, which is the old behaviour.
   */
  readonly instrumentGuid?: (name: string) => number | undefined;
}

export function midiToSequencer(
  bytes: Uint8Array,
  options: string | MidiImportOptions = {},
): MidiImportResult {
  // A bare string is the old second argument; it named the sequencer.
  const opts: MidiImportOptions = typeof options === 'string' ? { fallbackName: options } : options;
  const fallbackName = opts.fallbackName ?? 'imported';
  const file = readMidi(bytes);
  const ticksPerStep = file.division / STEPS_PER_QUARTER;

  /**
   * The tempo, from the tempo event, snapped back to a whole BPM where one fits.
   *
   * ⚠️ **The header used to carry a copy of this and win, which silently
   * threw a DAW's tempo change away** -- measured: exported at 120, re-tempoed
   * to 174, imported at 120. MIDI has a first-class message for the tempo, so
   * the meta has no business holding a second opinion.
   *
   * ❗ The message stores MICROSECONDS PER QUARTER, so 174 BPM comes back as
   * 173.99979 and a plain read would drift the field on every trip. The snap is
   * not a guess: it asks whether some whole BPM encodes to exactly the
   * microseconds in the file, and takes that one if so. All 149 corpus tempos
   * are whole (70..240), and a genuinely fractional tempo keeps the fraction.
   */
  const wholeBpm = (bpm: number): number => {
    const usec = Math.round(60_000_000 / bpm);
    const near = Math.round(bpm);
    return near > 0 && Math.round(60_000_000 / near) === usec ? near : bpm;
  };

  let tempo = 120;
  /** The conductor track's own name meta: the sequencer's name. */
  let title: string | undefined;
  let header: Record<string, unknown> | undefined;
  file.tracks.forEach((track, index) => {
    for (const event of track.events) {
      const found = tempoFrom(event);
      if (found !== undefined) tempo = wholeBpm(found);
      const text = metaString(event);
      // ❗ Track 0 only. Every other track's name meta is an instrument.
      if (index === 0 && text?.type === 0x03 && title === undefined) title = text.text;
      if (text?.type === 0x01 && text.text.startsWith(SEQ_TAG)) {
        try {
          header = JSON.parse(text.text.slice(SEQ_TAG.length)) as Record<string, unknown>;
        } catch {
          // A meta event we cannot parse is a file from somewhere else that
          // happens to start with our tag. Fall through to the generic path.
        }
      }
    }
  });
  const num = (key: string, fallback: number) =>
    typeof header?.[key] === 'number' ? (header[key] as number) : fallback;
  const zone = zoneOf(file.tracks);
  const zoned = zone.zoned;
  // RPN 0 on a member channel is where MPE puts the per-note bend range, and it
  // is written on every file this module produces. `num('bendRange', ...)` is
  // kept for the v1 files that carried it in the header instead.
  const bendRange = zone.bendRange ?? num('bendRange', zoned ? DEFAULT_BEND_RANGE : 2);

  const parts: RawPart[] = [];
  let unmatched = 0;
  /**
   * Lanes of one part come back as one part.
   *
   * ⚠️ **A part too polyphonic for fifteen channels is written as several
   * MIDI tracks** -- see `laneOf` in the exporter -- and they carry the same
   * `LBP-TRK` identity precisely so that this can put them together again.
   * Everything in the key is a field `partsOf` grouped on, so two tracks sharing
   * it were one part; a file from a DAW has no meta and no two tracks can match,
   * because `gridY` falls back to the track's own index.
   */
  const byIdentity = new Map<string, RawPart>();
  for (const track of file.tracks) {
    for (let which = 0; ; which += 1) {
      const found = readPart(track, bendRange, parts.length, zoned, opts, ticksPerStep, which);
      if (found === undefined) break;
      unmatched += found.unmatched;
      take(found.part);
      if (which + 1 >= found.metas) break;
    }
  }

  /** Fold one placement into the list, merging lanes that describe the same one. */
  function take(part: RawPart): void {
    if (part.notes.length === 0 && part.cells.length === 0) return;
    const identity = [
      part.guid, part.gridY, part.level, part.pan,
      part.echoSend, part.reverbSend, part.key, part.scale,
      part.cells.map((c) => c.join(':')).join(','),
    ].join('|');
    const already = byIdentity.get(identity);
    if (already) {
      already.notes.push(...part.notes);
      return;
    }
    byIdentity.set(identity, part);
    parts.push(part);
  }

  const built = parts.map((part) => cutIntoClips(part, ticksPerStep));
  const tracks = built.flatMap((b) => b.tracks);
  let lengthSteps = 0;
  for (const track of tracks) {
    for (const note of track.notes) {
      lengthSteps = Math.max(lengthSteps, track.stepOffset + note.endStep + 1);
    }
  }

  const volumes = Array.isArray(header?.volumes)
    ? (header.volumes as number[]).slice(0, 6)
    : [1, 1, 1, 1, 1, 1];

  return {
    sequencer: {
      uid: num('uid', 0),
      // The track name meta, then a v1 header's copy, then the caller's default.
      name: title ?? (typeof header?.name === 'string' ? (header.name as string) : fallbackName),
      author: typeof header?.author === 'string' ? authorHandle(header.author) : '',
      tempo,
      swing: num('swing', 0),
      echoFeedback: num('echoFeedback', 0),
      echoTime: num('echoTime', 1),
      echoMix: num('echoMix', 0),
      reverb: num('reverb', 0),
      loop: typeof header?.loop === 'boolean' ? (header.loop as boolean) : true,
      startPoint: num('startPoint', 0),
      numChannels: Math.min(CHANNEL_COUNT, Math.max(1, num('numChannels', 1))),
      boardRows: num('boardRows', 0),
      volumes,
      tracks,
      lengthSteps,
    },
    ours: header !== undefined,
    notes: parts.reduce((sum, p) => sum + p.notes.length, 0),
    lengthened: built.reduce((sum, b) => sum + b.lengthened, 0),
    dropped: built.reduce((sum, b) => sum + b.dropped, 0),
    unmatched,
    clips: tracks.length,
  };
}

/**
 * Does this file declare an MPE zone?
 *
 * The MPE Configuration Message is RPN 6 on channel 1 or 16 with a non-zero
 * member count. It decides who a pitch bend belongs to, so it is worth finding
 * even in a file that is not ours -- and a file that is ours says so in its
 * header as well, because a DAW that re-saves it may not keep the RPN.
 */
function zoneOf(tracks: readonly MidiTrack[]): { zoned: boolean; bendRange?: number } {
  let zoned = false;
  let bendRange: number | undefined;
  for (const track of tracks) {
    // RPN state is per channel: a file can be setting the zone on the master
    // and the range on a member with the two sequences interleaved.
    const selected = new Map<number, number>();
    for (const event of track.events) {
      const status = event.data[0];
      if ((status & 0xf0) !== 0xb0) continue;
      const channel = status & 0x0f;
      const master = channel === 0 || channel === 15;
      if (event.data[1] === 101) selected.set(channel, event.data[2] << 7);
      else if (event.data[1] === 100) {
        selected.set(channel, Math.max(0, selected.get(channel) ?? -1) | event.data[2]);
      } else if (event.data[1] === 6) {
        const rpn = selected.get(channel);
        // The MCM: RPN 6 on a master channel, with the member count.
        if (master && rpn === 6 && event.data[2] > 0) zoned = true;
        // ❗ RPN 0 on a MEMBER channel is the zone's per-note bend range. The
        // master's own RPN 0 is a different, smaller range -- ours writes 2 --
        // and reading that one instead would flatten every glide by 24x.
        if (!master && rpn === 0 && event.data[2] > 0) bendRange = event.data[2];
      }
    }
  }
  return { zoned, bendRange };
}

/**
 * One MIDI track to one part.
 *
 * ⚠️ **Notes are matched by channel AND pitch**, and a second note-on for a
 * pair already sounding ends the first. That is what the specification asks
 * for, and it is also the only reading under which an MPE file survives: the
 * channel is the note there, so pairing on pitch alone would cross two fingers
 * playing the same key.
 */
/** `row 4 - saw_wave`, and what it says. */
const LABEL = /^row (-?\d+) - ([\s\S]+)$/;

function readPart(
  track: MidiTrack,
  bendRange: number,
  index: number,
  zoned: boolean,
  options: MidiImportOptions,
  ticksPerStep: number,
  /**
   * Which `LBP-TRK` meta on this track to read.
   *
   * ❗ **A merged track carries one per placement.** `mergeRows` puts every
   * placement of a board row and instrument on one MIDI track, so the caller
   * reads the track once per meta and each pass keeps only the notes that fall
   * in that placement's own cells. `metas` in the result says how many there
   * are.
   */
  which = 0,
): { part: RawPart; unmatched: number; metas: number } | undefined {
  /** The track's own name, before anything is read out of it. */
  let label = '';
  /** How many `LBP-TRK` metas the track carries; a merged one has several. */
  let metas = 0;
  /** Whether this placement's own meta was read, so there is an exact mixer to weigh the controllers against. */
  let ours = false;
  /**
   * Every meta's cell list, so a merged track's notes can be split by cell.
   *
   * ❗ Read before anything else, because deciding which notes are THIS
   * placement's needs to know what the others claim.
   */
  const claimed: [number, number][][] = [];
  for (const event of track.events) {
    const text = metaString(event);
    if (text?.type !== 0x01 || !text.text.startsWith(TRK_TAG)) continue;
    try {
      const meta = JSON.parse(text.text.slice(TRK_TAG.length)) as Record<string, unknown>;
      claimed.push(Array.isArray(meta.clips)
        ? (meta.clips as unknown[]).flatMap((clip) => (Array.isArray(clip)
          && typeof clip[0] === 'number'
          ? [[clip[0], typeof clip[1] === 'number' ? clip[1] : 128] as [number, number]]
          : typeof clip === 'number' ? [[clip, 128] as [number, number]] : []))
        : []);
    } catch {
      claimed.push([]);
    }
  }
  const part: RawPart = {
    name: `track ${index + 1}`,
    guid: 0,
    gridY: index,
    ...NEUTRAL,
    ...CHROMATIC_C,
    rest: 1,
    names: new Map(),
    colours: new Map(),
    cells: [],
    fix: new Map(),
    notes: [],
  };
  /**
   * The mixer controllers this track carries, by CC number.
   *
   * Read before the meta, because the meta needs them: only a controller that
   * DISAGREES with the meta's exact value is an edit.
   *
   * ❗ **Kept per tick, because a merged track's mixer is automation.** The
   * exporter keeps each part's own dials in force at every one of its notes
   * (`mixerEvents`), so this reads them at one of the part's notes, once the
   * notes are split between the placements -- see the end of this function.
   */
  const mixer = new Map<number, { tick: number; value: number }[]>();
  for (const event of track.events) {
    if ((event.data[0] & 0xf0) !== 0xb0) continue;
    if (![7, 10, 90, 91].includes(event.data[1])) continue;
    const list = mixer.get(event.data[1]) ?? [];
    list.push({ tick: event.tick, value: event.data[2] });
    mixer.set(event.data[1], list);
  }
  /**
   * The value in force at a tick, which is the last one written at or before it.
   *
   * ❗ **Not the value AT that tick.** The exporter skips a controller whose
   * value has not changed, so a placement whose pan matches its neighbour's
   * writes nothing of its own -- and reading only its own tick would find
   * nothing and fall back to the meta, which is right by luck. Reading what is
   * in force is right by construction, and it is also what a DAW plays.
   */
  const inForce = (cc: number, tick: number): number | undefined => {
    let found: number | undefined;
    for (const entry of mixer.get(cc) ?? []) {
      if (entry.tick <= tick) found = entry.value;
    }
    return found;
  };
  for (const event of track.events) {
    const text = metaString(event);
    if (text?.type === 0x03 && text.text) {
      label = text.text;
      // A file that is not ours has nothing else to call the part.
      part.name = text.text;
    }
    if (text?.type === 0x01 && text.text.startsWith(TRK_TAG)) {
      metas += 1;
      if (metas - 1 !== which) continue;
      try {
        const meta = JSON.parse(text.text.slice(TRK_TAG.length)) as Record<string, unknown>;
        const pick = (key: string, fallback: number) =>
          typeof meta[key] === 'number' ? (meta[key] as number) : fallback;
        part.guid = pick('guid', 0);
        part.gridY = pick('gridY', index);

        // ❗ A lane's track is named `... (n)` so a DAW's track list reads; the
        // suffix is the exporter's and comes straight back off. The meta says
        // which lane this is, so what to strip is known exactly rather than
        // guessed at with a pattern.
        const lane = pick('lane', -1);
        const suffix = ` (${lane + 1})`;
        if (lane >= 0 && label.endsWith(suffix)) label = label.slice(0, -suffix.length);
        // Then the duplicate index, which the exporter put on before the lane.
        const dup = pick('dup', 0);
        if (dup > 1 && label.endsWith(` #${dup}`)) label = label.slice(0, -` #${dup}`.length);

        // ❗ **`row 4 - saw_wave` is where the row and the instrument live**,
        // because MIDI has no message for either: nothing at all for a board
        // row, and a program change is seven bits against a six-digit GUID. So
        // the track name is the one thing a DAW can edit to move a part, and it
        // is read back here.
        //
        // ⚠️ The meta still carries both, and the same rule settles a
        // disagreement as for the tempo and the mixer: the label wins only when
        // it says something different. A name that resolves to no GUID leaves
        // the meta's alone rather than dropping the instrument -- a typo in a
        // track name must not silence a part.
        const parsed = LABEL.exec(label);
        if (parsed) {
          const row = Number(parsed[1]);
          if (Number.isInteger(row)) part.gridY = row;
          // ❗ Only a name that DISAGREES with the meta's is an edit, and only
          // then is the resolver asked. Same rule as the tempo and the mixer.
          if (parsed[2] !== meta.instrument) {
            const guid = options.instrumentGuid?.(parsed[2]);
            if (guid !== undefined) part.guid = guid;
          }
        }
        // The Thing's own label, which the track name never carried.
        part.name = typeof meta.name === 'string' ? meta.name : '';
        if (meta.names !== null && typeof meta.names === 'object') {
          for (const [cell, text] of Object.entries(meta.names as Record<string, unknown>)) {
            if (Number.isInteger(Number(cell)) && typeof text === 'string') {
              part.names.set(Number(cell), text);
            }
          }
        }
        // The meta's exact mixer. The controllers are weighed against it once
        // the notes are in -- see `dialled` at the end.
        part.level = pick('level', NEUTRAL.level);
        part.pan = pick('pan', NEUTRAL.pan);
        part.reverbSend = pick('reverbSend', NEUTRAL.reverbSend);
        part.echoSend = pick('echoSend', NEUTRAL.echoSend);
        ours = true;
        // ❗ **The tint, read after the GUID has settled**, and read without
        // `pick` on purpose: there is no number to fall back to here. A file
        // that says nothing leaves it undefined and `cutIntoClips` asks
        // `factoryColour` -- which needs the instrument, and the instrument is
        // whatever the meta and the label have just agreed on.
        if (typeof meta.colour === 'number') part.colour = meta.colour | 0;
        if (meta.colours !== null && typeof meta.colours === 'object') {
          for (const [cell, tint] of Object.entries(meta.colours as Record<string, unknown>)) {
            if (Number.isInteger(Number(cell)) && typeof tint === 'number') {
              part.colours.set(Number(cell), tint | 0);
            }
          }
        }
        // The part's resting bit, and the game's current default without one.
        part.rest = pick('rest', 1) === 0 ? 0 : 1;
        if (meta.fix !== null && typeof meta.fix === 'object') {
          for (const [cell, text] of Object.entries(meta.fix as Record<string, unknown>)) {
            const at = Number(cell);
            if (Number.isInteger(at) && typeof text === 'string') {
              const raw = fromBase64(text);
              // A truncated patch is worse than none: it would cut records in
              // half. Whole records only, and the rest of the clip stands.
              if (raw.length % NOTE_RECORD_SIZE === 0) part.fix.set(at, raw);
            }
          }
        }
        if (Array.isArray(meta.clips)) {
          // ⚠️ Files written before the length was added carry bare cell
          // numbers. A whole clip is the honest fallback for those.
          part.cells = (meta.clips as unknown[]).flatMap((clip) => {
            if (typeof clip === 'number') return [[clip, 128, part.rest] as [number, number, number]];
            if (Array.isArray(clip) && typeof clip[0] === 'number') {
              return [[
                clip[0],
                typeof clip[1] === 'number' ? clip[1] : 128,
                clip[2] === 0 || clip[2] === 1 ? clip[2] : part.rest,
                // The fourth slot is the per-record resting bitmap, and only
                // the 31 clips of the corpus that mix the bit carry one.
                typeof clip[3] === 'string' ? clip[3] : undefined,
              ] as [number, number, number, string?]];
            }
            return [];
          });
        }
        // ⚠️ **Both `Key` and `Scale` are restored, but they come back by
        // different means.** The exporter folds both into the note numbers so
        // the file plays anywhere, and getting the placement back means undoing
        // that. `blockRoot(key) - 12` is a transposition and subtracting it is
        // exact; `quantise` is a projection and has no inverse, so the scale is
        // undone by `unquantise`, which picks the lowest note that snaps to the
        // one the file names. That sounds right always and reproduces the
        // author's own pitch field only where they wrote on the scale -- the
        // rest is what the record patch is for. No placement in the 22-level
        // corpus sets `Scale`, so this is measured on fixtures, not on it.
        part.key = pick('key', CHROMATIC_C.key);
        part.scale = pick('scale', 0);
      } catch {
        // Not ours after all.
      }
    }
  }

  /**
   * Which CC 74 events are a note's own opening modulation.
   *
   * ⚠️ **A newcomer's CC 74 must not join the ramp of whoever owns the
   * channel.** The exporter writes every note's opening modulation, sharer or
   * not, immediately before its note-on -- so taking every CC 74 as a control
   * point bent the modulation of notes that had nothing to do with it.
   *
   * ⚠️ **And it is the LAST one before the note-on, not every one at that
   * tick.** Excluding the whole tick was the first attempt and it threw away the
   * owner's own final ramp sample whenever a note happened to start on the same
   * instant the ramp ended -- three notes in `Orb` and `Blackfire` whose
   * modulation stopped one step short of where it was going. In the stream the
   * two are adjacent and in order: the owner's sample, then the newcomer's.
   */
  const events = track.events;
  const opensANote = new Set<number>();
  for (let i = 0; i < events.length; i += 1) {
    const status = events[i].data[0];
    if ((status & 0xf0) !== 0x90 || events[i].data[2] === 0) continue;
    const channel = status & 0x0f;
    for (let j = i - 1; j >= 0 && events[j].tick === events[i].tick; j -= 1) {
      const before = events[j].data;
      if ((before[0] & 0xf0) === 0xb0 && (before[0] & 0x0f) === channel && before[1] === 74) {
        opensANote.add(j);
        break;
      }
    }
  }

  // Bend and pressure are per channel and apply to whatever is sounding there.
  const sounding = new Map<number, RawNote>();
  const modulation = new Float64Array(16);
  // What a channel was set to, and when: expression at a note-on's own tick is
  // that note's opening value, and expression from an earlier note is not.
  const pressure = new Float64Array(16).fill(-1);
  const pressureTick = new Float64Array(16).fill(-1);
  const bend = new Float64Array(16);
  const bendTick = new Float64Array(16).fill(-1);
  /** The note each channel's expression is addressed to; see `owners`. */
  const ownerOf = new Map<number, RawNote>();
  let unmatched = 0;
  let last = 0;

  const end = (key: number, tick: number) => {
    const note = sounding.get(key);
    if (note === undefined) return;
    note.endTick = tick;
    sounding.delete(key);
    if (ownerOf.get(note.channel) === note) ownerOf.delete(note.channel);
  };

  /**
   * Which sounding notes a channel-wide bend or pressure belongs to.
   *
   * ⚠️ **In an MPE zone it is the note that OWNS the channel, and ownership
   * is claimed, not inherited.** MPE means one note per channel, so normally
   * there is nothing to choose between; the case that matters is a chord too
   * big for the zone, where a channel has to carry a second note. The exporter
   * writes bend and pressure immediately before the note-on of the note it gave
   * the channel to, and writes nothing at all for a newcomer, so a note-on that
   * finds expression at its own tick is the owner and one that does not is a
   * lodger.
   *
   * ⚠️ **This used to be "the oldest note on the channel", and that broke the
   * moment the exporter stopped allocating in time order.** Gliding notes are
   * now allocated first, so a flat note that started earlier can be sharing a
   * channel with a gliding note that started later -- and under the old rule
   * the glide went to the flat note. Ownership by claim does not care which
   * came first.
   *
   * Outside a zone a channel legitimately holds a chord, and a bend there
   * really does move all of it.
   */
  const owners = (channel: number): RawNote[] => {
    const on = [...sounding.values()].filter((note) => note.channel === channel);
    if (!zoned || on.length < 2) return on;
    const owner = ownerOf.get(channel);
    return owner !== undefined && on.includes(owner) ? [owner] : [];
  };

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const status = event.data[0];
    if (status < 0x80 || status >= 0xf0) continue;
    const kind = status & 0xf0;
    const channel = status & 0x0f;
    const a = event.data[1];
    const b = event.data[2];
    last = Math.max(last, event.tick);
    const key = channel * 128 + a;
    if (kind === 0x90 && b > 0) {
      end(key, event.tick);
      // ⚠️ **Only a note that finds its channel empty may claim the expression
      // sent at its tick, and claiming CONSUMES it.** A note joining a channel
      // wrote none of its own -- see the exporter -- so anything there belongs
      // to somebody else. Both halves are needed: without the emptiness test a
      // newcomer landing on a tick where the owner happened to emit a glide
      // sample claimed the whole rest of the ramp; without the consumption a
      // second note-on at the same instant claimed it a second time.
      const alone = ![...sounding.values()].some((n) => n.channel === channel);
      const claimsBend = alone && bendTick[channel] === event.tick;
      const claimsPress = alone && pressureTick[channel] === event.tick;
      const note: RawNote = {
        channel, note: a, velocity: b,
        opening: claimsPress ? pressure[channel] : undefined,
        openingBend: claimsBend ? bend[channel] : undefined,
        startTick: event.tick, endTick: event.tick,
        modulation: modulation[channel],
        bends: [], presses: [], mods: [],
      };
      if (claimsBend || claimsPress) {
        bendTick[channel] = -1;
        pressureTick[channel] = -1;
        ownerOf.set(channel, note);
      }
      sounding.set(key, note);
      part.notes.push(note);
    } else if (kind === 0x80 || (kind === 0x90 && b === 0)) {
      end(key, event.tick);
    } else if (kind === 0xe0) {
      const value = ((b << 7) | a) - 8192;
      const semitones = (value / 8192) * bendRange;
      bend[channel] = semitones;
      bendTick[channel] = event.tick;
      for (const note of owners(channel)) note.bends.push({ tick: event.tick, semitones });
    } else if (kind === 0xd0) {
      pressure[channel] = a;
      pressureTick[channel] = event.tick;
      for (const note of owners(channel)) note.presses.push({ tick: event.tick, volume: a });
    } else if (kind === 0xb0) {
      if (a === 74) {
        modulation[channel] = modFrom7(b);
        // Sounding notes take it as a control point -- unless this is the one
        // that opens a note starting here, which is that note's own value and
        // none of the owner's business.
        if (!opensANote.has(index)) {
          for (const note of owners(channel)) {
            note.mods.push({ tick: event.tick, value: modFrom7(b) });
          }
        }
      }
      else if (a === 120 || a === 123) {
        for (const k of [...sounding.keys()]) end(k, event.tick);
      }
    }
  }
  // A note-on with no note-off is a broken file, not a note that lasts forever.
  for (const key of [...sounding.keys()]) {
    unmatched += 1;
    end(key, Math.max(last, sounding.get(key)?.startTick ?? 0));
  }
  // ❗ **A merged track's notes belong to whichever placement declared the cell
  // they fall in.** No two placements of a row group share a cell -- 0 of
  // 62,158 across the corpus -- so this is a partition, not a guess. A note no
  // placement claims stays with the first, where it would have gone anyway.
  const fits = (cells: [number, number][], from: number, to: number) =>
    cells.some(([cell, steps]) => {
      const at = cell * STEPS_PER_CELL;
      return at <= from && to - at < steps;
    });
  /** The steps a note spans, as the cell lists measure them. */
  const span = (note: RawNote) => {
    const startThirds = thirdsOf(note.startTick, ticksPerStep);
    const endThirds = Math.max(startThirds, thirdsOf(note.endTick, ticksPerStep) - 3);
    return { from: Math.floor(startThirds / 3), to: Math.floor(endThirds / 3) };
  };
  const merged = metas > 1 && claimed.length === metas;
  if (merged) {
    part.notes = part.notes.filter((note) => {
      const { from, to } = span(note);
      const mine = fits(claimed[which], from, to);
      if (mine) return true;
      // Nobody's? Then the first pass keeps it rather than the file losing it.
      return which === 0 && !claimed.some((cells) => fits(cells, from, to));
    });
  }

  // ❗ **The mixer, read at one of the placement's own notes.** The exporter
  // keeps a part's dials in force at every note it plays, so any of them will
  // do -- except a note that fits a neighbour's cells as well, which may be the
  // neighbour's and sit under its mixer. So the first note that only this
  // placement claims, and the first note at all when every one is shared.
  //
  // ⚠️ **Not the first cell, which is where this read until 2026-09-24.** The
  // exporter wrote each part's dials once, at its first cell, and a DAW then
  // played a part returning after another on the other's mixer. With a step
  // at every note instead, the first cell can still be under the part before.
  //
  // A placement with no notes reads the meta alone: nothing of it sounds, so no
  // controller on the track is its.
  if (ours && part.notes.length > 0) {
    const byTime = [...part.notes].sort((a, b) => a.startTick - b.startTick);
    const own = merged
      ? byTime.find((note) => {
        const { from, to } = span(note);
        return claimed.filter((cells) => fits(cells, from, to)).length === 1;
      })
      : undefined;
    const tick = (own ?? byTime[0]).startTick;
    // ❗ **The controller wins the moment it stops agreeing.** Written and read
    // as a pair: seven bits cannot hold the editor's steps, so a file nobody
    // touched keeps the meta's exact 0.25, and a file whose fader moved gets
    // what the fader says. The same rule the tempo uses.
    const dialled = (cc: number | undefined, exact: number) =>
      cc === undefined || cc === clamp7(exact * 127) ? exact : cc / 127;
    part.level = dialled(inForce(7, tick), part.level);
    part.pan = dialled(inForce(10, tick), part.pan);
    part.reverbSend = dialled(inForce(91, tick), part.reverbSend);
    part.echoSend = dialled(inForce(90, tick), part.echoSend);
  }
  return part.notes.length > 0 || part.guid !== 0 ? { part, unmatched, metas } : undefined;
}

/** Positions are thirds of a step, which is the finest the record format has. */
const thirdsOf = (tick: number, ticksPerStep: number) =>
  Math.round((tick / ticksPerStep) * 3);

/**
 * Drop the control points that lie on the line between their neighbours.
 *
 * ⚠️ **This is the inverse of the exporter's glide resampling**, and it has to
 * be tolerant rather than exact: a resampled point is `round(lerp)`, so it
 * misses the true line by up to half a unit and an exact test would keep every
 * one of the hundred samples a long glide was written as. Half a unit is also
 * the largest error that cannot change a rendered note, since both fields are
 * integers.
 *
 * ⚠️ **And it has to be Douglas-Peucker, not a walk comparing each point to its
 * immediate neighbours.** The obvious incremental test fails on exactly the
 * data this exists for. Pitch comes back through `Math.round`, so a twelve
 * semitone glide is a twelve-tread staircase, and while every tread is within
 * half a unit of the *whole* line, a tread is not within half a unit of the
 * short line between the two points either side of it. The incremental version
 * returned ten points where the file had written two, and each re-export would
 * have grown them again.
 *
 * A genuine point that happens to sit on the line through its neighbours is
 * dropped too. It has to be: it is indistinguishable from a resampled one, and
 * the engine interpolates linearly, so the note sounds the same either way.
 */
function simplify(
  points: { thirds: number; pitch: number; volume: number; mod: number }[],
  stated: ReadonlySet<number> = new Set(),
): { thirds: number; pitch: number; volume: number; mod: number }[] {
  if (points.length <= 2) return points;
  // ❗ A point the file states outright is kept whatever the geometry says --
  // it is there BECAUSE it is redundant. See `stated` in `cutIntoClips`.
  const keep = points.map((point) => stated.has(point.thirds));
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const span = stack.pop();
    if (span === undefined) break;
    const [a, b] = span;
    if (b - a < 2) continue;
    const from = points[a];
    const to = points[b];
    const width = to.thirds - from.thirds;
    let worst = -1;
    // Normalised, so 1 is "at its tolerance" for whichever field is worst.
    let worstBy = 1;
    // Each field against its own tolerance, then the worst of the three. Pitch
    // is held far tighter than the others because it is no longer rounded
    // before it gets here: what arrives is the ramp the file drew, and the only
    // slack it needs is the bend's own 14-bit step.
    const byOf = (i: number): number => {
      const t = width > 0 ? (points[i].thirds - from.thirds) / width : 0;
      return Math.max(
        Math.abs(from.pitch + (to.pitch - from.pitch) * t - points[i].pitch) / PITCH_TOLERANCE,
        Math.abs(from.volume + (to.volume - from.volume) * t - points[i].volume) / TOLERANCE,
        // ❗ On the nibble's own scale: the modulation is 0..1 in steps of 1/15.
        Math.abs((from.mod + (to.mod - from.mod) * t - points[i].mod) * 15) / TOLERANCE,
      );
    };
    for (let i = a + 1; i < b; i += 1) {
      const by = byOf(i);
      if (by > worstBy) {
        worstBy = by;
        worst = i;
      }
    }
    if (worst < 0) continue;
    // ❗ **At a near tie, take the breakpoint that sits on a whole step.**
    // Authors write on steps; the exporter resamples onto thirds; and a corner
    // in a staircase deviates from its chord by almost exactly as much one
    // third before the corner as at it. Douglas-Peucker's plain "furthest from
    // the chord" then picks the third, and the clip comes back with its corner
    // moved -- which is the single largest family in question 24. The band is
    // in units of the field's own tolerance, so it is a fraction of the error
    // that cannot change a rendered note in the first place.
    if (points[worst].thirds % 3 !== 0) {
      let best = -1;
      for (let i = a + 1; i < b; i += 1) {
        if (points[i].thirds % 3 !== 0 || byOf(i) < worstBy - WHOLE_STEP_BAND) continue;
        // The nearest qualifying whole step, not the earliest: the corner the
        // author wrote is the one beside the corner the resampling made.
        if (best < 0 || Math.abs(i - worst) < Math.abs(best - worst)) best = i;
      }
      if (best >= 0) worst = best;
    }
    keep[worst] = true;
    stack.push([a, worst], [worst, b]);
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * Half a unit, and a hair, because both fields are integers.
 *
 * A resampled point is `round(exact)`, so it can miss the true line by exactly
 * half; the hair keeps floating point from turning that into a split. Half a
 * unit is also the largest error that cannot change a rendered note.
 */
const TOLERANCE = 0.5 + 1e-9;

/**
 * How far a pitch may sit off the line and still be dropped, in semitones.
 *
 * ❗ Far tighter than half a step, because the pitch is not rounded before the
 * simplifier sees it. A 14-bit bend over the widest range this writes carries a
 * semitone to 96/16384 = 0.006, so 0.02 is three times the quantiser and a
 * fiftieth of the smallest musical interval there is.
 */
const PITCH_TOLERANCE = 0.02;

/**
 * How far below the worst deviation a whole-step breakpoint may sit and still
 * be preferred to it, in units of the field's own tolerance.
 *
 * **One**, and it is the rounding's own size rather than a fitted number: a
 * resampled value is `round(exact)` and so misses the true ramp by up to half a
 * unit, which `TOLERANCE` normalises to exactly 1. Two candidate corners a third
 * apart on the same staircase cannot differ by more than that.
 *
 * ❗ **Widening it cannot cost accuracy**, which is why the plateau is so broad.
 * Douglas-Peucker keeps splitting until nothing exceeds its tolerance, so
 * choosing a different point of the ones that exceed it changes *which* records
 * come back, never how far the reconstruction sits from the curve. Measured over
 * the corpus the patch is 78 clips at 0.1, 57 at 0.2 and **54 from 0.34 all the
 * way to 5**.
 */
const WHOLE_STEP_BAND = 1;

/**
 * A part to LBP clips.
 *
 * ⚠️ **A record's step field is seven bits.** A clip therefore covers 128 steps
 * and starts on a cell boundary, `gridX * 16`, so anything longer than that is
 * re-cut here -- greedily, in note order, opening a clip at the cell of the
 * first note that will not fit in the current one. Clip boundaries after a
 * round trip are the exporter's, not the original's; the music is the same and
 * the board layout is not.
 */
function cutIntoClips(
  part: RawPart,
  ticksPerStep: number,
): { tracks: Track[]; lengthened: number; dropped: number } {
  const MAX_STEP = 127;
  let lengthened = 0;
  let dropped = 0;

  const notes = part.notes
    .map((raw) => {
      const startThirds = thirdsOf(raw.startTick, ticksPerStep);
      // A note lasts `last - first + 1` steps, so its final record sits one
      // whole step before its note-off.
      let endThirds = thirdsOf(raw.endTick, ticksPerStep) - 3;
      if (endThirds < startThirds) {
        endThirds = startThirds;
        lengthened += 1;
      }
      const base = raw.note;
      // ⚠️ **One timeline, walked once, carrying the last value of each field.**
      // Bend and pressure arrive as two independent streams and a control point
      // needs both, so a point made by a bend has to inherit whatever the
      // pressure was at that instant, and the other way round. Merging first and
      // walking once is what makes that true; filling each stream in on its own
      // reads the wrong neighbour whenever the two interleave.
      type Move = {
        tick: number;
        pitch?: number;
        volume?: number;
        mod?: number;
      };
      const moves: Move[] = [
        // ⚠️ **Fractional, and rounded only when a record is written.** The
        // engine's glide is linear in semitones and the bend carries it to
        // within 0.006 of one; rounding each sample to an integer first turns a
        // ramp into a staircase, and the simplifier then keeps the tread where
        // the rounding crossed a half rather than the control point the file
        // actually named. A one-semitone rise over three thirds came back a
        // third early -- 2,432 notes across the corpus.
        ...raw.bends.map((b) => ({ tick: b.tick, pitch: base + b.semitones })),
        ...raw.presses.map((p) => ({ tick: p.tick, volume: p.volume })),
        ...raw.mods.map((m) => ({ tick: m.tick, mod: m.value })),
      ].sort((x, y) => x.tick - y.tick);

      /**
       * Positions the file states outright rather than implies.
       *
       * ❗ **A repeated value is a control point.** The exporter never resamples
       * the same value twice -- see `sentPress` there -- so a message carrying
       * the value already in force can only be a control point where nothing
       * moved. Those are the records that used to vanish: a note written as four
       * identical records came back as two, and 526 of the corpus's lost control
       * points are this shape.
       */
      const stated = new Set<number>();
      {
        let held = raw.opening ?? raw.velocity;
        for (const press of raw.presses) {
          if (clamp7(press.volume) === clamp7(held)) {
            stated.add(Math.min(Math.max(thirdsOf(press.tick, ticksPerStep), startThirds), endThirds));
          }
          held = press.volume;
        }
      }

      const collected = new Map<number, { thirds: number; pitch: number; volume: number; mod: number }>();
      let pitch = base + Math.round(raw.openingBend ?? 0);
      let volume = raw.opening ?? raw.velocity;
      let mod = raw.modulation;
      collected.set(startThirds, { thirds: startThirds, pitch, volume, mod });
      for (const move of moves) {
        if (move.pitch !== undefined) pitch = move.pitch;
        if (move.volume !== undefined) volume = move.volume;
        if (move.mod !== undefined) mod = move.mod;
        const thirds = Math.min(Math.max(thirdsOf(move.tick, ticksPerStep), startThirds), endThirds);
        collected.set(thirds, { thirds, pitch, volume, mod });
      }
      if (!collected.has(endThirds)) {
        collected.set(endThirds, { thirds: endThirds, pitch, volume, mod });
      }
      const points = simplify(
        [...collected.values()].sort((x, y) => x.thirds - y.thirds),
        stated,
      );
      // ⚠️ **A note that starts already bent keeps BOTH pitches**, the written
      // one and the bent one, on the same position. The MIDI note number is the
      // key that was struck and the bend is where it went, and the two are not
      // interchangeable here: the engine picks the sample SLOT from the record's
      // own pitch and only then applies the glide, so folding the bend into the
      // first record can cross a key split and change which sample plays. This
      // is also exactly the shape the exporter collapsed on the way out, so the
      // pair round-trips.
      const openingBend = Math.round(raw.openingBend ?? 0);
      // ❗ **And the modulation it opened at, when a CC 74 at its own tick moved
      // it.** The exporter writes the opening value before the note-on and the
      // jumped-to value straight after, so a move landing on the note's own
      // start is the second half of a coincident pair -- the same shape the
      // opening bend has, and it takes the same extra record.
      const jumped = raw.mods.some(
        (m) => thirdsOf(m.tick, ticksPerStep) === startThirds
          && Math.abs(m.value - raw.modulation) > 1e-9,
      );
      // ❗ And the volume, which jumps the same way: the exporter sends the
      // opening one before the note-on and the jumped-to one straight after.
      const opened = raw.opening ?? raw.velocity;
      const swelled = raw.presses.some(
        (p) => thirdsOf(p.tick, ticksPerStep) === startThirds
          && clamp7(p.volume) !== clamp7(opened),
      );
      if (openingBend !== 0 || jumped || swelled) {
        points.unshift({
          thirds: startThirds,
          pitch: openingBend !== 0 ? base : points[0].pitch,
          volume: swelled ? opened : points[0].volume,
          mod: jumped ? raw.modulation : points[0].mod,
        });
      }
      return { startThirds, endThirds, points, modulation: raw.modulation };
    })
    // ⚠️ **Ties break on pitch DESCENDING, then on the END ascending, and
    // both are measured rather than chosen.** Of the 27,124 corpus clips that
    // hold two notes at one position, **27,124** are written high note first;
    // of the 333 that then hold two at one position AND one pitch, **333** put
    // the shorter one first. Sorting on the start alone left 1,944 clips holding
    // the right notes in the wrong order, and stopping at the pitch left 37.
    .sort((a, b) =>
      a.startThirds - b.startThirds
      || b.points[0].pitch - a.points[0].pitch
      || a.endThirds - b.endThirds);

  /**
   * Where the clips go.
   *
   * ⚠️ **The board cells the author used are in the file, and using them is
   * the difference between giving the level back its layout and giving it a
   * layout.** `LBP-TRK` carries the `gridX` of every clip the part had; each
   * note goes into the LAST of them that can hold it, which is the cell it was
   * most likely written in. Clips of one part overlap heavily -- `Ascetic` has
   * them every two cells, each holding 128 steps -- so a note that two cells
   * could hold is genuinely ambiguous, and either answer puts it at the same
   * place on the timeline.
   *
   * With no cells to go on -- a file from a DAW -- this falls back to cutting
   * greedily, opening a clip at the cell of the first note that will not fit in
   * the one before.
   */
  const cells = [...part.cells].sort((a, b) => a[0] - b[0]);
  /** The clip being written, and the inert bit 6 its records carry. */
  let resting = part.rest;
  /**
   * The clip's per-record resting bits, when it carries a bitmap.
   *
   * ⚠️ **Indexed by record, in this reconstruction's own order.** For the clips
   * that carry one the records match the file's exactly apart from this bit, so
   * the orders agree; a file a DAW has edited misaligns it and puts an inert bit
   * on the wrong record, which is the whole reason a bitmap is safe where a
   * verbatim patch is not.
   */
  let restingMap: Uint8Array | undefined;
  /** Every clip that could hold a note, nearest cell last. */
  const fitting = (startStep: number, endStep: number): number[] => {
    // The clips' own windows first, and whole clips only if nothing fits --
    // a length can be short of the truth if the file was written elsewhere.
    for (const wide of [false, true]) {
      const found: number[] = [];
      for (const [cell, steps] of cells) {
        const at = cell * STEPS_PER_CELL;
        const room = wide ? MAX_STEP + 1 : steps;
        if (at <= startStep && endStep - at < room) found.push(at);
      }
      if (found.length > 0) return found;
    }
    return [];
  };

  // What the exporter added to every note number, and this has to take away.
  const transpose = blockRoot(part.key) - 12;
  /** The note field that sounds at `pitch`, undoing the key and the scale. */
  const unsounded = (pitch: number) => unquantise(pitch - transpose, part.scale);

  const tracks: Track[] = [];
  let clipStart = 0;
  let open: typeof notes = [];
  const flush = (allowEmpty = false) => {
    if (open.length === 0 && !allowEmpty) return;
    // ❗ A clip the file spelled out takes it verbatim, notes and all.
    const verbatim = part.fix.get(clipStart / STEPS_PER_CELL);
    const bytes = verbatim ?? new Uint8Array(
      open.reduce((sum, n) => sum + n.points.length, 0) * NOTE_RECORD_SIZE,
    );
    let at = 0;
    for (const note of verbatim ? [] : open) {
      note.points.forEach((point, index) => {
        const thirds = point.thirds - clipStart * 3;
        const step = Math.floor(thirds / 3);
        const subStep = thirds - step * 3;
        const last = index === note.points.length - 1;
        bytes[at] = (step & 0x7f) | (subStep > 0 ? 0x80 : 0);
        // ❗ Back through the placement's own key, so `notePitch` puts the note
        // where the file says it sounds. `transpose` is 0 for a chromatic C.
        bytes[at + 1] = (clamp7(unsounded(point.pitch)) & 0x7f) | (last ? 0x80 : 0);
        bytes[at + 2] = clamp7(point.volume);
        // The fourth byte is the packed field: modulation in the low nibble,
        // and bit 6 is the sub-step's high bit -- which the engine reads only
        // when byte 0's bit 7 is set, and which the editor writes at rest
        // anyway. Bits 4..5 select one of four per-block tables and nothing
        // here models them, so they stay clear.
        const slot = at / NOTE_RECORD_SIZE;
        const bit = restingMap === undefined
          ? resting
          : ((restingMap[slot >> 3] ?? 0) >> (slot & 7)) & 1;
        const high = subStep === 1 ? 0 : subStep === 2 ? 0x40 : bit * 0x40;
        bytes[at + 3] = Math.round(point.mod * 15) | high;
        at += NOTE_RECORD_SIZE;
      });
    }
    const grouped = readNotes(bytes);
    tracks.push({
      guid: part.guid,
      name: part.names.get(clipStart / STEPS_PER_CELL) ?? part.name,
      colour: part.colours.get(clipStart / STEPS_PER_CELL)
        ?? part.colour ?? factoryColour(part.guid),
      gridX: clipStart / STEPS_PER_CELL,
      gridY: part.gridY,
      stepOffset: clipStart,
      level: part.level,
      pan: part.pan,
      echoSend: part.echoSend,
      reverbSend: part.reverbSend,
      key: part.key,
      scale: part.scale,
      notes: grouped.notes,
      records: bytes,
      trailingRecords: grouped.trailing.length,
    });
    open = [];
  };

  // The author's own cells first, when the file remembers them.
  if (cells.length > 0) {
    const byCell = new Map<number, typeof notes>();
    const leftOver: typeof notes = [];
    const put = (at: number, note: (typeof notes)[number]) => {
      const found = byCell.get(at);
      if (found) found.push(note);
      else byCell.set(at, [note]);
    };
    // ⚠️ **The notes only one clip can hold go first.** With each clip's length
    // known that is 99.91% of them; the rest are genuinely ambiguous -- clips of
    // one part overlap -- and taking the nearest cell for those emptied 52 clips
    // across the corpus whose every note some neighbour could also hold. Placing
    // the certain ones first leaves the ambiguous ones something to fill.
    const unsure: { note: (typeof notes)[number]; where: number[] }[] = [];
    for (const note of notes) {
      const where = fitting(Math.floor(note.startThirds / 3), Math.floor(note.endThirds / 3));
      if (where.length === 0) leftOver.push(note);
      else if (where.length === 1) put(where[0], note);
      else unsure.push({ note, where });
    }
    for (const { note, where } of unsure) {
      const empty = where.find((at) => !byCell.has(at));
      put(empty ?? where[where.length - 1], note);
    }
    // ⚠️ **Every declared cell is emitted, including the ones nothing lands
    // in.** 52 placements across the corpus hold no notes at all -- an
    // instrument dropped on the board and never written in -- and there is
    // nothing in a MIDI file to bring them back except the cell list itself.
    // Without this the round trip quietly returned 62,106 clips for 62,158.
    for (const [cell, , rest, bits] of cells) {
      const at = cell * STEPS_PER_CELL;
      clipStart = at;
      resting = rest;
      restingMap = bits === undefined ? undefined : fromBase64(bits);
      open = byCell.get(at) ?? [];
      byCell.delete(at);
      flush(true);
    }
    resting = part.rest;
    restingMap = undefined;
    for (const [at, group] of [...byCell].sort((a, b) => a[0] - b[0])) {
      clipStart = at;
      open = group;
      flush();
    }
    if (leftOver.length === 0) return { tracks, lengthened, dropped };
    notes.length = 0;
    notes.push(...leftOver);
  }

  for (const note of notes) {
    const startStep = Math.floor(note.startThirds / 3);
    const endStep = Math.floor(note.endThirds / 3);
    if (open.length === 0) {
      clipStart = Math.floor(startStep / STEPS_PER_CELL) * STEPS_PER_CELL;
    } else if (endStep - clipStart > MAX_STEP) {
      flush();
      clipStart = Math.floor(startStep / STEPS_PER_CELL) * STEPS_PER_CELL;
    }
    // One note longer than a whole clip cannot be placed at all.
    if (endStep - clipStart > MAX_STEP) {
      dropped += 1;
      continue;
    }
    open.push(note);
  }
  flush();
  return { tracks, lengthened, dropped };
}

/** Re-exported so a caller can name the meta events without reaching in. */
export const META_TAGS = { sequencer: SEQ_TAG, track: TRK_TAG };

/** Kept for callers that want the raw record helper alongside the mapping. */
export type { NoteRecord };
export { meta };

/* -------------------------------------------------------------------- split */

export interface MidiSplit {
  readonly files: readonly { readonly name: string; readonly result: MidiExportResult }[];
  /** The counters, summed over the set. */
  readonly notes: number;
  readonly parts: number;
  readonly events: number;
  readonly bytes: number;
  readonly sharedChannel: number;
  readonly dragged: number;
  readonly timbred: number;
  readonly flattened: number;
  readonly droppedGlides: number;
  readonly dropped: number;
  readonly clampedPitch: number;
  readonly clampedBend: number;
  readonly patched: number;
  readonly unpatched: number;
}

/**
 * The same song across several files, so that fewer notes have to share.
 *
 * ⚠️ **A MIDI file's tracks do NOT get a channel space each.** The header can
 * declare 65,535 of them and they are still one shared set of sixteen channels:
 * the channel lives in the status byte, and two tracks writing `0x93` address
 * the same channel 4. A track is an editing container. That is the whole reason
 * a dense song runs out of member channels no matter how many tracks it uses,
 * and it is why splitting means splitting into FILES.
 *
 * (There is a `FF 21` MIDI Port meta event that does give a track its own
 * sixteen. It is deprecated, unevenly honoured, and a reader that ignores it
 * collapses every port back onto one channel space with no allocator having
 * planned for the collisions -- overlapping notes of one pitch, ambiguous
 * note-offs, notes left hanging. It is not worth the trade.)
 *
 * Measured over the corpus's 953,791 notes:
 *
 * | | files | dragged | glide lost |
 * |---|---|---|---|
 * | one file | 149 | 1,245 (0.131%) | 1,535 (0.161%) |
 * | packed, here | 249 | 193 (0.020%) | 1,016 (0.107%) |
 * | one per part | 4,909 | 0 | 825 (0.086%) |
 *
 * One file per part is perfect on drag and unusable in bulk -- `Ascetic` alone
 * becomes 46 files. Packing parts into as few files as their combined polyphony
 * allows gets most of the benefit for two.
 */
export function splitSequencerToMidi(
  sequencer: Sequencer,
  options: MidiExportOptions = {},
): MidiSplit {
  const groups = partsOf(sequencer).map((part) => {
    const tracks = part.tracks.map((index) => sequencer.tracks[index]);
    return { tracks, spans: spansOf({ ...sequencer, tracks }) };
  });

  // First-fit descending: the busiest parts choose first, which is what keeps
  // the bin count near the lower bound. `MEMBERS.length` is the limit because a
  // note beyond it is one that must share.
  groups.sort((a, b) => peak(b.spans) - peak(a.spans));
  const bins: { tracks: Track[]; spans: Span2[] }[] = [];
  for (const group of groups) {
    const bin = bins.find((b) => peak([...b.spans, ...group.spans]) <= MEMBERS.length);
    if (bin) {
      bin.tracks.push(...group.tracks);
      bin.spans.push(...group.spans);
    } else {
      bins.push({ tracks: [...group.tracks], spans: [...group.spans] });
    }
  }

  const stem = (sequencer.name || `sequencer-${sequencer.uid}`).replace(/[^\w .-]+/g, '_').trim();
  const files = bins.map((bin, index) => ({
    name: bins.length === 1
      ? `${stem || 'song'}.mid`
      : `${stem || 'song'} ${String(index + 1).padStart(2, '0')}.mid`,
    result: sequencerToMidi({ ...sequencer, tracks: bin.tracks }, options),
  }));

  const sum = (pick: (r: MidiExportResult) => number) =>
    files.reduce((total, file) => total + pick(file.result), 0);
  return {
    files,
    notes: sum((r) => r.notes),
    parts: sum((r) => r.parts),
    events: sum((r) => r.events),
    bytes: sum((r) => r.bytes.length),
    sharedChannel: sum((r) => r.sharedChannel),
    dragged: sum((r) => r.dragged),
    timbred: sum((r) => r.timbred),
    flattened: sum((r) => r.flattened),
    droppedGlides: sum((r) => r.droppedGlides),
    dropped: sum((r) => r.dropped),
    clampedPitch: sum((r) => r.clampedPitch),
    clampedBend: sum((r) => r.clampedBend),
    patched: sum((r) => r.patched),
    unpatched: sum((r) => r.unpatched),
  };
}

/** A note's life, in thirds of a step. Only the packing needs this. */
type Span2 = readonly [number, number];

function spansOf(sequencer: Sequencer): Span2[] {
  return schedule(sequencer).map(
    (event) =>
      [Math.round(event.step * 3), Math.round((event.step + event.durationSteps) * 3)] as Span2,
  );
}

/** The most notes sounding at once, by sweeping the ends. */
function peak(spans: readonly Span2[]): number {
  const edges: Span2[] = [];
  for (const [from, to] of spans) {
    edges.push([from, 1]);
    edges.push([to, -1]);
  }
  // A note ending exactly where another begins does not overlap it, so the
  // closing edge has to be taken first at a shared tick.
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let now = 0;
  let top = 0;
  for (const [, delta] of edges) {
    now += delta;
    top = Math.max(top, now);
  }
  return top;
}
