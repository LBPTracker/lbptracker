/**
 * The app: one page, one song, on a board with six panels to open over it.
 *
 * The top bar holds the menus, the transport and the song's name; the views
 * mount into their sections and share the song through `daw/session.ts`.
 * This file is the shell: menus, panels, transport, file panel,
 * status, the global keys. Everything a view does is in `daw/*`.
 */

// ❗ Both sheets from here, in this order: see the note at the top of daw.css.
import '../ui.css';
import '../daw.css';
import { sequencersOf, type BackupResult } from '@lbptracker/cwlib/sequencer/backup.ts';
import { AUTHOR_MAX, authorHandle, type Sequencer } from '@lbptracker/cwlib/sequencer/project.ts';
import { songEndSteps, songFromJson, songFromSequencer, newSong } from '@lbptracker/lib/song.ts';
import { STEPS_PER_BEAT } from '@lbptracker/lib/swing.ts';
import { mountFooter } from './footer.ts';
import { mountHelp } from './help.ts';
import { confirmDialog } from './confirm.ts';
import { APP_VERSION } from './version.ts';
import {
  OPEN_STEPS, PLAN_STEPS, isSongFile, openedTitle, readOpened, saveNote, type Opened,
} from './open-level.ts';
import { seqPicker } from './seq-picker.ts';
import { focusOwnsKeys } from './keys.ts';
import { saveSongFile } from './song-file.ts';
import { mountOpen } from './widgets/open-panel.ts';
import { loading, paint, type LoadingJob } from './widgets/loading.ts';
import { demoDeck } from './demo-songs.ts';
import {
  forgetLevel, linkable, pickWanted, rememberSequencer, rememberSong, songFromQuery, songLink,
} from './link.ts';
import {
  RATE, clock, ensureAssets, onPlan, onPlayer, onStatus, openSong, player, setError,
  setErrorSink, setStatus, state, whenPlanned,
} from './daw/session.ts';
import { mountArrange, type EditAction } from './daw/arrange.ts';
import { loadThermometer } from './daw/thermometer.ts';
import { mountMixer } from './daw/mixer.ts';
import { mountRender } from './daw/render-view.ts';
import { mountConvert } from './daw/convert-view.ts';
import { mountKeyboard } from './daw/keyboard-view.ts';
import { mountMediaKeys } from './daw/media-keys.ts';
import { Metronome } from './metronome.ts';
import type { Health } from './player.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// -------------------------------------------------------------------- status

const statusLine = $<HTMLDivElement>('status');
onStatus((text, bad) => {
  statusLine.textContent = text;
  statusLine.classList.toggle('bad', bad);
});
const errorCard = $<HTMLElement>('errorCard');
const errorBox = $<HTMLPreElement>('error');
setErrorSink((text) => {
  errorBox.textContent = text;
  errorCard.classList.toggle('show', text !== '');
});

// --------------------------------------------------------- pages and panels

/**
 * The board, always there, and six panels opened over it: the home page from
 * the brand and Help, the rest from the menus. A panel, while one is open, is
 * the view that has the keys. `daw.css` says why a panel is a non-modal
 * `<dialog>` with a scrim of ours.
 */
type PanelName = 'home' | 'mixer' | 'render' | 'export' | 'import' | 'keyboard' | 'bench';
export type ViewName = 'arrange' | PanelName;
const viewListeners = new Set<(view: ViewName) => void>();
let openPanel: PanelName | null = null;
const scrim = $<HTMLDivElement>('viewScrim');
const panelOf = (name: PanelName) => $<HTMLDialogElement>(`panel-${name}`);

export const activeView = (): ViewName => openPanel ?? 'arrange';

function viewChanged(): void {
  document.body.dataset.view = activeView();
  for (const l of viewListeners) l(activeView());
}

/** Open a panel, or -- for `arrange` -- close whichever is open. */
function showView(view: ViewName): void {
  if (view === 'arrange') {
    closePanel();     // its `close` event tells the listeners
    return;
  }
  if (openPanel === view) return;
  // One panel at a time: the one that was open goes first, quietly.
  if (openPanel) {
    const previous = panelOf(openPanel);
    openPanel = null;
    previous.close();
  }
  openPanel = view;
  const dialog = panelOf(view);
  dialog.show();
  scrim.hidden = false;
  dialog.querySelector<HTMLButtonElement>('[data-close]')?.focus({ preventScroll: true });
  viewChanged();
}

