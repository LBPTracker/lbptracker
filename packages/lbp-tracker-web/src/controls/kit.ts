/**
 * The pages' controls: declared once each, read through a typed store.
 *
 * ❗ **This replaces two declarations per control, and sometimes three.** Until
 * 2026-09-06 a fader was written once in the page's HTML as an
 * `<input type="range">` with its `min`, `max` and `value`, once in the page's
 * module as a row carrying its formatter, and named a third element by string
 * join — `${id}Label`. Nothing checked that they agreed, and every way of
 * getting it wrong was silent:
 *
 * - a mistyped id read the neighbouring control and the page still worked;
 * - a formatter dividing by 100 beside a reader dividing by 10 showed one
 *   number while playing another;
 * - ⚠️ and on the live player, `setSlider('echoFb', seq.echoFeedback * 100)`
 *   had to be the exact inverse of `num('echoFb') / 100` — the two sat 350
 *   lines apart, and getting the pair wrong loads a song at the wrong feedback
 *   with the label agreeing.
 *
 * All three are structural now rather than avoided:
 *
 * - `Controls<FaderId, CheckId>` carries the unions from the page's own spec, so
 *   a wrong id will not compile.
 * - ❗ **`per` is one number, not two functions.** `value = raw / per` and
 *   `raw = value * per`, so reading and writing a control cannot disagree — the
 *   third failure above is not expressible.
 * - `format` is handed the **engine's** number, never the slider position, so
 *   the label and the sound come from the same value.
 *
 * ⚠️ **A store belongs to one page.** Ids repeat across pages with different
 * ranges — the bench's `tempo` is 40..300 and the live player's is 20..400 —
 * so there is no global table and `createControls` is called once per page,
 * with the store handed to the components through `provide`.
 */

import { reactive, type InjectionKey } from 'vue';

export interface Fader<Id extends string = string> {
  readonly id: Id;
  readonly group: string;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  /** Where the slider sits on load, and where a double-click puts it back. */
  readonly start: number;
  /** Slider steps per engine unit: `value = raw / per`, `raw = value * per`. */
  readonly per: number;
  /**
   * What the reader sees, from the engine's number. Never the slider position.
   *
   * `on` and `picked` are there for the few labels that depend on another
   * control rather than only on their own value — the live player's pool size
   * reads `off` when it is uncapped — so that stays in the spec instead of
   * becoming a second writer of the label somewhere else.
   */
  readonly format: (
    value: number,
    on: (id: string) => boolean,
    picked: (id: string) => string,
  ) => string;
  /** Greyed out and unusable while this check is on. */
  readonly disabledBy?: string;
  /** Greyed out and unusable unless this choice holds this value. */
  readonly onlyWhen?: { readonly choice: string; readonly is: string };
  /** Moving it rebuilds the worklet's output stage. */
  readonly effects?: boolean;
}

export interface Check<Id extends string = string> {
  readonly id: Id;
  readonly group: string;
  readonly label: string;
  readonly start: boolean;
  readonly title?: string;
  readonly effects?: boolean;
}

export interface Choice<Id extends string = string> {
  readonly id: Id;
  readonly group: string;
  readonly label: string;
  readonly start: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly title?: string;
  /** Picking another rebuilds the worklet's output stage. */
  readonly effects?: boolean;
}

export interface Group {
  readonly key: string;
  readonly title: string;
  /** The check that gates the group; the group greys out while it is off. */
  readonly override?: string;
  /**
   * An empty element left inside the group for imperative code to fill.
   *
   * The live player's channel strip is one fader per channel the *song* has,
   * rebuilt whenever the count changes — a list, not a declaration, so it stays
   * where it was rather than being forced into this table.
   */
  readonly slotId?: string;
  /** One `.row` per check instead of all of them on one line. */
  readonly stack?: boolean;
  readonly note?: string;
}

export interface Spec<F extends string, C extends string, S extends string> {
  readonly groups: readonly Group[];
  readonly faders: readonly Fader<F>[];
  readonly checks: readonly Check<C>[];
  readonly choices?: readonly Choice<S>[];
}

