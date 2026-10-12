/**
 * The one song, and everything every view shares around it.
 *
 * ❗ **There is one song open, and every view works on it.** The board and the
 * roll edit it, the mixer sets it, the renderer writes it out, the converter
 * exports it and can replace it, the keyboard plays the instrument selected on
 * it -- and the transport in the top bar plays it, through the one `Player`.
 * Before 2026-09-06 these were five pages each opening its own level, handing
 * a song to one another through `sessionStorage`; this module is what made
 * them one app.
 *
 * What lives here: the `EditorState` (the song, the selection, undo), the
 * `Player` and its plan (rebuilt through the renderer's own voice pass on
 * every note edit, swapped in under the running transport), the game's
 * instruments and their loader, the engine switches, and the status line.
 * The views mount into their own sections and reach all of it through here.
 */

import { MASTER_DEFAULTS } from '@lbptracker/lib/audio/master.ts';
import type { MasterChoice } from '@lbptracker/lib/audio/master-stage.ts';
import { shallowRef, watch } from 'vue';
import { loaderFor, manifest, type Manifest } from '../assets.ts';
import type { Sequencer } from '@lbptracker/cwlib/project.ts';
import { RATE, type InstrumentLoader } from '@lbptracker/lib/render.ts';
import { VOICES_UNLIMITED } from '@lbptracker/lib/polyphony.ts';
import {
  newSong, sequencerFromSong, songEndSteps, trackFromClip, type Clip, type Song, type SongNote,
} from '@lbptracker/lib/song.ts';
import { engine } from '../controls/engine.ts';
import { instrumentsFrom, type InstrumentInfo } from '../editor/instruments.ts';
import { EditorState } from '../editor/state.ts';
import { Player, type Health } from '../player.ts';

// ------------------------------------------------------------------ the song

export const state = new EditorState(newSong());

/** The game's instruments, once the manifest is in; a `shallowRef` so panels mounted first follow. */
export const instruments = shallowRef<InstrumentInfo[]>([]);
export const byGuid = new Map<number, InstrumentInfo>();
export let rinstIndex: Manifest | null = null;
export let smpIndex: Manifest | null = null;
let loading: Promise<InstrumentLoader> | null = null;

/**
 * Make sure the game's assets are indexed and the loader exists.
 *
 * The promise is what is kept, not the loader: several callers ask at start-up
 * before the first has an answer, and each used to fetch both manifests again.
 * A failure is forgotten, so the next caller tries afresh.
 */
export function ensureAssets(): Promise<InstrumentLoader> {
  loading ??= (async () => {
    [rinstIndex, smpIndex] = await Promise.all([manifest('fixtures/rinst'), manifest('fixtures/smp')]);
    instruments.value = instrumentsFrom(
      rinstIndex.values() as Iterable<{ guid: number; file: string; path?: string }>,
    );
    byGuid.clear();
    for (const info of instruments.value) byGuid.set(info.guid, info);
    // The chips' names and glyphs are known now. ⚠️ The board keeps what it
    // drew until told otherwise (`layer` in `editor/board.ts`), so it is told.
    state.touch('look');
    return loaderFor(rinstIndex, smpIndex);
  })().catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}

/** The song as the exporter reads it: every clip, whatever is muted. */
export const currentSequencer = (): Sequencer => sequencerFromSong(state.song);

/**
 * The song as it is heard: the rows the mutes and solos leave, for the
 * player's plan and the render. The mix is the listener's, not the file's.
 */
export const audibleSequencer = (): Sequencer => {
  const song = state.song;
  if (song.clips.every((c) => state.rowAudible(c.row))) return sequencerFromSong(song);
  return sequencerFromSong({ ...song, clips: song.clips.filter((c) => state.rowAudible(c.row)) });
};

// ------------------------------------------------------------- status, error

type StatusListener = (text: string, bad: boolean) => void;
const statusListeners = new Set<StatusListener>();
let errorSink: ((text: string) => void) | null = null;

export function onStatus(listener: StatusListener): void {
  statusListeners.add(listener);
}

export function setStatus(text: string, bad = false): void {
  for (const l of statusListeners) l(text, bad);
}

export function setErrorSink(sink: (text: string) => void): void {
  errorSink = sink;
}

export function setError(text: string): void {
  errorSink?.(text);
}

export const clock = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
};

// ---------------------------------------------------------------- the player

export interface PlayerListeners {
  health?(h: Health): void;
  stolen?(total: number): void;
  tick?(): void;
  playing?(on: boolean): void;
}
const playerListeners = new Set<PlayerListeners>();
export function onPlayer(listeners: PlayerListeners): void {
  playerListeners.add(listeners);
}