function closePanel(): void {
  if (openPanel) panelOf(openPanel).close();
}
for (const name of ['home', 'mixer', 'render', 'export', 'import', 'keyboard', 'bench'] as const) {
  const dialog = panelOf(name);
  dialog.querySelector('[data-close]')!.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    if (openPanel !== name) return;              // replaced by another, which is open now
    openPanel = null;
    scrim.hidden = true;
    viewChanged();
  });
}
scrim.addEventListener('click', closePanel);

/**
 * A panel's tabs (`.panel-tabs`): each tab shows the panel its `aria-controls`
 * names and hides the others; left and right move along them, as a tab list's
 * do. Only the Export panel has them so far.
 */
for (const list of document.querySelectorAll<HTMLElement>('.panel-tabs')) {
  const tabs = [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const select = (tab: HTMLButtonElement) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      $(t.getAttribute('aria-controls')!).hidden = !on;
    }
  };
  for (const tab of tabs) tab.addEventListener('click', () => select(tab));
  list.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const at = tabs.indexOf(document.activeElement as HTMLButtonElement);
    const next = tabs[(at + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    select(next);
    next.focus();
  });
}
// Esc closes the panel, when nothing else on top of it has taken the key: a
// menu, the volume and the modal dialogs each stop their own Esc.
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !openPanel || event.defaultPrevented) return;
  if (document.querySelector('dialog[open]:not(.view-panel)')) return;
  closePanel();
});
// The mixer has a button of its own beside the volume: it opens the panel,
// closes it, and stays lit while it is open.
const mixerButton = $<HTMLButtonElement>('mixerButton');
mixerButton.addEventListener('click', () => (openPanel === 'mixer' ? closePanel() : showView('mixer')));
viewListeners.add((view) => mixerButton.setAttribute('aria-pressed', String(view === 'mixer')));
/** A song just opened from the home panel: show it. Under any other panel it stays where it is. */
const leaveHome = () => { if (openPanel === 'home') closePanel(); };
// The brand is the way to the home panel: a presentation, over the song that
// stays open -- not a reload, which would lose it.
$('brand').addEventListener('click', (event) => {
  event.preventDefault();
  showView('home');
});
$('homeOpen').addEventListener('click', () => $<HTMLDialogElement>('fileDialog').showModal());

/**
 * A button that opens a panel under it in the top bar: a menu. A click elsewhere or Esc closes it, and Esc gives the focus back to the
 * button. ❗ Esc stops here: the arranger's own Esc closes the note panel, and
 * one key must not do both. Returns the close, for a menu item that acts.
 */
function popover(button: HTMLButtonElement, panel: HTMLElement, onOpen: () => void): () => void {
  const close = () => {
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  };
  button.addEventListener('click', () => {
    if (!panel.hidden) return close();
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    onOpen();
  });
  document.addEventListener('pointerdown', (event) => {
    const target = event.target as Node;
    if (!panel.hidden && !panel.contains(target) && !button.contains(target)) close();
  });
  // Enter and Space press the item under the focus, not the transport's keys
  // (Enter seeks to the start, Space plays) -- which would cancel the press.
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
  });
  for (const el of [button, panel]) {
    el.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || panel.hidden) return;
      event.stopPropagation();
      close();
      button.focus();
    });
  }
  return close;
}

// ----------------------------------------------------------------- transport

const playButton = $<HTMLButtonElement>('play');
const stopButton = $<HTMLButtonElement>('stop');
const loopButton = $<HTMLButtonElement>('loop');
const metronomeButton = $<HTMLButtonElement>('metronome');
const metronome = new Metronome(player);
const clockLabel = $<HTMLSpanElement>('clock');
const whereLabel = $<HTMLSpanElement>('where');
const loadLabel = $<HTMLSpanElement>('load');
const volSlider = $<HTMLInputElement>('vol');
const tempoBox = $<HTMLInputElement>('tempoBox');

let health: Health = {
  sounding: 0, notes: 0, queued: 0, audioLoad: null, dropouts: 0, lostMs: 0, agcGain: null,
};
/**
 * When the meter turns yellow: half a core on average. ❗ A decision, not a
 * measurement -- sound was first lost at a reading of 93 % on the machine it
 * was tried on, and a song's busy passage can sit well above its five-second
 * average. See *The "audio %" figure* in `steering/tracker-architecture.md`.
 */
const BUSY_LOAD = 0.5;
/** How long the meter stays red after a dropout: a moment's trouble is not the whole song's. */
const DROPOUT_RED_MS = 10_000;
let dropoutsSeen = 0;
let lastDropoutAt = -Infinity;

