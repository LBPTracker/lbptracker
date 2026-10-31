/**
 * The engine switches the mixer view offers while the song plays.
 *
 * What used to be the live page's `pool` and `reverb` groups, minus the song's
 * own settings: tempo, swing, the channels, the echo and the reverb are the
 * song's fields now, edited on the song itself (`MixerPanel.vue`), so the only
 * controls declared here are the ones that are not in the file.
 */

import {
  createControls,
  type Check,
  type Choice,
  type Fader,
  type Group,
  type Spec,
} from './kit.ts';

/** The largest capped pool the slider offers. */
export const POOL_MAX = 128;
/**
 * The slider's last step, one past `POOL_MAX`, is "unlimited": the pool has no
 * cap there. One control instead of a size and a box that switched it off.
 */
export const POOL_UNLIMITED_AT = POOL_MAX + 1;

const GROUP_SPECS = [
  // What each does is in the help (src/help.ts, 'engine'), not beside the faders.
  // The pool and the output stage's switches in one card: two rows, where two
  // cards held one slider and one line of checkboxes.
  { key: 'pool', title: 'voices & processing', checksLabel: 'effects' },
  // Ours, the glue and the limiter, by default; the game's, with an AGC or at
  // its own level, and the fold's gain alone beside it.
  { key: 'master', title: 'master bus' },
] as const satisfies readonly Group[];

const FADER_SPECS = [
  { id: 'voices', group: 'pool', label: 'size', min: 1, max: POOL_UNLIMITED_AT, step: 1, start: 32,
    per: 1,
    format: (v) => (v >= POOL_UNLIMITED_AT ? 'unlimited' : String(v)) },
  { id: 'masterAmount', group: 'master', label: 'glue', min: 0, max: 10, step: 1, start: 4,
    per: 1, effects: true, onlyWhen: { choice: 'master', is: 'ours' },
    format: (v, _on, picked) => (picked('master') === 'ours' ? String(v) : 'off') },
] as const satisfies readonly Fader[];

const CHECK_SPECS = [
  { id: 'optEcho', group: 'pool', label: 'echo', start: true, effects: true },
  { id: 'optReverb', group: 'pool', label: 'reverb', start: true, effects: true },
  { id: 'optClip', group: 'pool', label: 'output clip', start: true, effects: true },
] as const satisfies readonly Check[];

/**
 * ❗ **Ours is the default since 2026-10-12, the owner's choice** (question 42
 * in steering/open-questions.md): the fold's gain, then the glue and the
 * limiter, nothing the game does. The game's is `SMS WaveHammer` and the 7.1
 * fold, `master-stage.ts` in the library; the game's + AGC is that with a slow
 * automatic gain towards −16 LUFS and our limiter after it (`audio/agc.ts`,
 * question 63); none is the fold's gain alone, the tracker's default until
 * 0.2.43. This card is the one place the page picks it; the Render view has
 * its own.
 */
const CHOICE_SPECS = [
  {
    id: 'master',
    group: 'master',
    label: 'which',
    start: 'ours',
    effects: true,
    options: [
      { value: 'none', label: "none: the fold's gain alone" },
      { value: 'game', label: "the game's" },
      { value: 'agc', label: "the game's + AGC" },
      { value: 'ours', label: 'ours: glue and limiter' },
    ],
  },
] as const satisfies readonly Choice[];

export type EngineFader = (typeof FADER_SPECS)[number]['id'];
export type EngineCheck = (typeof CHECK_SPECS)[number]['id'];
export type EngineChoice = (typeof CHOICE_SPECS)[number]['id'];

export const ENGINE: Spec<EngineFader, EngineCheck, EngineChoice> = {
  groups: GROUP_SPECS,
  faders: FADER_SPECS,
  checks: CHECK_SPECS,
  choices: CHOICE_SPECS,
};

export const engine = createControls(ENGINE);