export const player = new Player({
  health: (h) => {
    for (const l of playerListeners) l.health?.(h);
  },
  stolen: (total) => {
    for (const l of playerListeners) l.stolen?.(total);
  },
  missingSample: (id) => setError(`the worklet has no sample "${id}"`),
  tick: () => {
    for (const l of playerListeners) l.tick?.();
  },
  playing: (on) => {
    for (const l of playerListeners) l.playing?.(on);
  },
  progress: (phase, done, total) => {
    setStatus(`preparing: ${phase} ${Math.round((done / Math.max(1, total)) * 100)}%`);
  },
});

/** The pool size the engine switches ask for. */
export const poolSize = (): number => (engine.on('optNoCap') ? VOICES_UNLIMITED : engine.raw('voices'));

/**
 * The master bus the engine card asks for: the game's, with the AGC or
 * without, the fold's gain alone, or ours at its glue. The keyboard's worklet
 * follows the same choice (`daw/keyboard-view.ts`).
 */
export function masterChoice(): MasterChoice {
  const picked = engine.picked('master');
  if (picked === 'ours') return { amount: engine.raw('masterAmount'), ceilingDb: MASTER_DEFAULTS.ceilingDb };
  return picked === 'game' || picked === 'none' ? picked : 'agc';
}

export function pushEffects(): void {
  const song = state.song;
  player.setEffects({
    echoTime: song.echoTime,
    feedback: song.echoFeedback,
    mix: song.echoMix,
    reverbSetting: song.reverb,
    echoOn: engine.on('optEcho'),
    reverbOn: engine.on('optReverb'),
    clip: engine.on('optClip'),
    master: masterChoice(),
  });
}

export function pushSettings(): void {
  const song = state.song;
  player.setSettings({
    tempo: song.tempo,
    swing: song.swing,
    numChannels: song.numChannels,
    volumes: song.volumes,
    boardRows: song.boardRows,
  });
}

// ------------------------------------------------------------------ the plan

let replanTimer = 0;
let replanning = false;
let replanAgain = false;
let restartNext = true;
const planListeners = new Set<() => void>();
/** Called after every rebuild of the plan: the transport enables itself, the board redraws. */
export function onPlan(listener: () => void): void {
  planListeners.add(listener);
}

/**
 * What the status line says when the plan is up to date, from the song and
 * the last full build.
 *
 * ⚠️ **Both paths have to end here.** The one-track sync (`syncNow`) posts the
 * same progress events as a full rebuild, and a single track never reaches the
 * second report, so it printed `preparing: voices 0%` and left it there: every
 * note edit stuck the status until something else happened to set it. The
 * numbers a sync cannot know -- the notes the plan dropped for want of an
 * instrument, and the song's length in seconds -- are kept from the last full
 * build, which is the last time either could have changed.
 */
let lastPlan = { skipped: 0, seconds: 0 };

function showPlanSummary(): void {
  const song = state.song;
  const clips = song.clips.length;
  const notes = song.clips.reduce((n, c) => n + c.notes.length, 0);
  setStatus(
    `${clips} instrument${clips === 1 ? '' : 's'}, ` +
    `${notes.toLocaleString()} note${notes === 1 ? '' : 's'}` +
    (lastPlan.skipped ? `, ${lastPlan.skipped} with no instrument` : '') +
    `; ${clock(lastPlan.seconds)} at ${song.tempo} BPM`,
  );
}

/**
 * Rebuild the plan from the song as it stands, debounced: a drag produces a
 * change per pixel, and the voice pass over a big song takes a second.
 */
export function replanSoon(): void {
  window.clearTimeout(replanTimer);
  replanTimer = window.setTimeout(() => void replan(), 180);
}

async function replan(): Promise<void> {
  if (replanning) {
    replanAgain = true;
    return;
  }
  replanning = true;
  try {
    const load = await ensureAssets();
    const seq = audibleSequencer();
    const restart = restartNext;
    restartNext = false;
    pushEffects();
    player.setPool(poolSize());
    // The transport stops at the end of the last chip, muted or not.
    const loaded = await player.load(seq, load, restart, songEndSteps(state.song), audibleClips().map((c) => c.id));
    rememberPlanned();
    lastPlan = { skipped: loaded.skipped, seconds: loaded.seconds };
    showPlanSummary();
    for (const l of planListeners) l();
  } catch (error) {
    setStatus('failed', true);
    setError(String((error as Error).stack ?? error));
  } finally {
    replanning = false;
    if (replanAgain) {
      replanAgain = false;
      replanSoon();
    }
  }
}

state.onChange((kind) => {
  if (kind === 'notes' || kind === 'mix') syncPlan();
  else if (kind === 'settings') pushSettings();
  else if (kind === 'effects') pushEffects();
});

// ------------------------------------------------------ edits while playing

/**
 * The audible chips as the plan last saw them, and a print of each, so a
 * change can be sorted into chips added, chips gone, and chips changed inside.
 */
let plannedIds = new Set<number>();
const prints = new Map<number, string>();

