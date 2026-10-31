/**
 * Who owns a key press: the page's shortcuts, or whatever has the focus.
 *
 * Three `window` keydown handlers answer at once — the shell's transport keys
 * (`daw.ts`), the arranger's editing keys (`daw/arrange.ts`) and the Keyboard
 * view's notes (`daw/keyboard-view.ts`) — and each used to carry its own copy
 * of one test, `INPUT|SELECT|TEXTAREA`. That covered a text field and nothing
 * else.
 *
 * ❗ **A modal dialog was not covered, and the song picker lives in one.**
 * Selecting a song's name or its uid and pressing Ctrl+C copied the board's
 * chips instead of the text, because the arranger's handler reached the key
 * first and called `preventDefault`. Everything else leaked the same way: `M`
 * muted a row, `Delete` removed chips, Space started the song, all while a
 * dialog was up and the board was not even visible.
 */

/**
 * Whether the focused element owns this key press, so the page must keep out.
 *
 * True for a text field, for anything `contenteditable`, and for **any open
 * modal `<dialog>`** — the page behind one is inert by definition. ❗ Not for
 * the view panels (`.view-panel`): they are opened with `show()` so the
 * transport stays in reach, and Space must still play under the mixer. Which
 * view's own keys answer is each view's `isActive`, settled in `daw.ts`.
 */
export function focusOwnsKeys(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  if (target) {
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return true;
    if (target.isContentEditable) return true;
  }
  return document.querySelector('dialog[open]:not(.view-panel)') !== null;
}

/**
 * Whether text is selected, in which case copy and cut belong to the browser.
 *
 * ⚠️ **A canvas cannot be part of a document selection**, so a selection that
 * is not collapsed is always real text somebody highlighted — never the board's
 * chips or the grid's notes, which are drawn rather than laid out. That is what
 * makes this safe to test globally rather than per element.
 */
export function hasTextSelection(): boolean {
  const selection = document.getSelection();
  return selection !== null && !selection.isCollapsed && selection.toString().trim() !== '';
}
