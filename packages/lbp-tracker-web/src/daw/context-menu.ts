/**
 * The right-click menu of the board and the note grid: one at a time, at the
 * pointer, kept inside the window, with submenus that open beside their item
 * on hover, a click or →. It closes on Esc, on a press anywhere outside it, on
 * a scroll or a resize, and after any of its items has run.
 *
 * It is a plain element with the menu bar's own look (`.bar-pop.menu`) rather
 * than a `<dialog>`: a modal one would make the page inert under it, and the
 * menu is a moment's question about the grid, not a panel.
 *
 * Keys inside it: ↑ and ↓ move along the items, → opens a submenu and ← goes
 * back out of one, Enter runs the item, Esc closes everything.
 */

export interface ContextItem {
  readonly label: string;
  /** A short hint on the right, as the menu bar shows its keys. */
  readonly hint?: string;
  readonly disabled?: boolean;
  run(): void;
}

export interface ContextSubmenu {
  readonly label: string;
  readonly disabled?: boolean;
  readonly children: readonly ContextEntry[];
}

/** A number box and a button: `run` gets the whole number typed, never 0. */
export interface ContextAmount {
  readonly amount: true;
  /** What the number is, after the box: "semitones". */
  readonly unit: string;
  readonly min: number;
  readonly max: number;
  run(value: number): void;
}

export type ContextEntry = ContextItem | ContextSubmenu | ContextAmount | 'separator';

let open: { close(): void } | null = null;

export function closeContextMenu(): void {
  open?.close();
}