/**
 * The footer's readout: `17 notes · CPU 6%`, like a DAW's CPU meter.
 *
 * ❗ **One number, and the rest on hover.** It read `audio 6%, peak <30% · no
 * dropouts` for a day, which was all true and which the owner found
 * unreadable (2026-10-04): the figure is the average (`LoadMeter`), the colour
 * says whether to worry, and the sound lost is in the tooltip. Dropouts appear
 * in the text only when there are some, because then they are the news.
 */
function showLoad(): void {
  const { sounding, notes, queued, audioLoad, dropouts, lostMs } = health;
  if (dropouts > dropoutsSeen) lastDropoutAt = performance.now();
  dropoutsSeen = dropouts;
  if (!player.playing && sounding === 0 && queued === 0) {
    loadLabel.textContent = player.hasPlan ? 'ready' : 'idle';
    loadLabel.className = '';
    loadLabel.title = '';
    return;
  }
  // Whole percent: the average is good to about half a point.
  const pct = (share: number) => (share < 0.005 ? '<1%' : `${Math.round(share * 100)}%`);
  const cpu = audioLoad === null ? '' : ` · CPU ${pct(audioLoad)}`;
  const dropped = dropouts === 0 ? '' : ` · ${dropouts} dropout${dropouts === 1 ? '' : 's'}`;
  loadLabel.textContent = `${notes} notes${cpu}${dropped}`;
  const recentDropout = performance.now() - lastDropoutAt < DROPOUT_RED_MS;
  const busy = (audioLoad ?? 0) >= BUSY_LOAD;
  loadLabel.className = recentDropout ? 'bad' : busy ? 'busy' : '';
  loadLabel.title = [
    audioLoad === null
      ? 'Audio engine: measuring…'
      : `Audio engine: ${pct(audioLoad)} of one CPU core, averaged over the last 5 seconds.`,
    // ❗ Measured against Windows' own count of the audio thread's time: 11.6 %
    // where this said 8.0 % on `Rotary`, 3.9 % where it said 1.8 % on
    // `Ascetic` (2026-10-04). The rest is the browser's, on the same thread,
    // and nothing inside the worklet can time it -- see `LoadMeter`.
    audioLoad === null ? null : 'The browser’s own audio work on the same thread adds a few points more.',
    dropouts === 0
      ? 'No dropouts since play.'
      : `${dropouts} dropout${dropouts === 1 ? '' : 's'} since play, ${Math.round(lostMs)} ms of sound lost.`,
    `${notes} notes sounding.`,
  ].filter(Boolean).join('\n');
}
/**
 * The display: bar.beat first, because the board is read in bars -- four beats
 * to a bar as the metronome accents them -- and then the time and the length.
 */
function paintClock(): void {
  const beat = Math.floor(player.stepAt(player.position()) / STEPS_PER_BEAT + 1e-6);
  whereLabel.textContent = `${Math.floor(beat / 4) + 1}.${(beat % 4) + 1}`;
  clockLabel.textContent = `${clock(player.position() / RATE)} / ${clock(player.songSeconds)}`;
}
onPlayer({
  health: (h) => {
    health = h;
    showLoad();
  },
  tick: paintClock,
  playing: (on) => {
    playButton.textContent = on ? '⏸' : '▶';
    playButton.setAttribute('aria-label', on ? 'Pause' : 'Play');
    metronome.playing(on);
    showLoad();
  },
});
// The metronome is ours and per viewer (kept in the browser, not in the song):
// a click on every beat while the transport runs.
metronomeButton.setAttribute('aria-pressed', String(metronome.enabled));
metronomeButton.addEventListener('click', () => {
  metronome.enabled = !metronome.enabled;
  metronomeButton.setAttribute('aria-pressed', String(metronome.enabled));
});
onPlan(() => {
  playButton.disabled = false;
  stopButton.disabled = false;
  paintClock();
  showLoad();
});
playButton.addEventListener('click', () => (player.playing ? player.stop() : player.play()));
// Stop: silence, and back to the start -- a stop, not a pause; the pause is
// the play button pressed again.
stopButton.addEventListener('click', () => {
  // Stop drops the chip loop too: what plays next is the song from the top.
  window.dispatchEvent(new Event('lbp:stop'));
  player.stop();
  player.seek(0);
  // Back at the start: the views that follow go back with it (`arrange.ts`).
  window.dispatchEvent(new Event('lbp:stopped'));
});
// Loop is the song's own flag -- the same one the Song/Mixer view ticks -- so
// the button edits the song, and the header pass mirrors it into the player.
loopButton.addEventListener('click', () => {
  state.edit('selection', (s) => { s.loop = !s.loop; });
});
// The fader lies over the level meter (`daw.css`), so its number is in the tooltip.
const setVolume = () => {
  player.setVolume(Number(volSlider.value));
  const pct = `${Math.round(Number(volSlider.value) * 100)}%`;
  volSlider.title = `Volume ${pct}`;
  volSlider.setAttribute('aria-valuetext', pct);
};
volSlider.addEventListener('input', setVolume);
setVolume();

