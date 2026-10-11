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

const GROUP_SPECS = [
  // What each does is in the help (src/help.ts, 'engine'), not beside the faders.
  { key: 'pool', title: 'voice pool' },
  { key: 'stage', title: 'output stage' },
  // The game's by default; ours, the one thing here that is not the game's, is
  // the other choice.
  { key: 'master', title: 'master bus' },
] as const satisfies readonly Group[];

const FADER_SPECS = [
  { id: 'voices', group: 'pool', label: 'size', min: 1, max: 128, step: 1, start: 32,
    per: 1, disabledBy: 'optNoCap',
    format: (v, on) => (on('optNoCap') ? 'off' : String(v)) },
  { id: 'masterAmount', group: 'master', label: 'glue', min: 0, max: 10, step: 1, start: 4,
    per: 1, effects: true, onlyWhen: { choice: 'master', is: 'ours' },
    format: (v, _on, picked) => (picked('master') === 'ours' ? String(v) : 'off') },
] as const satisfies readonly Fader[];

const CHECK_SPECS = [
  { id: 'optNoCap', group: 'pool', label: 'unlimited', start: false },
  { id: 'optEcho', group: 'stage', label: 'echo', start: true, effects: true },
  { id: 'optReverb', group: 'stage', label: 'reverb', start: true, effects: true },
  { id: 'optClip', group: 'stage', label: 'output clip', start: true, effects: true },
] as const satisfies readonly Check[];

/**
 * ❗ **The game's is the default and it stays that way**: `SMS WaveHammer` and
 * the 7.1 fold, `master-stage.ts` in the library. Ours, the glue and the
 * limiter, is nothing the game does (question 42 in steering/open-questions.md).
 * The bar's G flips the same choice, so the two cannot disagree.
 */
const CHOICE_SPECS = [
  {
    id: 'master',
    group: 'master',
    label: 'which',
    start: 'game',
    effects: true,
    options: [
      { value: 'game', label: "the game's" },
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
