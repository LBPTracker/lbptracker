/**
 * The board's right-click menu: one at a time, at the pointer, kept inside the
 * window, gone on Esc, on a press anywhere outside it, on a scroll or a resize,
 * and after any of its items has run.
 *
 * It is a plain element with the menu bar's own look (`.bar-pop.menu`) rather
 * than a `<dialog>`: a modal one would make the page inert under it, and the
 * menu is a moment's question about the board, not a panel.
 */

export interface ContextItem {
  readonly label: string;
  /** A short hint on the right, as the menu bar shows its keys. */
  readonly hint?: string;
  readonly disabled?: boolean;
  run(): void;
}

/** A row of semitone buttons and a box for any other amount, which `run` gets. */
export interface ContextTranspose {
  readonly transpose: true;
  readonly label: string;
  run(semitones: number): void;
}

export type ContextEntry = ContextItem | ContextTranspose | 'separator';

let open: { close(): void } | null = null;

export function closeContextMenu(): void {
  open?.close();
}

export function showContextMenu(clientX: number, clientY: number, entries: readonly ContextEntry[]): void {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'bar-pop menu ctx-menu';
  menu.setAttribute('role', 'menu');

  const close = () => {
    if (open !== handle) return;
    open = null;
    menu.remove();
    window.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('keydown', escape, true);
    window.removeEventListener('resize', close);
    window.removeEventListener('scroll', close, true);
  };
  const handle = { close };
  const act = (fn: () => void) => {
    close();
    fn();
  };

  for (const entry of entries) {
    if (entry === 'separator') {
      menu.append(document.createElement('hr'));
    } else if ('transpose' in entry) {
      menu.append(transposeBlock(entry, act));
    } else {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.disabled = entry.disabled === true;
      button.append(entry.label);
      if (entry.hint) {
        const kbd = document.createElement('kbd');
        kbd.textContent = entry.hint;
        button.append(kbd);
      }
      button.addEventListener('click', () => act(() => entry.run()));
      menu.append(button);
    }
  }

  function outside(event: PointerEvent): void {
    if (!menu.contains(event.target as Node)) close();
  }
  function escape(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    // Ours alone: the board's own Esc would drop the selection the menu acts on.
    event.preventDefault();
    event.stopPropagation();
    close();
  }

  document.body.append(menu);
  // Kept inside the window: flipped to the pointer's other side where it would spill.
  const box = menu.getBoundingClientRect();
  const left = clientX + box.width > window.innerWidth - 4 ? Math.max(4, clientX - box.width) : clientX;
  const top = clientY + box.height > window.innerHeight - 4 ? Math.max(4, clientY - box.height) : clientY;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  open = handle;
  // Registered after the press that opened it has finished travelling.
  setTimeout(() => {
    if (open !== handle) return;
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
  });
  window.addEventListener('keydown', escape, true);
  menu.querySelector<HTMLElement>('button:not(:disabled), input')?.focus();
}

const QUICK = [-12, -1, 1, 12] as const;

function transposeBlock(entry: ContextTranspose, act: (fn: () => void) => void): HTMLElement {
  const block = document.createElement('div');
  block.className = 'ctx-transpose';
  const title = document.createElement('div');
  title.className = 'ctx-title';
  title.textContent = entry.label;
  block.append(title);

  const quick = document.createElement('div');
  quick.className = 'ctx-quick';
  for (const n of QUICK) {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.textContent = n > 0 ? `+${n}` : `−${-n}`;
    button.title = `${Math.abs(n) === 12 ? 'an octave' : 'a semitone'} ${n > 0 ? 'up' : 'down'}`;
    button.addEventListener('click', () => act(() => entry.run(n)));
    quick.append(button);
  }
  block.append(quick);

  const form = document.createElement('form');
  form.className = 'ctx-amount';
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '-127';
  input.max = '127';
  input.step = '1';
  input.value = '0';
  input.setAttribute('aria-label', 'semitones');
  const unit = document.createElement('span');
  unit.textContent = 'semitones';
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
    act(() => entry.run(n));
  });
  block.append(form);
  return block;
}