/**
 * The VU meter: two bars, left over right, the output's peak after the master
 * fader on a -60..0 dB scale, with a peak-hold mark that falls back. Drawn
 * every frame once the audio exists; reading two analysers is nothing.
 */
const vu = $<HTMLCanvasElement>('vu');
const vuCtx = vu.getContext('2d')!;
const held = [0, 0];
const shown = [0, 0];
function drawVu(): void {
  const peaks = player.peaks();
  const { width, height } = vu;
  vuCtx.clearRect(0, 0, width, height);
  // Two bars with a gap between them: 6 canvas pixels, 3 on screen, since the
  // canvas is drawn at twice the 16 px it is shown at.
  const gap = 6;
  const h = (height - gap) / 2;
  // The two empty tracks, so the meter -- which has no box of its own -- is
  // there to aim the volume at while nothing plays.
  vuCtx.fillStyle = '#272d37';
  for (let i = 0; i < 2; i += 1) vuCtx.fillRect(0, i * (h + gap), width, h);
  if (peaks) {
    peaks.forEach((peak, i) => {
      // Amplitude to a bar: -60 dB is empty, 0 dB is full.
      const db = peak > 0 ? 20 * Math.log10(peak) : -120;
      const level = Math.max(0, Math.min(1, (db + 60) / 60));
      // The bar falls a little slower than the signal; the hold mark slower still.
      shown[i] = Math.max(level, shown[i] - 0.06);
      held[i] = Math.max(shown[i], held[i] - 0.01);
      const y = i * (h + gap);
      const w = Math.round(shown[i] * width);
      const grad = vuCtx.createLinearGradient(0, 0, width, 0);
      grad.addColorStop(0, '#6fd3a0');
      grad.addColorStop(0.75, '#e3b341');
      grad.addColorStop(1, '#ef6b6b');
      vuCtx.fillStyle = grad;
      vuCtx.fillRect(0, y, w, h);
      if (held[i] > 0.01) {
        vuCtx.fillStyle = held[i] > 0.98 ? '#ef6b6b' : '#e8eaee';
        vuCtx.fillRect(Math.min(width - 2, Math.round(held[i] * width) - 1), y, 2, h);
      }
    });
  }
  requestAnimationFrame(drawVu);
}
drawVu();

tempoBox.addEventListener('change', () => {
  const tempo = Math.max(20, Math.min(400, Math.round(Number(tempoBox.value)) || state.song.tempo));
  tempoBox.value = String(tempo);
  if (tempo !== state.song.tempo) state.edit('settings', (s) => { s.tempo = tempo; }, 'tempo');
});

// ---------------------------------------------------------------- the title

const songName = $<HTMLSpanElement>('songNameText');
const nameField = $<HTMLInputElement>('songEditName');
const authorField = $<HTMLInputElement>('songEditAuthor');
const songAuthor = $<HTMLSpanElement>('songAuthor');
const dirty = $<HTMLSpanElement>('dirty');
function refreshHeader(): void {
  loopButton.setAttribute('aria-pressed', String(state.song.loop));
  player.loop = state.song.loop;
  songName.textContent = state.song.name || 'untitled';
  // `textContent`, never markup: an author is a string out of somebody's file.
  songAuthor.textContent = state.song.author ? `by ${state.song.author}` : '';
  songAuthor.hidden = !state.song.author;
  if (document.activeElement !== tempoBox) tempoBox.value = String(state.song.tempo);
  dirty.hidden = !state.dirty;
  document.title = `LBP Tracker${state.dirty ? ' •' : ''} · ${state.song.name || 'untitled'}`;
}
state.onChange(refreshHeader);

// A click on the name opens its editor: the name and the author, each an edit
// of the song as it is typed, undone in one step per field.
const closeSongEdit = popover($<HTMLButtonElement>('songTitle'), $('songEdit'), () => {
  nameField.value = state.song.name;
  authorField.value = state.song.author;
  nameField.select();
});
authorField.maxLength = AUTHOR_MAX;
nameField.addEventListener('input', () => {
  state.edit('selection', (s) => { s.name = nameField.value; }, 'name');
});
/*
 * The author, as a PSN handle can hold it.
 *
 * ⚠️ **The field is put back to what was kept**, not left showing what was
 * typed: a character a handle cannot hold changes nothing in the song, and the
 * field would go on showing it -- and the exported plan would then disagree
 * with the screen.
 */
