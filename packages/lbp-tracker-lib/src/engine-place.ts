/**
 * A planned voice put on a run of the engine's clock: what a scheduler that
 * owns its clock -- the live player -- does as it posts each note.
 *
 * `render.ts` places every voice on one clock run from the song's start and
 * hands the mixer the clock's whole chunk table. A live player cannot: its
 * clock restarts where the transport does and moves with the tempo, and a
 * voice crosses a thread as a copy, so it carries only the window of chunks
 * it lives in. Everything else about the voice was decided by the render and
 * is in its `engine` record; only the frames are re-derived here, from the
 * note's musical positions, by the same arithmetic the render uses -- which
 * `test/engine-place.test.ts` holds to the render's own voices.
 */

import { DECLICK_SECONDS, type EngineRecord, type VoiceSpec } from './audio/mixer.ts';
import type { EngineClock } from './engine-clock.ts';

/** Frames per block, and how far past a voice's last event its window reaches. */
const BLOCK = 256;
/** A one-shot without a finite hold gets this much window, in seconds. */
const UNBOUNDED_HOLD_SECONDS = 10;

/** Where a voice sits on one run of the clock, on that run's frame axis. */
export interface ClockPlacement {
  readonly startFrame: number;
  readonly endFrame?: number;
  readonly engine: EngineRecord;
  readonly engineGrid: NonNullable<VoiceSpec['engineGrid']>;
}

/**
 * The whole step whose walk spawns a note at `position`: the position rounded
 * to its third first, as the render rounds it (`spawn` in `render.ts`).
 */
export function spawnStep(position: number): number {
  return Math.floor(Math.round(position * 3) / 3);
}

/**
 * Put `voice` on `clock` for a note at `startStep` gated at `endStep`, both
 * in the clock's own steps. `undefined` for a voice the render did not give
 * an engine record, which plays on the tracker's clock instead.
 */
export function placeOnClock(
  voice: Pick<VoiceSpec, 'engine' | 'envelope' | 'holdFrames' | 'declick'>,
  startStep: number,
  endStep: number | undefined,
  clock: EngineClock,
  rate = 48000,
): ClockPlacement | undefined {
  const engine = voice.engine;
  if (engine === undefined) return undefined;
  const onset = clock.onsetFrame(startStep);
  const end = endStep === undefined ? undefined : clock.gateFrame(endStep);
  const spawn = spawnStep(startStep);
  const walks = engine.walks.map((walk, k) => ({
    ...walk,
    frame: k === 0 ? 0 : clock.walkFrame(spawn + k) - onset,
  }));
  // The window: to the later of the gate and a one-shot's hold, plus the
  // release, plus two blocks; and never short of the last walk.
  const hold = voice.holdFrames ?? 0;
  const held = Number.isFinite(hold) ? hold : UNBOUNDED_HOLD_SECONDS * rate;
  const release = (voice.envelope?.release ?? 0) + (voice.declick === true ? DECLICK_SECONDS : 0);
  const to = Math.max(
    Math.max(end ?? onset, onset + held) + Math.ceil(release * rate) + 2 * BLOCK,
    onset + walks[walks.length - 1].frame + 2 * BLOCK,
  );
  return {
    startFrame: onset,
    endFrame: end,
    engine: { ...engine, walks },
    engineGrid: { origin: onset, ...clock.window(onset, to) },
  };
}