const audibleClips = (): Clip[] => state.song.clips.filter((c) => state.rowAudible(c.row));

/** Everything about a chip that reaches its track: a change here is a new track. */
function printOf(clip: Clip): string {
  let s = `${clip.guid}|${clip.cell}|${clip.row}|${clip.steps}|${clip.key}|${clip.scale}|${clip.level}|${clip.pan}|${clip.echoSend}|${clip.reverbSend}|${clip.rest}`;
  for (const n of clip.notes) {
    s += `#${n.id}`;
    for (const p of n.points) s += `,${p.thirds}:${p.pitch}:${p.volume}:${p.timbre}`;
  }
  return s;
}

function rememberPlanned(): void {
  const clips = audibleClips();
  plannedIds = new Set(clips.map((c) => c.id));
  prints.clear();
  for (const c of clips) prints.set(c.id, printOf(c));
}

/**
 * A change to what is heard, while the plan stands: chips added, drawn,
 * duplicated or unmuted are planned alone and put in; chips removed or muted
 * are taken out in one pass; chips changed inside are swapped. The plan's
 * voices carry the chip's id, so where a chip sits in the list never matters.
 * Only a change too big to do piecemeal -- many chips at once, an undo across
 * the board, a row of a hundred unmuted -- is the whole plan again.
 */
const pending = { put: new Set<number>(), drop: new Set<number>() };
let syncTimer = 0;
function syncPlan(): void {
  if (!player.hasPlan || replanning) {
    replanSoon();
    return;
  }
  const clips = audibleClips();
  const now = new Set(clips.map((c) => c.id));
  for (const id of plannedIds) if (!now.has(id)) pending.drop.add(id);
  for (const c of clips) {
    if (!plannedIds.has(c.id) || prints.get(c.id) !== printOf(c)) pending.put.add(c.id);
  }
  if (pending.put.size > 8) {
    pending.put.clear();
    pending.drop.clear();
    replanSoon();
    return;
  }
  if (pending.put.size === 0 && pending.drop.size === 0) return;
  window.clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => void syncNow(), 60);
}

async function syncNow(): Promise<void> {
  const put = [...pending.put];
  const drop = new Set(pending.drop);
  pending.put.clear();
  pending.drop.clear();
  try {
    const load = await ensureAssets();
    const seq = sequencerFromSong({ ...state.song, clips: [] });
    const end = songEndSteps(state.song);
    if (drop.size > 0) {
      player.dropTracks(drop, seq, end);
      for (const id of drop) {
        plannedIds.delete(id);
        prints.delete(id);
      }
    }
    const byId = new Map(audibleClips().map((c) => [c.id, c]));
    for (const id of put) {
      const clip = byId.get(id);
      if (!clip) continue; // gone again under the timer: the next sync drops it
      await player.retrack(id, trackFromClip(clip), seq, load, end);
      plannedIds.add(id);
      prints.set(id, printOf(clip));
    }
    for (const l of planListeners) l();
    showPlanSummary();
  } catch (error) {
    setStatus('failed', true);
    setError(String((error as Error).stack ?? error));
  }
}

// The engine switches: the output stage is one message, the pool is replayed.
watch(engine.effectsSignature, () => pushEffects());
watch(() => [engine.raw('voices'), engine.on('optNoCap')], () => {
  if (player.hasPlan) player.setPool(poolSize());
});

/** A song altogether: opened, imported, or started blank. */
export function openSong(song: Song, how: string): void {
  player.clear();
  restartNext = true;
  state.replace(song);
  setStatus(`${how}: ${song.clips.length} instrument${song.clips.length === 1 ? '' : 's'}`);
  replanSoon();
}

// ----------------------------------------------------------------- audition

/** Play one note of a clip, on its own, through the same pipeline as the song. */
export function auditionNote(clip: Clip, note: SongNote): void {
  if (!note.points.length) return;
  const first = note.points[0].thirds;
  void playSolo({
    ...clip,
    cell: 0,
    notes: [{ id: 1, points: note.points.map((p) => ({ ...p, thirds: p.thirds - first })) }],
  });
}

export function auditionPitch(clip: Clip, pitch: number): void {
  void playSolo({
    ...clip,
    cell: 0,
    notes: [{ id: 1, points: [{ thirds: 0, pitch, volume: 96, timbre: 0 }] }],
  });
}

async function playSolo(solo: Clip): Promise<void> {
  try {
    const load = await ensureAssets();
    // The song's own settings and board, so the note's channel band, key and
    // scale are the ones it will play under; only the notes are the solo's.
    const seq: Sequencer = {
      ...sequencerFromSong({ ...state.song, clips: [] }),
      tracks: [trackFromClip(solo)],
      lengthSteps: solo.steps,
    };
    await player.audition(seq, load);
  } catch (error) {
    setError(String((error as Error).stack ?? error));
  }
}

export { RATE };