authorField.addEventListener('input', () => {
  const clean = authorHandle(authorField.value);
  if (authorField.value !== clean) authorField.value = clean;
  state.edit('look', (s) => { s.author = clean; }, 'author');
});
// Enter is done.
for (const field of [nameField, authorField]) {
  field.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    closeSongEdit();
    $('songTitle').focus();
  });
}

// ----------------------------------------------------------------- the files

/** What a level gave us, by the picker's key. Picking one makes it the song. */
let songs = new Map<string, Sequencer>();
const fileDialog = $<HTMLDialogElement>('fileDialog');
$('fileClose').addEventListener('click', () => fileDialog.close());
fileDialog.addEventListener('click', (event) => {
  if (event.target === fileDialog) fileDialog.close();
});

/**
 * The rows behind the picker, kept so a link can name one of them.
 *
 * ❗ **A song's name in a link is its uid**, and `link.ts` says why the file
 * sometimes has to go with it. `unique` is read once per open rather than per
 * pick: it is a property of the pile that was opened.
 */
let pickerRows: { key: string; uid: number }[] = [];
let uidIsUnique = true;

/** The song on screen, so picking it again is a dismissal rather than a reload. */
let openKey = '';

const chose = (key: string): void => {
  openKey = key;
  rememberSequencer(pickerRows.find((r) => r.key === key), uidIsUnique);
};

// ❗ **Mounted before the picker, which lives inside it** (the "this level"
// tab). `openLevel` reaches `picker` only after a fetch or a read has been
// awaited, so the links this starts cannot meet it uninitialised.
const drop = mountOpen('#open', { onOpen: (opened) => openLevel(opened) });

const picker = seqPicker(drop.seqHost, async (key) => {
  const seq = songs.get(key);
  if (!seq) return;
  // ❗ **Picking the song already open just closes the picker.** It is a
  // dismissal, not a choice: opening it again would ask about unsaved changes
  // and then throw away the edit the person is in the middle of, for a click
  // that asked for nothing.
  if (key === openKey) {
    fileDialog.close();
    return;
  }
  if (state.dirty && !(await confirmDialog('Throw away the unsaved changes?', 'throw them away'))) return;
  // Another song of the same level brings its own instruments, and loading
  // them is the same wait as the first song's.
  const job = loading(`Opening “${seq.name || 'untitled'}”`);
  job.plan(PLAN_STEPS);
  try {
    openSong(songFromSequencer(seq), `opened "${seq.name}"`);
    chose(key);
    fileDialog.close();
    await planned(job);
  } finally {
    job.done();
  }
}, {
  // ❗ **Only a level from the online archive or Bonsai has a link**, which is
  // why this lives in the picker and not in the top bar beside the song's name:
  // the button is there when the songs on screen came from somewhere anybody
  // can fetch them, and gone otherwise. `setLinkable` below follows each open.
  // ⚠️ **A copy can be refused and the reader must still get the link.**
  // `navigator.clipboard.writeText` is denied outright in some contexts -- an
  // embedded browser with no clipboard permission is one, measured -- so this
  // reports what happened instead of throwing, and the picker shows the URL to
  // copy by hand when it could not do it.
  onLink: async (key) => {
    const url = songLink(pickerRows.find((r) => r.key === key), uidIsUnique);
    if (!url) throw new Error('this song has no link');
    const copied = await copyText(url);
    if (copied) setStatus('link copied');
    return { url, copied };
  },
});


/**
 * Put text on the clipboard, saying whether it went.
 *
 * ❗ **Two routes, because the first one is not always allowed.**
 * `navigator.clipboard` needs a secure context, a user gesture and a permission
 * the embedder can withhold; `execCommand('copy')` is deprecated and works in
 * places the other does not. Neither is guaranteed, so this reports rather than
 * throwing and the caller has a way to show the text.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fall through to the old route.
  }
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.cssText = 'position:fixed;top:-1000px;opacity:0';
  document.body.append(field);
  field.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    field.remove();
  }
}

/** Wait for the song just opened to be playable, saying so on `job`. */
async function planned(job: LoadingJob): Promise<void> {
  job.step('instruments', 'loading instruments…');
  await whenPlanned((step, fraction, text) => {
    job.step(step, text);
    job.progress(fraction);
  });
}