export interface Controls<F extends string, C extends string, S extends string> {
  /** Slider positions. Written by the panel and by a loaded song; read via `value`. */
  readonly positions: Record<string, number>;
  readonly checked: Record<string, boolean>;
  readonly chosen: Record<string, string>;
  readonly groups: readonly Group[];
  fadersIn(group: string): readonly Fader<F>[];
  checksIn(group: string): readonly Check<C>[];
  choicesIn(group: string): readonly Choice<S>[];
  fader(id: F): Fader<F>;
  /** Where the slider sits. */
  raw(id: F): number;
  /** What the engine is given. */
  value(id: F): number;
  /** What the reader sees, from the same number the engine gets. */
  shown(id: F): string;
  /** Put an engine value on the slider — the exact inverse of `value`. */
  setValue(id: F, value: number): void;
  on(id: C): boolean;
  set(id: C, to: boolean): void;
  picked(id: S): string;
  choose(id: S, value: string): void;
  /** Whether a fader is greyed out, by its `disabledBy` or its `onlyWhen`. */
  disabled(id: F): boolean;
  /** Put one fader back where it started — what a double-click does. */
  reset(id: F): void;
  /**
   * Everything a change to which rebuilds the output stage, as one array to
   * watch.
   *
   * ❗ **Generated from the spec's `effects` flags, not written out.** A fader
   * added with the flag would otherwise move and change nothing until somebody
   * remembered to extend a watcher — a silent failure, and the exact drift this
   * file exists to remove.
   */
  effectsSignature(): (number | boolean | string)[];
}

export function createControls<F extends string, C extends string, S extends string>(
  spec: Spec<F, C, S>,
): Controls<F, C, S> {
  const byId = new Map<string, Fader<F>>(spec.faders.map((f) => [f.id, f]));
  const choices = spec.choices ?? [];

  const positions = reactive<Record<string, number>>(
    Object.fromEntries(spec.faders.map((f) => [f.id, f.start])),
  );
  const checked = reactive<Record<string, boolean>>(
    Object.fromEntries(spec.checks.map((c) => [c.id, c.start])),
  );
  const chosen = reactive<Record<string, string>>(
    Object.fromEntries(choices.map((c) => [c.id, c.start])),
  );
  const fader = (id: F) => byId.get(id)!;

  return {
    positions,
    checked,
    chosen,
    groups: spec.groups,
    fadersIn: (group) => spec.faders.filter((f) => f.group === group),
    checksIn: (group) => spec.checks.filter((c) => c.group === group),
    choicesIn: (group) => choices.filter((c) => c.group === group),
    fader,
    raw: (id) => positions[id]!,
    value: (id) => positions[id]! / fader(id).per,
    shown: (id) => fader(id).format(
      positions[id]! / fader(id).per,
      (c) => !!checked[c],
      (c) => chosen[c] ?? '',
    ),
    setValue: (id, value) => {
      const f = fader(id);
      // Clamped and stepped, because this is fed by a song's own settings and a
      // level may hold a value the slider's range does not cover.
      positions[id] = Math.round(Math.max(f.min, Math.min(f.max, value * f.per)));
    },
    on: (id) => checked[id]!,
    set: (id, to) => {
      checked[id] = to;
    },
    picked: (id) => chosen[id]!,
    choose: (id, value) => {
      chosen[id] = value;
    },
    disabled: (id) => {
      const f = fader(id);
      return (!!f.disabledBy && !!checked[f.disabledBy])
        || (!!f.onlyWhen && chosen[f.onlyWhen.choice] !== f.onlyWhen.is);
    },
    reset: (id) => {
      positions[id] = fader(id).start;
    },
    effectsSignature: () => [
      ...spec.faders.filter((f) => f.effects).map((f) => positions[f.id]!),
      ...spec.checks.filter((c) => c.effects).map((c) => checked[c.id]!),
      ...choices.filter((c) => c.effects).map((c) => chosen[c.id]!),
    ],
  };
}

/**
 * ⚠️ **The components inject the store rather than taking it as a prop.** Each
 * page mounts several small Vue islands into markup that is otherwise plain, so
 * threading a store through props would mean every mount passing it and every
 * nested component forwarding it.
 */
/**
 * ⚠️ **`Symbol.for`, not `Symbol`.** Vite's dev server appends a `?t=` query to a
 * changed module's URL, and a page that ends up holding both `kit.ts` and
 * `kit.ts?t=…` has **two** module instances — two distinct `Symbol()`s, so
 * `inject` returns `undefined` in half the tree and the panel throws
 * `Cannot read properties of undefined (reading 'fader')` while still rendering.
 * A registry symbol is the same value in both copies, which makes the whole
 * failure unreachable rather than something to remember about HMR.
 */
export const CONTROLS = Symbol.for('lbp.controls') as InjectionKey<
  Controls<string, string, string>
>;
