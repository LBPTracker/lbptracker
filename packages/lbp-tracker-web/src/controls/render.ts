/**
 * The renderer's options — the Render view, `daw/render-view.ts`.
 *
 * ⚠️ **This page had nothing of the drift the others had**, and the conversion
 * is deliberately smaller for it. There are no `*Label` outputs here, no
 * formatters and no scales: four plain checkboxes, one choice and one fader,
 * each read once. So the markup keeps its shape — the options live in `.switch` cards
 * *beside the prose that explains them*, which is the page's whole idea — and
 * only the controls move into this table, mounted where they already were.
 *
 * ❗ **`from` and `to` stay imperative on purpose.** They are free text with
 * validation and a `bad` class, not sliders with a range and a default;
 * forcing them into a fader spec would describe them wrongly. `useRange`
 * enables them, and `daw/render-view.ts` watches the store for that instead of
 * listening on the elements.
 *
 * The voice pool is the engine card's slider (`controls/engine.ts`): the same
 * range, and its last step is no cap, where a box and an "unlimited" tick were.
 */

import { createControls, type Check, type Choice, type Fader, type Group, type Spec } from './kit.ts';
import { POOL_UNLIMITED_AT } from './engine.ts';
import { VOICE_POOL_SIZE } from '@lbptracker/lib/polyphony.ts';

const GROUP_SPECS = [
  { key: 'range', title: 'range' },
  { key: 'pool', title: 'voice pool' },
  { key: 'stage', title: 'output stage' },
  { key: 'clip', title: 'clip' },
  { key: 'master', title: 'master bus' },
] as const satisfies readonly Group[];

const CHECK_SPECS = [
  { id: 'useRange', group: 'range', label: 'just a section', start: false },
  { id: 'optReverb', group: 'stage', label: 'reverb', start: true },
  { id: 'optEcho', group: 'stage', label: 'echo', start: true },
  { id: 'optClip', group: 'clip', label: 'output clip', start: true },
] as const satisfies readonly Check[];

const FADER_SPECS = [
  { id: 'renderVoices', group: 'pool', label: 'voice pool', min: 1, max: POOL_UNLIMITED_AT, step: 1, start: VOICE_POOL_SIZE,
    per: 1,
    format: (v) => (v >= POOL_UNLIMITED_AT ? 'unlimited' : String(v)) },
] as const satisfies readonly Fader[];

/**
 * ❗ Ours by default, as on the engine card, at its default glue,
 * `MASTER_DEFAULTS`, not at the engine card's knob. See `master-stage.ts` in
 * the library.
 */
const CHOICE_SPECS = [
  {
    id: 'master',
    group: 'master',
    label: 'master bus',
    start: 'ours',
    options: [
      { value: 'none', label: "none: the fold's gain alone" },
      { value: 'game', label: "the game's" },
      { value: 'agc', label: "the game's + AGC" },
      { value: 'ours', label: 'ours: glue and limiter' },
    ],
  },
] as const satisfies readonly Choice[];

export type RenderFader = (typeof FADER_SPECS)[number]['id'];
export type RenderCheck = (typeof CHECK_SPECS)[number]['id'];
export type RenderChoice = (typeof CHOICE_SPECS)[number]['id'];

// The groups exist to give the controls a placement key; this page draws no
// `ControlGroup`, only a bare `Fader`, `Checks` and `Choice` rows inside its own cards.
export const RENDER: Spec<RenderFader, RenderCheck, RenderChoice> = {
  groups: GROUP_SPECS,
  faders: FADER_SPECS,
  checks: CHECK_SPECS,
  choices: CHOICE_SPECS,
};

export const render = createControls(RENDER);