async function openLevel(opened: Opened): Promise<void> {
  setError('');
  drop.busy(true);
  setStatus(`reading ${opened.label}…`);
  // ❗ **The loader is the only thing a reader sees on some routes.** The drop
  // zone's own title lives inside `#fileDialog`, and a `?level=` link or a drop
  // on the home screen never opens that dialog; reading a big backup is
  // seconds. See `widgets/loading.ts`.
  const job = loading(`Reading ${opened.label}`);
  job.plan(OPEN_STEPS);
  job.step('assets', 'reading the list of the game’s instruments…');
  // ❗ **The URL stops claiming a level that is not this one.** The archive and
  // Bonsai routes have already written the level's name there
  // (`rememberLevel`); every other route is opening something nobody else can
  // fetch, and a link left over from a previous open would be a link to the
  // wrong song.
  if (!opened.link) forgetLevel();
  else demoLanded = true;
  try {
    await ensureAssets();
    job.step(
      'read',
      opened.files.length > 1
        ? `unpacking ${opened.files.length} resources and finding the songs…`
        : 'unpacking the level and finding the songs…',
    );
    // Reading a level is all script: let the line reach the screen first.
    await paint();
    const only = opened.files.length === 1 ? opened.files[0] : undefined;
    // One of our own song files opens as the song it holds -- ids, names and
    // grid lengths intact -- rather than through the sequencer it also is.
    if (only && isSongFile(only)) {
      openSong(songFromJson(new TextDecoder().decode(only.bytes)), `opened ${only.name}`);
      leaveHome();
      await planned(job);
      drop.loaded(true);
      drop.say(only.name);
      songs = new Map();
      pickerRows = [];
      picker.setRows([]);
      picker.setLinkable(false);
      fileDialog.close();
      return;
    }
    const result: BackupResult = await readOpened(opened.files);
    songs = new Map();
    for (const p of result.projects) {
      for (const sequencer of p.sequencers) songs.set(`${p.file}#${sequencer.uid}`, sequencer);
    }
    // `found` keeps the uid the picker's rows do not carry: it is what a link
    // names a song by (`link.ts`).
    const found = sequencersOf(result);
    const rows = found.map((r) => ({
      key: r.key,
      name: r.name,
      tracks: r.tracks,
      uid: r.uid,
      file: result.projects.length > 1 ? r.file : undefined,
    }));
    const first = picker.setRows(rows);
    picker.setLinkable(linkable());
    pickerRows = found.map((r) => ({ key: r.key, uid: r.uid }));
    uidIsUnique = new Set(pickerRows.map((r) => r.uid)).size === pickerRows.length;
    drop.loaded(true);
    drop.say(openedTitle(result, rows.length, opened.label));
    const note = saveNote(result);
    // ❗ **`?seq=<uid>` opens straight into one song of the level**, which is
    // what a link to a song has to do: a level holds sixteen of them and the
    // biggest one is rarely the one being shared. A uid that is not in this
    // level falls back to the first row rather than to nothing.
    const wanted = pickWanted(found, songFromQuery(window.location.search));
    const start = wanted?.key ?? first;
    if (start) {
      const seq = songs.get(start)!;
      if (wanted) picker.select(start);
      openSong(songFromSequencer(seq), `opened "${seq.name}"`);
      chose(start);
      leaveHome();
      await planned(job);
      // One song: nothing to choose, so the dialog can go. Several: the picker
      // is the point, and it is *put up* rather than merely left up, because
      // the route that most needs it never opened it -- a `?level=` link goes
      // straight from an empty page to a song, and the other fifteen in the
      // level would be invisible. A link that named one has chosen already.
      if (rows.length === 1 || wanted) fileDialog.close();
      else {
        drop.showLevel();
        if (!fileDialog.open) fileDialog.showModal();
      }
    } else if (note) setStatus(note, true);
    else if (result.failed.length) setStatus(`nothing to open: ${result.failed[0].why}`, true);
    else setStatus('no sequencers in there', true);
    if (result.failed.length > 0) {
      setError(result.failed.map((f) => `${f.name}: ${f.why}`).join('\n'));
    }
  } catch (error) {
    setStatus('failed', true);
    setError(String((error as Error).stack ?? error));
  } finally {
    drop.busy(false);
    job.done();
  }
}

