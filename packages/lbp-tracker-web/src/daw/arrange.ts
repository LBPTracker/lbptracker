/**
 * The Arrange view: the board, the piano roll, the inspector, and the keys.
 *
 * The model is `@lbptracker/lib/song.ts`; the two canvases are
 * `editor/board.ts` and `editor/roll.ts`; the inspector is Vue. The song, the
 * player and the plan are the session's -- this file wires the three to
 * them and owns the view's keyboard, which only listens while the view is
 * the one shown.
 */

import { createApp, h } from 'vue';
import { STEPS_PER_CELL } from '@lbptracker/cwlib/sequencer/project.ts';
import {
  MAX_BOARD_ROWS, STOCK_BOARD_ROWS, addClip, clampClipShift, clipsAnchor, clipsEndCell, duplicateClips, freeClipShift,
  moveClips, removeClip, setSongEnd, type Clip, type ClipShift,
} from '@lbptracker/lib/song.ts';
import { confirmDialog, noticeDialog } from '../confirm.ts';
import { focusOwnsKeys, hasTextSelection } from '../keys.ts';
import { BoardView } from '../editor/board.ts';
import { RollView, type RollTool } from '../editor/roll.ts';
import { STEPS_PER_BAR, barOfCell } from '../editor/geometry.ts';
import { pickInstrument } from '../editor/instrument-picker.ts';
import Inspector from '../editor/Inspector.vue';
import {
  auditionNote, auditionPitch, byGuid, instruments, onPlan, onPlayer, player, setStatus, state,
} from './session.ts';
import { instrumentCosts, mountThermometer, percentOfLimit } from './thermometer.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export interface ArrangeHandle {
  readonly board: BoardView;
  readonly roll: RollView;
  openPanel(): void;
  closePanel(): void;
}