export function showContextMenu(clientX: number, clientY: number, entries: readonly ContextEntry[]): void {
  closeContextMenu();
  /** The root first, then each open submenu: `levels[i + 1]` was opened from `levels[i]`. */
  const levels: HTMLElement[] = [];

  const close = () => {
    if (open !== handle) return;
    open = null;
    for (const level of levels) level.remove();
    levels.length = 0;
    window.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('keydown', keys, true);
    window.removeEventListener('resize', close);
    window.removeEventListener('scroll', close, true);
  };
  const handle = { close };
  const act = (fn: () => void) => {
    close();
    fn();
  };

  /** Close every submenu deeper than `depth`, and unmark their parents' items. */
  const collapse = (depth: number) => {
    while (levels.length > depth + 1) levels.pop()!.remove();
    levels[depth]?.querySelectorAll('.ctx-open').forEach((el) => el.classList.remove('ctx-open'));
  };

  const build = (list: readonly ContextEntry[], depth: number): HTMLElement => {
    const menu = document.createElement('div');
    menu.className = 'bar-pop menu ctx-menu';
    menu.setAttribute('role', 'menu');
    for (const entry of list) {
      if (entry === 'separator') {
        menu.append(document.createElement('hr'));
      } else if ('amount' in entry) {
        menu.append(amountForm(entry, act));
      } else {
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('role', 'menuitem');
        button.disabled = entry.disabled === true;
        const label = document.createElement('span');
        label.textContent = entry.label;
        button.append(label);
        if ('children' in entry) {
          button.setAttribute('aria-haspopup', 'menu');
          const arrow = document.createElement('kbd');
          arrow.textContent = '▸';
          button.append(arrow);
          const openChild = (focus: boolean) => {
            if (button.disabled) return;
            collapse(depth);
            button.classList.add('ctx-open');
            const child = build(entry.children, depth + 1);
            place(child, button.getBoundingClientRect());
            if (focus) child.querySelector<HTMLElement>('button:not(:disabled), input')?.focus();
          };
          button.addEventListener('pointerenter', () => openChild(false));
          // → reaches this through `keys`, which clicks a focused submenu item:
          // a listener here would never hear it, the menu's keys being stopped
          // on `window` before they reach their target.
          button.addEventListener('click', () => openChild(true));
        } else {
          if (entry.hint) {
            const kbd = document.createElement('kbd');
            kbd.textContent = entry.hint;
            button.append(kbd);
          }
          // Hovering a plain item closes a submenu opened from a sibling.
          button.addEventListener('pointerenter', () => collapse(depth));
          button.addEventListener('click', () => act(() => entry.run()));
        }
        menu.append(button);
      }
    }
    document.body.append(menu);
    levels[depth] = menu;
    return menu;
  };

  /** A submenu beside the item it came from; flipped left or up where it would spill. */
  const place = (menu: HTMLElement, from: DOMRect) => {
    const box = menu.getBoundingClientRect();
    const right = from.right + 2;
    const left = right + box.width > window.innerWidth - 4 ? Math.max(4, from.left - box.width - 2) : right;
    const top = Math.max(4, Math.min(from.top - 6, window.innerHeight - 4 - box.height));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  };

  function outside(event: PointerEvent): void {
    if (!levels.some((level) => level.contains(event.target as Node))) close();
  }
  function keys(event: KeyboardEvent): void {
    // Ours alone while it is up: the board's own Esc would drop the selection
    // the menu acts on, and its arrows would move notes.
    const depth = levels.findIndex((level) => level.contains(document.activeElement));
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (depth < 0) return;
    // ❗ Every key typed in the menu stays in the menu. The page answers keys on
    // `window` -- Enter seeks to the start and cancels the default, Space
    // plays, M and S mute and solo -- so an Enter on a focused item ran
    // nothing (measured). Stopped here in the capture phase, the event never
    // reaches those handlers, and the browser's own default -- a button's
    // click, a form's submit, a digit into the box -- still happens.
    event.stopPropagation();
    const focused = document.activeElement as HTMLElement;
    if (event.key === 'ArrowRight' && focused.getAttribute('aria-haspopup') === 'menu') {
      event.preventDefault();
      focused.click();
      return;
    }
    if (event.key === 'ArrowLeft' && depth > 0) {
      event.preventDefault();
      event.stopPropagation();
      const parent = levels[depth - 1];
      collapse(depth - 1);
      parent.querySelector<HTMLElement>('[aria-haspopup]:not(:disabled)')?.focus();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (document.activeElement instanceof HTMLInputElement) return;
      event.preventDefault();
      event.stopPropagation();
      const items = [...levels[depth].querySelectorAll<HTMLElement>('button:not(:disabled), input')];
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next = (at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }
  }

  const root = build(entries, 0);
  // Kept inside the window: flipped to the pointer's other side where it would spill.
  const box = root.getBoundingClientRect();
  const left = clientX + box.width > window.innerWidth - 4 ? Math.max(4, clientX - box.width) : clientX;
  const top = clientY + box.height > window.innerHeight - 4 ? Math.max(4, clientY - box.height) : clientY;
  root.style.left = `${left}px`;
  root.style.top = `${top}px`;
  open = handle;
  // Registered after the press that opened it has finished travelling.
  // ⚠️ The focus too: that press's default focuses the canvas under it after
  // the page's handler has run, so a focus given here at once was taken back,
  // and ↓ in the menu moved the selected notes instead (measured).
  setTimeout(() => {
    if (open !== handle) return;
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    root.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
  });
  window.addEventListener('keydown', keys, true);
}

function amountForm(entry: ContextAmount, act: (fn: () => void) => void): HTMLElement {
  const form = document.createElement('form');
  form.className = 'ctx-amount';
  const input = document.createElement('input');
  input.type = 'number';
  input.min = String(entry.min);
  input.max = String(entry.max);
  input.step = '1';
  input.value = '0';
  input.setAttribute('aria-label', entry.unit);
  const unit = document.createElement('span');
  unit.textContent = entry.unit;
  const apply = document.createElement('button');
  apply.type = 'submit';
  apply.textContent = 'Apply';
  form.append(input, unit, apply);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const n = Math.trunc(Number(input.value));
    if (!Number.isFinite(n) || n === 0) {
      input.focus();
      return;
    }
    act(() => entry.run(Math.max(entry.min, Math.min(entry.max, n))));
  });
  return form;
}

/**
 * The transpose submenu, the same on the board and on the grid: the four
 * steps anyone reaches for, then any amount.
 */
export function transposeMenu(run: (semitones: number) => void): ContextEntry[] {
  return [
    { label: 'Up an octave', hint: '+12', run: () => run(12) },
    { label: 'Up a semitone', hint: '+1', run: () => run(1) },
    { label: 'Down a semitone', hint: '−1', run: () => run(-1) },
    { label: 'Down an octave', hint: '−12', run: () => run(-12) },
    'separator',
    { amount: true, unit: 'semitones', min: -127, max: 127, run },
  ];
}