const startNew = async () => {
  if (state.dirty && !(await confirmDialog('Throw away the unsaved changes?', 'throw them away'))) return;
  fileDialog.close();
  songs = new Map();
  pickerRows = [];
  picker.setRows([]);
  picker.setLinkable(false);
  // A new song is not the level in the address bar, and reloading the page must
  // not bring that level back over it.
  forgetLevel();
  openSong(newSong(), 'a new song');
  state.selection.cursor = { cell: 0, row: 0 };
  state.touch('selection');
  showView('arrange');
};
$('fileNew').addEventListener('click', () => void startNew());
$('homeNew').addEventListener('click', () => void startNew());

// ❗ **A demo is a link somebody pressed for you.** The song is named in the
// address bar first and then fetched by the route a `?level=&seq=` link takes
// (`link.ts`, `demo-songs.ts`), so it opens on that song, can be shared, and
// there is no second way in to keep working. Two buttons deal from the one
// deck -- the home view's and the open dialog's -- so neither can repeat what
// the other just played.
const nextDemo = demoDeck();
let demoLanded = false;
const playDemo = async () => {
  if (state.dirty && !(await confirmDialog('Throw away the unsaved changes?', 'throw them away'))) return;
  const demo = nextDemo();
  demoLanded = false;
  rememberSong(demo.level, demo.uid);
  await drop.openArchive(demo.level);
  // The archive's own complaint is written into a box inside the file dialog.
  const dialog = $<HTMLDialogElement>('fileDialog');
  if (!demoLanded && !dialog.open) dialog.showModal();
};
$('homeDemo').addEventListener('click', () => void playDemo());
$('fileDemo').addEventListener('click', () => void playDemo());

function saveSong(): void {
  const name = saveSongFile(state.song);
  state.dirty = false;
  refreshHeader();
  setStatus(`saved ${name}`);
}

// ----------------------------------------------------------------- the menus

/**
 * File, Edit, Tools, Help: a desktop application's menu bar. An item
 * names what it does in `data-action`, `data-edit` (the arranger's own edit,
 * the one its key takes) or `data-help` (which `help.ts` catches on the
 * document).
 */
const menuActions: Record<string, () => void> = {
  new: () => void startNew(),
  open: () => fileDialog.showModal(),
  save: saveSong,
  home: () => showView('home'),
  'view:render': () => showView('render'),
  'view:export': () => showView('export'),
  'view:import': () => showView('import'),
  'view:keyboard': () => showView('keyboard'),
  'view:bench': () => showView('bench'),
};

/** What the Edit menu can do now: undo and redo always, the rest on the board with no panel over it. */
function paintEditMenu(list: HTMLElement): void {
  const onBoard = openPanel === null;
  for (const item of list.querySelectorAll<HTMLButtonElement>('[data-edit]')) {
    const action = item.dataset.edit;
    item.disabled = action === 'undo' ? !state.canUndo : action === 'redo' ? !state.canRedo : !onBoard;
  }
}

const menus = [...document.querySelectorAll<HTMLElement>('.menu-wrap')].map((wrap) => {
  const button = wrap.querySelector<HTMLButtonElement>('.menu-button')!;
  const list = wrap.querySelector<HTMLElement>('[role="menu"]')!;
  const items = () => [...list.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
  const close = popover(button, list, () => {
    paintEditMenu(list);
    items()[0]?.focus();
  });
  list.addEventListener('click', (event) => {
    const item = (event.target as Element).closest<HTMLButtonElement>('[role="menuitem"]');
    if (!item || item.disabled) return;
    close();
    if (item.dataset.action) menuActions[item.dataset.action]?.();
    else if (item.dataset.edit) arrange.edit(item.dataset.edit as EditAction);
  });
  return { button, list, close };
});
menus.forEach(({ button, list, close }, index) => {
  // Up and down move along the items, left and right to the next menu, as a menu bar's do.
  list.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      close();
      menus[(index + (event.key === 'ArrowRight' ? 1 : -1) + menus.length) % menus.length].button.click();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = [...list.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    items[(at + step + items.length) % items.length].focus();
  });
  // With one menu open, the pointer moving onto another opens that one instead.
  button.addEventListener('pointerenter', () => {
    const open = menus.find((m) => m.button !== button && !m.list.hidden);
    if (!open) return;
    open.close();
    button.click();
  });
});

/**
 * Unsaved work stands in the way of closing the tab: the browser asks first.
 *
 * ⚠️ **Both signals, or it is silent somewhere.** `preventDefault()` is what
 * the standard asks for and what Chrome takes; Safari and older browsers only
 * look at the legacy `returnValue`, and setting it costs nothing. The browser
 * writes its own wording either way, and it only asks at all once the page has
 * been interacted with, which editing a song is.
 */
window.addEventListener('beforeunload', (event) => {
  if (!state.dirty) return;
  event.preventDefault();
  event.returnValue = '';
});