export function mountArrange(opts: { isActive: () => boolean }): ArrangeHandle {
  const boardScroller = $<HTMLDivElement>('boardScroller');
  const rollScroller = $<HTMLDivElement>('rollScroller');
  const rollTitle = $<HTMLSpanElement>('rollTitle');
  const hoverLine = $<HTMLDivElement>('hover');
  const tripletsButton = $<HTMLButtonElement>('triplets');
  const view = $<HTMLDivElement>('view-arrange');
  const panel = $<HTMLDivElement>('chipPanel');
  const grip = $<HTMLDivElement>('panelGrip');

  // ----------------------------------------------------------- the panel
  // The selected chip's notes and settings, up from the bottom over the board.
  // It opens when a chip is clicked or drawn, not when the playhead merely
  // moves the selection, and stays where it was dragged to.

  /** The board gets to scroll under the panel by the panel's height. */
  // The scroller ends where the panel begins, so its horizontal scrollbar sits
  // just above the panel instead of under it; the view is shorter, not padded.
  const insetBoard = () => {
    boardScroller.style.bottom = panel.hidden ? '0' : `${panel.getBoundingClientRect().height}px`;
    board.setBottomInset(0);
  };
  const openPanel = () => {
    if (!panel.hidden) return;
    panel.hidden = false;
    roll.schedule();
    insetBoard();
  };
  const closePanel = () => {
    panel.hidden = true;
    window.dispatchEvent(new Event('lbp:stop'));
    insetBoard();
  };
  $('panelClose').addEventListener('click', closePanel);
  try {
    const stored = localStorage.getItem('lbp.panel-h');
    if (stored) view.style.setProperty('--panel-h', stored);
  } catch {
    // no storage: the default height
  }
  grip.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    const startY = event.clientY;
    const startH = panel.getBoundingClientRect().height;
    const total = view.getBoundingClientRect().height;
    const move = (e: PointerEvent) => {
      const h = Math.max(160, Math.min(total * 0.92, startH + (startY - e.clientY)));
      view.style.setProperty('--panel-h', `${h}px`);
      roll.schedule();
      insetBoard();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      try {
        localStorage.setItem('lbp.panel-h', view.style.getPropertyValue('--panel-h'));
      } catch {
        // no storage
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  const board = new BoardView($<HTMLCanvasElement>('board'), boardScroller, $<HTMLDivElement>('boardSpacer'), state, {
    onSeek: (step) => {
      if (!player.hasPlan) return;
      player.seek(player.frameAt(Math.max(0, step)));
      board.followAgain();
    },
    onMove: (clips, shift) => {
      state.edit('notes', (s) => { moveClips(s, clips.map((c) => c.id), shift); });
    },
    onCreate: (at) => void createChip(at),
    instrument: (guid) => byGuid.get(guid),
    onPick: () => openPanel(),
    onEnd: (step) => state.edit('notes', (s) => setSongEnd(s, step), 'end'),
    onAddRow: () => state.addRow(),
    onRemoveRow: async (row) => {
      const held = state.song.clips.filter((c) => c.row === row).length;
      if (held > 0) {
        const ok = await confirmDialog(
          `Remove row ${row} and the ${held} instrument${held === 1 ? '' : 's'} on it?`, 'remove the row',
        );
        if (!ok) return;
      }
      state.removeRow(row);
    },
  });
  new ResizeObserver(insetBoard).observe(panel);

  const roll = new RollView(
    $<HTMLCanvasElement>('roll'), rollScroller, $<HTMLDivElement>('rollSpacer'), state, {
      onSeek: (stepInClip) => {
        const clip = state.clip();
        if (clip && player.hasPlan) player.seek(player.frameAt(Math.max(0, clip.cell * STEPS_PER_CELL + stepInClip)));
      },
      onAudition: auditionNote,
      onAuditionPitch: auditionPitch,
      // Defined further down; only ever called from a person's copy, cut or Esc.
      onClipboard: () => paintEditButtons(),
      onHover: (text) => {
        hoverLine.textContent = text;
      },
    },
  );

  /**
   * A chip drawn on the board wants an instrument: ask, then add it with the
   * length the drag gave it. Nothing is added if the question is dismissed.
   */
  async function createChip(at: { cell: number; row: number; steps: number }): Promise<void> {
    if (state.song.clips.some((c) => c.cell === at.cell && c.row === at.row)) {
      setStatus('that cell already holds an instrument; start from an empty one', true);
      return;
    }
    const bars = at.steps / STEPS_PER_BAR;
    const guid = await pickInstrument(
      instruments.value, `Which instrument, for ${bars} bars at bar ${barOfCell(at.cell)}, row ${at.row}?`,
      pickerCosts(),
    );
    if (guid === null) return;
    let added: Clip | null = null;
    state.edit('notes', (s) => {
      added = addClip(s, at, guid);
      added.steps = at.steps;
    });
    state.selection.cursor = null;
    state.selectClip(added!.id);
    openPanel();
    rollScroller.focus({ preventScroll: true });
  }

  // ------------------------------------------------------ chips as a block
  // The board's selection is a set of chips (`selection.clips`); everything
  // here acts on it as one -- one entry in the undo stack each -- and a paste
  // or a duplicate finds free cells the way a single chip always has.

  /** The chips selected on the board, in board order. */
  const chosenChips = (): Clip[] => state.boardSelection();

  /**
   * What Ctrl+C lifted: copies, so later edits to the originals do not reach
   * it, and the block's top-left, so a cut can be put back where it was.
   * The board's own; the roll keeps one of points (`RollView.clipboard`).
   */
  let chipClipboard: { clips: Clip[]; anchor: { cell: number; row: number } } | null = null;

  function copyChips(): void {
    const chosen = chosenChips();
    if (!chosen.length) return;
    chipClipboard = { clips: structuredClone(chosen), anchor: clipsAnchor(chosen) };
    setStatus(`copied ${chosen.length} instrument${chosen.length === 1 ? '' : 's'}`);
  }

  function removeChips(chosen: readonly Clip[]): void {
    if (!chosen.length) return;
    state.edit('notes', (s) => {
      for (const c of chosen) removeClip(s, c.id);
    });
    state.selectClip(null);
  }

  function cutChips(): void {
    const chosen = chosenChips();
    if (!chosen.length) return;
    copyChips();
    removeChips(chosen);
  }

  function selectAllChips(): void {
    state.selectClips(state.song.clips.map((c) => c.id));
  }

  /**
   * Copies of a block on the board, shifted from where the block is, and
   * selected in its place. The rows are clamped to what a board can hold and
   * the board grows to hold them; then the block moves right until none of
   * its chips lands on a taken cell.
   */
  function placeChips(clips: readonly Clip[], shift: ClipShift): void {
    if (!clips.length) return;
    const fit = clampClipShift(clips, shift, MAX_BOARD_ROWS);
    const bottom = Math.max(...clips.map((c) => c.row)) + fit.rows + 1;
    let copies: Clip[] = [];
    let grew = false;
    state.edit('notes', (s) => {
      if (bottom > s.boardRows) {
        s.boardRows = Math.min(MAX_BOARD_ROWS, bottom);
        grew = true;
      }
      copies = duplicateClips(s, clips, freeClipShift(s, clips, fit));
    });
    // A taller board bands its rows into the channels differently: the mixer
    // is told, as `addRow` tells it.
    if (grew) state.touch('settings');
    state.selection.cursor = null;
    state.selectClips(copies.map((c) => c.id), copies[0]?.id);
  }

  /**
   * A copy of the block: at the cursor when there is one, else right after
   * the block, edge to edge, on its own rows.
   */
  function duplicateChips(chosen: readonly Clip[]): void {
    if (!chosen.length) return;
    const anchor = clipsAnchor(chosen);
    const target = state.selection.cursor ?? { cell: clipsEndCell(chosen), row: anchor.row };
    placeChips(chosen, { cells: target.cell - anchor.cell, rows: target.row - anchor.row });
  }

  /**
   * Paste at the cursor when there is one, else right after the selected
   * block -- and with nothing selected, back where the clipboard was lifted
   * from, so a cut followed by a paste puts the chips back rather than
   * dropping them at the start of the board.
   */
  function pasteChips(): void {
    if (!chipClipboard) return;
    const { clips, anchor } = chipClipboard;
    const chosen = chosenChips();
    const target = state.selection.cursor
      ?? (chosen.length ? { cell: clipsEndCell(chosen), row: clipsAnchor(chosen).row } : anchor);
    placeChips(clips, { cells: target.cell - anchor.cell, rows: target.row - anchor.row });
  }

  /**
   * The picker's prices: what each sound would add to the sequencer's
   * thermometer, "+0%" for one the board already pays for. Nothing until the
   * instruments have been read.
   */
  function pickerCosts(exceptClip?: number): ((guid: number) => { text: string; over: boolean }) | undefined {
    const price = instrumentCosts(exceptClip);
    if (!price) return undefined;
    return (guid) => {
      const { added, over } = price(guid);
      return { text: `+${percentOfLimit(added)}`, over };
    };
  }
  mountThermometer($('thermo'));

  // Past the 25 rows the game's own editor stops at, a modal, once: not again
  // until the board has been back at 25 and crosses it anew. It still grows to
  // 33, which the game plays with cheats and nothing promises.
  let wasTall = state.song.boardRows > STOCK_BOARD_ROWS;
  state.onChange(() => {
    const tall = state.song.boardRows > STOCK_BOARD_ROWS;
    if (tall && !wasTall) {
      void noticeDialog(
        `The board is now taller than the ${STOCK_BOARD_ROWS} rows the game's editor allows. ` +
        `It can reach ${MAX_BOARD_ROWS} with cheats, which the game does not officially support, and past that it breaks.`,
      );
    }
    wasTall = tall;
  });

  createApp({
    render: () => h(Inspector, {
      state,
      instruments: instruments.value,
      costs: pickerCosts,
      onStatus: (text: string) => setStatus(text, true),
    }),
  }).mount('#inspector');

  function updateTitle(): void {
    const clip = state.clip();
    if (!clip) {
      rollTitle.textContent = 'no instrument selected';
      return;
    }
    const info = byGuid.get(clip.guid);
    rollTitle.innerHTML = '';
    rollTitle.append(
      clip.name || info?.name || '(no instrument)',
      Object.assign(document.createElement('small'), {
        textContent: `${info && clip.name ? `${info.name} · ` : ''}bar ${barOfCell(clip.cell)}, row ${clip.row} · ${clip.steps / STEPS_PER_BAR} bars`,
      }),
    );
  }
  state.onChange(updateTitle);
  updateTitle();

  // --------------------------------------------------------- the playhead

  function chipUnder(step: number): Clip | undefined {
    let found: Clip | undefined;
    for (const c of state.song.clips) {
      if (c.row !== state.selection.row) continue;
      const start = c.cell * STEPS_PER_CELL;
      if (step >= start && step < start + c.steps) found = c;
    }
    return found;
  }

  /**
   * The follow switch in the panel head: whether the roll moves to the chip
   * the playhead is inside.
   *
   * ❗ **It shows a state the person already owns** (`state.followPlayhead`) --
   * clicking a chip switches the follow off, choosing a row switches it on --
   * so the button is both the way back and the only place the current answer
   * is visible. Pressing it on jumps to the playhead's chip at once rather
   * than waiting for it to cross into the next one.
   */
  const followButton = $<HTMLButtonElement>('followPlayhead');
  const showFollow = () => followButton.setAttribute('aria-pressed', String(state.followPlayhead));
  /**
   * The chip the selection was last seen on, by the listener below.
   *
   * ⚠️ **The rule below is a transition, and it has to be.** "Selected the
   * chip the playhead is in, so follow again" read as a position first, and
   * the button could then not be switched off at all while the roll sat on
   * that chip: the click cleared the flag and the next frame put it back.
   */
  let seenSelection: number | null = null;
  /** The chip the playhead is inside on the selected row, or none; with no plan built yet the playhead is at the start. */
  const liveChip = (): Clip | undefined =>
    chipUnder(player.hasPlan ? player.stepAt(player.position()) : 0);
  state.liveChipId = () => liveChip()?.id ?? null;
  followButton.addEventListener('click', () => {
    state.followPlayhead = !state.followPlayhead;
    // Following again is following from here: the board goes back to the playhead, whatever
    // the person scrolled to (the roll only ever scrolls by hand), and the chip under it opens.
    if (state.followPlayhead) board.followAgain();
    const under = state.followPlayhead ? liveChip() : undefined;
    if (under) state.followClip(under.id);
    // Stopped, no frame will scroll the board: bring the playhead into view now.
    if (state.followPlayhead && player.hasPlan && !player.playing) board.followStep(player.stepAt(player.position()));
    showFollow();
  });
  state.onChange(showFollow);
  showFollow();
  // ⚠️ Selecting the chip the playhead is in is following again, and it is decided at the
  // selection, playing or not: a stopped playhead sits at its position (0 after a stop), so
  // clicking the chip in the first bar follows at once. Left to the next frame, the click and
  // the Play press were two moments and the follow came on at the second.
  state.onChange(() => {
    const id = state.selection.clipId;
    if (id === seenSelection) return;
    seenSelection = id;
    // The roll's playhead is in the clip's own steps: a new clip moves it even with the song
    // stopped, when no frame comes along to do it.
    const shown = state.clip();
    roll.setPlayhead(shown && player.hasPlan ? player.stepAt(player.position()) - shown.cell * STEPS_PER_CELL : null);
    if (id !== null && liveChip()?.id === id) {
      state.followPlayhead = true;
      showFollow();
    }
  });

  function paint(): void {
    if (!player.hasPlan) {
      board.setPlayhead(null);
      roll.setPlayhead(null);
      return;
    }
    const step = player.stepAt(player.position());
    board.setPlayhead(step);
    const live = chipUnder(step)?.id ?? null;
    // The playhead has crossed into another chip: the follow takes the roll there. Moving
    // the roll ONTO the playhead's chip turning the follow on is the selection listener's.
    if (state.followPlayhead && live !== null && live !== state.selection.clipId) state.followClip(live);
    showFollow();
    const clip = state.clip();
    if (clip) {
      const inClip = step - clip.cell * STEPS_PER_CELL;
      // The roll is not scrolled to it: past the edge, the person scrolls.
      roll.setPlayhead(inClip);
    } else roll.setPlayhead(null);
    if (player.playing && opts.isActive()) board.followStep(step);
  }
  /**
   * The player ticks ten times a second, which is fine for the numbers and
   * far too slow for a line: at 240 BPM a step is 62 ms, so a playhead moved
   * on the tick lurches a step and a half at a time.
   *
   * `player.stepAt` is continuous -- it divides the frames inside a step by
   * that step's own swung length -- so both playheads are moved every frame
   * from it, and the rest of `paint` (which chip is under it, what to select,
   * where to scroll) stays on the tick, where it costs nothing.
   *
   * ⚠️ The roll used to be left out of this loop and only the board was
   * smoothed, which is why its line stepped while the board's glided.
   */
  let smoothing = false;
  const smooth = () => {
    if (!player.playing || !opts.isActive()) {
      smoothing = false;
      return;
    }
    const step = player.stepAt(player.position());
    board.setPlayhead(step);
    const clip = state.clip();
    roll.setPlayhead(clip ? step - clip.cell * STEPS_PER_CELL : null);
    window.requestAnimationFrame(smooth);
  };
  const startSmoothing = () => {
    if (smoothing || !player.playing) return;
    smoothing = true;
    window.requestAnimationFrame(smooth);
  };
  onPlayer({
    tick: () => { paint(); startSmoothing(); },
    playing: (on) => {
      // Play pressed: the view follows again from wherever it was left.
      if (on) board.followAgain();
      startSmoothing();
    },
  });
  onPlan(paint);
  state.onChange((kind) => {
    if (kind === 'settings') paint();
  });

  tripletsButton.addEventListener('click', () => {
    state.triplets = !state.triplets;
    tripletsButton.setAttribute('aria-pressed', String(state.triplets));
    state.touch('selection');
  });
  $('fitNotes').addEventListener('click', () => roll.scrollToNotes());

  // ----------------------------------------------------- the grid's toolbar
  // Tools and zoom: the keys are in each one's tooltip and in the help.
  const toolButtons: Record<RollTool, HTMLButtonElement> = {
    draw: $<HTMLButtonElement>('toolDraw'),
    select: $<HTMLButtonElement>('toolSelect'),
    erase: $<HTMLButtonElement>('toolErase'),
  };
  const setTool = (tool: RollTool) => {
    roll.setTool(tool);
    for (const [name, button] of Object.entries(toolButtons)) button.setAttribute('aria-pressed', String(name === tool));
  };
  for (const [name, button] of Object.entries(toolButtons)) {
    button.addEventListener('click', () => {
      setTool(name as RollTool);
      rollScroller.focus({ preventScroll: true });
    });
  }
  $('zoomTimeIn').addEventListener('click', () => roll.zoom(1.25, 1));
  $('zoomTimeOut').addEventListener('click', () => roll.zoom(0.8, 1));
  $('zoomPitchIn').addEventListener('click', () => roll.zoom(1, 1.25));
  $('zoomPitchOut').addEventListener('click', () => roll.zoom(1, 0.8));

  // The grid's clipboard buttons: the keys' own commands.
  /** Ctrl+V's choice with the pointer off the grid: the playhead when it is in the chip, else after the selection. */
  const pasteNear = () => {
    const clip = state.clip();
    let at: number | undefined;
    if (clip && player.hasPlan) {
      const inClip = player.stepAt(player.position()) - clip.cell * STEPS_PER_CELL;
      if (inClip >= 0 && inClip < clip.steps) at = Math.round(inClip) * 3;
    }
    roll.paste(at);
  };
  const editButtons: Array<[string, () => void, 'selection' | 'clipboard']> = [
    ['editCopy', () => roll.copy(), 'selection'],
    ['editCut', () => roll.cut(), 'selection'],
    ['editPaste', pasteNear, 'clipboard'],
    ['editDuplicate', () => roll.duplicateSelection(), 'selection'],
  ];
  function paintEditButtons(): void {
    const hasClip = state.clip() !== undefined;
    for (const [id, , needs] of editButtons) {
      $<HTMLButtonElement>(id).disabled = !hasClip
        || (needs === 'selection' && state.selectedCount === 0)
        || (needs === 'clipboard' && !roll.hasClipboard);
    }
  }
  for (const [id, run] of editButtons) {
    $(id).addEventListener('click', () => {
      run();
      paintEditButtons();
      rollScroller.focus({ preventScroll: true });
    });
  }
  state.onChange(paintEditButtons);
  paintEditButtons();

  // Undo and redo: one history for the board and the grid alike.
  const undoButton = $<HTMLButtonElement>('undo');
  const redoButton = $<HTMLButtonElement>('redo');
  undoButton.addEventListener('click', () => state.undo());
  redoButton.addEventListener('click', () => state.redo());
  const paintHistory = () => {
    undoButton.disabled = !state.canUndo;
    redoButton.disabled = !state.canRedo;
  };
  state.onChange(paintHistory);
  paintHistory();

  // ------------------------------------------------------------ chip loop
  // The selected chip's bars round and round, its row at full volume and
  // every other row at a fifth: hearing one part in place while editing it.
  // Arming it cuts the song off -- whatever was ringing goes, so the loop
  // begins clean -- and starts the loop from the chip's start; disarming it
  // cuts the loop off the same way and leaves the song at the chip's start,
  // playing on from there only if it was playing when the loop was armed. It
  // follows the selection to another chip, and it is dropped when the panel
  // closes, the transport is stopped, or the song goes.
  const loopButton = $<HTMLButtonElement>('loopChip');
  let loopingClip: number | null = null;
  /** Whether the song was playing when the loop was armed: what disarming goes back to. */
  let playingBefore = false;
  const aimChipLoop = (clip: Clip, seekToStart: boolean) => {
    const start = clip.cell * STEPS_PER_CELL;
    loopingClip = clip.id;
    player.setFocus(clip.row);
    player.setRegion(start, start + clip.steps);
    loopButton.setAttribute('aria-pressed', 'true');
    if (seekToStart && player.hasPlan) player.seek(player.frameAt(start));
  };
  /** Disarm; `resume` plays the song on from the chip's start. */
  const dropChipLoop = (resume = false) => {
    if (loopingClip === null) return;
    const clip = state.clip(loopingClip);
    loopingClip = null;
    player.setFocus(null);
    applyLoopRegion();
    loopButton.setAttribute('aria-pressed', 'false');
    if (resume && clip && player.hasPlan) {
      player.stop();
      player.seek(player.frameAt(clip.cell * STEPS_PER_CELL));
      if (playingBefore) player.play();
    }
  };
  loopButton.addEventListener('click', () => {
    const clip = state.clip();
    if (loopingClip !== null) {
      dropChipLoop(true);
    } else if (clip) {
      playingBefore = player.playing;
      player.stop();
      aimChipLoop(clip, true);
      if (player.hasPlan) player.play();
    }
  });
  state.onChange(() => {
    if (loopingClip === null) return;
    const clip = state.clip();
    if (!clip || !player.hasPlan) dropChipLoop();
    else aimChipLoop(clip, clip.id !== loopingClip);
  });
  window.addEventListener('lbp:stop', () => dropChipLoop());
  // Stopped, and so back at the start: a roll that follows goes back to the row's first chip,
  // and the board to the playhead. `lbp:stop` is not this: closing the panel sends it too.
  window.addEventListener('lbp:stopped', () => {
    if (!state.followPlayhead) return;
    board.followAgain();
    const first = state.firstClipOnRow(state.selection.row);
    if (first && first.id !== state.selection.clipId) state.followClip(first.id);
    paint();
    board.followStep(player.hasPlan ? player.stepAt(player.position()) : 0);
  });

  // ---------------------------------------------------------- loop region
  // Dragged out on the board's ruler (`BoardView`), kept on the state, and the
  // player's section whenever the chip loop above is not armed: the chip's
  // section outranks it while it is, and it comes back when the chip's goes.
  // Either one outranks the song's own loop, which is the whole song.
  const applyLoopRegion = () => {
    if (loopingClip !== null) return;
    const r = state.loopRegion;
    if (r) player.setRegion(r.start, r.end);
    else player.clearRegion();
  };
  state.onChange(applyLoopRegion);

  // ------------------------------------------------------------- keyboard

  window.addEventListener('keydown', (event) => {
    if (!opts.isActive() || focusOwnsKeys(event)) return;
    const target = event.target as HTMLElement | null;
    const ctrl = event.ctrlKey || event.metaKey;
    const onBoard = target instanceof Node && boardScroller.contains(target);
    // The board takes the editing keys when it has the focus, and when the
    // note panel is closed there is no grid for them to reach but the board.
    const toBoard = onBoard || panel.hidden;
    switch (event.code) {
      case 'Escape': {
        // First of all the copied notes: the paste preview on the roll goes
        // with them, and the selection stays for the next press.
        if (roll.clearClipboard()) return;
        // Once to drop the selection -- points, the cursor, a block of chips
        // down to the one the roll shows -- again to close the panel.
        const block = state.selection.clips.size > 1;
        if (state.selectedCount === 0 && state.selection.point === null && !block && !panel.hidden) {
          closePanel();
          return;
        }
        state.selection.cursor = null;
        if (block) {
          const lead = state.clip();
          state.selectClips(lead ? [lead.id] : []);
        }
        state.selectNotes([]);
        return;
      }
      case 'Delete':
      case 'Backspace':
        event.preventDefault();
        if (toBoard) removeChips(chosenChips());
        else roll.deleteSelection();
        return;
      case 'ArrowLeft':
        event.preventDefault();
        roll.nudge(-1, 0);
        return;
      case 'ArrowRight':
        event.preventDefault();
        roll.nudge(1, 0);
        return;
      case 'ArrowUp':
        event.preventDefault();
        roll.nudge(0, event.shiftKey ? 12 : 1);
        return;
      case 'ArrowDown':
        event.preventDefault();
        roll.nudge(0, event.shiftKey ? -12 : -1);
        return;
      case 'Equal':
      case 'NumpadAdd':
        roll.adjust('volume', event.shiftKey ? 8 : 1);
        return;
      case 'Minus':
      case 'NumpadSubtract':
        roll.adjust('volume', event.shiftKey ? -8 : -1);
        return;
      case 'BracketLeft':
        roll.adjust('timbre', -1);
        return;
      case 'BracketRight':
        roll.adjust('timbre', 1);
        return;
      case 'KeyT':
        if (ctrl) return;
        tripletsButton.click();
        return;
      // ⚠️ The letters live here rather than in the shell: the Keyboard view
      // plays notes on `Z S X D C V G B H N J M , L .`, and a global binding
      // would sound one instead. This handler answers only while Arrange is up.
      case 'KeyL':
        if (ctrl) return;
        state.edit('selection', (s) => { s.loop = !s.loop; });
        return;
      // The grid's tools: only when the grid has the keys, and
      // never with Ctrl, which `Ctrl+D` and `Ctrl+V` below still own.
      case 'KeyD':
        if (ctrl || toBoard) break;
        setTool('draw');
        return;
      case 'KeyV':
        if (ctrl || toBoard) break;
        setTool('select');
        return;
      case 'KeyE':
        if (ctrl || toBoard) break;
        setTool('erase');
        return;
      case 'KeyM':
        if (ctrl) return;
        state.toggleMute(state.selection.row);
        return;
      case 'KeyS':
        if (ctrl) return;      // ctrl+S saves, and the shell has it
        state.toggleSolo(state.selection.row);
        return;
      default:
        break;
    }
    if (!ctrl) return;
    switch (event.code) {
      case 'KeyZ':
        event.preventDefault();
        if (event.shiftKey) state.redo();
        else state.undo();
        break;
      case 'KeyY':
        event.preventDefault();
        state.redo();
        break;
      case 'Digit0':
        // The grid's normal size; the browser's own zoom reset stays for the board.
        if (toBoard) break;
        event.preventDefault();
        roll.resetZoom();
        break;
      // The clipboard keys go to the board when it has them (`toBoard`), and
      // to the roll otherwise -- unless the roll has nothing for them: no
      // points selected to copy, cut or duplicate, nothing lifted to paste.
      case 'KeyA':
        event.preventDefault();
        if (toBoard) selectAllChips();
        else roll.selectAll();
        break;
      // ⚠️ Text that somebody has highlighted outranks the chips: copy and cut
      // go to the browser then, or selecting a name in a panel and pressing
      // Ctrl+C puts a board full of instruments on the clipboard instead.
      case 'KeyC':
        if (hasTextSelection()) return;
        event.preventDefault();
        if (toBoard || state.selectedCount === 0) copyChips();
        else roll.copy();
        break;
      case 'KeyX':
        if (hasTextSelection()) return;
        event.preventDefault();
        if (toBoard || state.selectedCount === 0) cutChips();
        else roll.cut();
        break;
      case 'KeyV': {
        event.preventDefault();
        if (toBoard || !roll.hasClipboard) {
          pasteChips();
          break;
        }
        // The pointer over the grid wins: the paste preview follows it, and
        // the notes land where they are drawn.
        if (roll.pasteAtCursor()) break;
        pasteNear();
        break;
      }
      case 'KeyD':
        event.preventDefault();
        if (!toBoard && state.selectedCount > 0) roll.duplicateSelection();
        else duplicateChips(chosenChips());
        break;
      default:
        break;
    }
  });

  return { board, roll, openPanel, closePanel };
}
