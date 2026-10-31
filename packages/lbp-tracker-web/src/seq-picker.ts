/**
 * The song picker's imperative façade, over `widgets/SeqPicker.vue`.
 *
 * ❗ **The façade stays because it is the right API here.** Three pages drive
 * this from event handlers — "a level opened, here are its songs", "select this
 * one without telling me" — and none of them has a Vue root for props to flow
 * down from. `setRows` / `value` / `select` are unchanged, so the call sites
 * were not touched when the markup became a component.
 *
 * The last time two of these pages grew their own copy of something this small
 * it cost a day, which is why `packages/lbp-tracker-web/src/assets.ts` exists
 * and why this is here.
 */

import { createApp, h } from 'vue';
import SeqPicker from './widgets/SeqPicker.vue';
import { pickerState, type SeqRow } from './widgets/picker-state.ts';

export type { SeqRow } from './widgets/picker-state.ts';

export interface SeqPickerHandle {
  /** Replace the list and select the first row. Returns its key, or ''. */
  setRows(rows: readonly SeqRow[]): string;
  /** The key currently selected. */
  value(): string;
  /** Select a row without telling the caller's `onPick`. */
  select(key: string): void;
  /** Whether these songs have a link, which is what shows the copy button. */
  setLinkable(on: boolean): void;
}

/**
 * Turn a container into the picker. It supplies its own markup, so a page only
 * has to give it somewhere to live.
 *
 * `onPick` fires for a real choice and never for filtering.
 */
/**
 * `onSave`, when given, puts a "save" button beside the field: the
 * chosen sequencer leaves as one of this tracker's song files, from whichever
 * page it was found on. The page resolves the key and calls `saveSongFile`.
 *
 * `onLink` puts a "Copy the link" button there, and it appears only while
 * `setLinkable(true)` -- a level from the online archive or from Bonsai is the
 * only one whose songs have a link (`link.ts`). It answers with the link and
 * whether it reached the clipboard; ⚠️ a refused copy is **not** an error, and
 * the picker shows the URL for the reader to take by hand.
 */
export function seqPicker(
  host: HTMLElement,
  onPick: (key: string) => void | Promise<void>,
  handlers: {
    onSave?: (key: string) => void;
    onLink?: (key: string) => Promise<{ url: string; copied: boolean }>;
  } = {},
): SeqPickerHandle {
  const state = pickerState();
  // ⚠️ A **function** ref, not a string one: a string ref resolves against the
  // rendering component's `$refs`, and the root here is an anonymous render
  // function rather than a component with a template, which is exactly the case
  // where that lookup is easy to get silently wrong.
  let inner: { pick(key: string, quiet?: boolean): void } | null = null;
  createApp({
    render: () =>
      h(SeqPicker, {
        state,
        onPick,
        onSave: handlers.onSave,
        onLink: handlers.onLink,
        ref: (el: unknown) => {
          inner = el as { pick(key: string, quiet?: boolean): void } | null;
        },
      }),
  }).mount(host);

  return {
    setRows(next) {
      state.rows = next;
      state.chosen = next.length ? next[0]!.key : '';
      return state.chosen;
    },
    value: () => state.chosen,
    select(key) {
      inner?.pick(key, true);
    },
    setLinkable(on) {
      state.linkable = on;
    },
  };
}