// --------------------------------------------------------------- the views

const isActive = (view: ViewName) => () => activeView() === view;
// The board's playheads run under a panel too; its keys only while nothing is open over it.
const arrange = mountArrange({
  isActive: () => true,
  ownsKeys: () => openPanel === null,
});
mountMixer();
mountRender({ isActive: isActive('render') });
mountConvert({ isActive: isActive('export'), onShow: (l) => viewListeners.add((v) => v === 'export' && l()) });
mountKeyboard({ isActive: isActive('keyboard'), onShow: (l) => viewListeners.add((v) => v === 'keyboard' && l()) });
// The keyboard's media keys and the system's own transport, if the browser has them.
mountMediaKeys();

/**
 * The transport's keys, from any view but a text field.
 *
 * The set a DAW's hands already know: space plays and pauses **where it is**
 * (`player.stop` keeps the position; only the stop button rewinds), Home and
 * Enter go back to the start, End goes to the song's end, and Ctrl+S saves.
 *
 * ⚠️ **Letters stay out of here.** The Keyboard view plays notes on
 * `Z S X D C V G B H N J M , L .`, so a global `L` for loop or `M` for mute
 * would sound a note there instead. Those live in the arrange view's own
 * handler, which only answers while that view is shown.
 */
/*
 * Which kind of input the user is using, for the focus rings in `daw.css`.
 *
 * ❗ **`:focus-visible` alone is not enough here**: Chrome counts holding Shift
 * as keyboard use, so shift+drag on the board -- the marquee -- focuses the
 * grid *and* matches `:focus-visible`, leaving a ring behind on every gesture.
 * Capture phase, so a handler that stops the event cannot desynchronise this.
 */
document.addEventListener('pointerdown', () => {
  document.documentElement.dataset.pointer = '';
}, true);
document.addEventListener('keydown', () => {
  delete document.documentElement.dataset.pointer;
}, true);

window.addEventListener('keydown', (event) => {
  if (focusOwnsKeys(event)) return;
  if (event.ctrlKey || event.metaKey) {
    if (event.code !== 'KeyS' || event.shiftKey) return;
    event.preventDefault();          // the browser would offer to save the page
    saveSong();
    return;
  }
  if (!player.hasPlan) return;
  switch (event.code) {
    case 'Space':
      event.preventDefault();
      if (player.playing) player.stop();
      else player.play();
      return;
    case 'Home':
    case 'Enter':
    case 'NumpadEnter':
      // Back to the top, and still playing if it was: a DAW does not stop
      // because you asked it where the start is.
      event.preventDefault();
      player.seek(0);
      return;
    case 'End':
      event.preventDefault();
      player.seek(player.frameAt(songEndSteps(state.song)));
      return;
    default:
  }
});

// The arrange view is fixed between the bar and the footer, whose heights
// depend on wrapping; measure them and hand them to the CSS.
const measureChrome = () => {
  const top = document.querySelector<HTMLElement>('.daw-top')?.offsetHeight ?? 0;
  const foot = document.querySelector<HTMLElement>('.daw-foot')?.offsetHeight ?? 0;
  document.documentElement.style.setProperty('--top-h', `${top}px`);
  document.documentElement.style.setProperty('--foot-h', `${foot}px`);
};
new ResizeObserver(measureChrome).observe(document.querySelector('.daw-top')!);
new ResizeObserver(measureChrome).observe(document.querySelector('.daw-foot')!);
measureChrome();

// ---------------------------------------------------------------- start up

// The site opens on the home view, over an empty song; opening or starting
// one moves to the arranger. The view is not remembered across loads.
showView('home');
refreshHeader();
void ensureAssets().catch((error: unknown) => {
  setStatus('the game\'s instruments are not available: extract them first', true);
  setError(String((error as Error).stack ?? error));
});
// The sequencer's thermometer needs every instrument's sample list; without the assets it stays hidden.
void loadThermometer().catch(() => undefined);
mountFooter($('view-home'));
mountHelp();

// The service worker: the site installs as an app, and opens without a
// network. Not on the dev server, where it would sit between Vite and the
// page for no gain. See `public/sw.js` for why it is network-first.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js').catch(() => {
      // No worker: the app runs as it always did, online only.
    });
  });
}
$('version').textContent = `v${APP_VERSION}`;

// Everything a console session needs to poke the app, as the bench does.
(window as unknown as { __lbpEditor: unknown }).__lbpEditor = {
  state, player, board: arrange.board, roll: arrange.roll, showView,
};
