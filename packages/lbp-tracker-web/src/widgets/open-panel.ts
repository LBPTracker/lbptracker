/**
 * The open dialog's body, mounted: its tabs, the panels in them, and the
 * query routes that open a level without it.
 *
 * ⚠️ **Split from `open-level.ts` because a worker imports that file.**
 * `render-worker.ts` wants `openedTitle` and nothing else; when the mounting
 * lived beside it, the worker pulled in Vue and died on `document is not
 * defined` inside Vue's runtime. The build gives no warning about this at all.
 */

import { createApp, h } from 'vue';
import { wireArchiveOpen } from '../archive-panel.ts';
import { wireBonsaiOpen } from '../bonsai-panel.ts';
import { wireSongIndex } from '../song-index-panel.ts';
import { levelFromQuery } from '../link.ts';
import { asset } from '../assets.ts';
import { fromDrop, fromFiles, type Opened } from '../open-level.ts';
import OpenLevel, { type OpenTab } from './OpenLevel.vue';

/**
 * `?open=fixtures/levels/x.lvl` opens a file the site itself serves.
 *
 * ❗ **A development affordance, and the only way a browser driven by a script
 * can open a level**: a file input cannot be filled from a page, and every
 * check of these pages in an automated browser was stuck at the drop zone
 * until this existed. The path is resolved like an asset -- under the site
 * root, every segment encoded -- so it cannot reach outside it; on the deployed
 * site only `fixtures/rinst` and `fixtures/smp` exist, and anything else 404s
 * into the page's own error line.
 */
async function openFromQuery(give: (from: Promise<Opened | undefined>) => Promise<void>): Promise<void> {
  const wanted = new URLSearchParams(window.location.search).get('open');
  if (!wanted) return;
  await give((async () => {
    const response = await fetch(asset(wanted));
    if (!response.ok) throw new Error(`${response.status} fetching ${wanted}`);
    const name = wanted.slice(wanted.lastIndexOf('/') + 1);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { label: name, files: [{ name, bytes }], many: false };
  })());
}

export interface OpenPanel {
  /** The open level's name, over its songs in the "this level" tab. */
  say(title: string): void;
  /** Greyed out and inert while a level is being read. */
  busy(on: boolean): void;
  /** Whether something is open, which is what shows the "this level" tab. */
  loaded(on: boolean): void;
  /** Bring the "this level" tab forward: a level with several songs to pick from. */
  showLevel(): void;
  /** Where the song picker goes: inside the "this level" tab. */
  seqHost: HTMLElement;
  /** Fetch a root level from the public archive, as a `?level=` link does. */
  openArchive(sha1: string): Promise<void>;
}

/**
 * Call `shown` whenever `host` comes into view: its tab selected, or the dialog
 * it is in opened on that tab.
 *
 * ❗ **One observer rather than a hook on every way a pane can appear.** A tab
 * click, the dialog's `showModal()` from four places in `daw.ts` and a failed
 * open bringing its tab forward all end with the pane visible, and this is the
 * one thing all of them have in common.
 */
function whenShown(host: HTMLElement, shown: () => void): void {
  new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) shown();
  }).observe(host);
}

/**
 * Mount the open dialog's body and wire it to one handler.
 *
 * ❗ **The markup is the component's, not the page's**; see
 * `widgets/OpenLevel.vue`. A page supplies an empty element and this returns
 * the few things it actually drives.
 */
export function mountOpen(
  at: string | Element,
  opts: { onOpen: (opened: Opened) => void | Promise<void> },
): OpenPanel {
  const give = async (from: Promise<Opened | undefined>) => {
    const opened = await from;
    if (opened && opened.files.length > 0) await opts.onOpen(opened);
  };

  // ⚠️ The type is named rather than inferred from the holder: `as typeof panel`
  // inside the ref callback resolves to `null`, and every property read off it
  // then fails with "does not exist on type 'never'".
  interface Mounted {
    say(title: string): void;
    setBusy(on: boolean): void;
    setLoaded(on: boolean): void;
    select(tab: OpenTab): void;
    seqHost: HTMLElement | null;
    archiveHost: HTMLElement | null;
    bonsaiHost: HTMLElement | null;
    songsHost: HTMLElement | null;
  }
  const held: { ui: Mounted | null } = { ui: null };

  createApp({
    render: () =>
      h(OpenLevel, {
        onFiles: (files: File[]) => void give(fromFiles(files)),
        onDrop: (transfer: DataTransfer) => void give(fromDrop(transfer)),
        ref: (el: unknown) => {
          held.ui = el as Mounted | null;
        },
      }),
  }).mount(at as Element);

  const ui = held.ui!;
  const { seqHost, archiveHost, bonsaiHost, songsHost } = ui;
  if (!seqHost || !archiveHost || !bonsaiHost || !songsHost) throw new Error('the open dialog did not mount');

  const archive = wireArchiveOpen({
    host: archiveHost,
    show: () => ui.select('archive'),
    onOpen: opts.onOpen,
  });
  const bonsai = wireBonsaiOpen({
    host: bonsaiHost,
    show: () => ui.select('bonsai'),
    onOpen: opts.onOpen,
  });
  // ❗ The index opens through the archive's route, and says how it went in its
  // own pane: `report` keeps the archive's tab where it is, so the reader can
  // pick another copy when one will not download.
  const songs = wireSongIndex({
    host: songsHost,
    openArchive: (sha1, report) => archive.open(sha1, { deep: false, report }),
  });
  whenShown(archiveHost, archive.shown);
  whenShown(bonsaiHost, bonsai.shown);
  whenShown(songsHost, songs.shown);

  // ❗ **`?level=<sha1>` and `?bonsai=<number>` are the shareable links to a
  // song**, and they are handled here rather than in the panels so that every
  // query route is in one place. Neither is the same thing as `?open=`: that
  // one fetches a file this site serves, these fetch a published level from
  // archive.org or from Bonsai. See `link.ts` for the whole of what a URL may
  // say.
  const wanted = levelFromQuery(window.location.search);
  if (wanted?.from === 'archive') void archive.open(wanted.sha1, { deep: wanted.deep });
  if (wanted?.from === 'bonsai') void bonsai.open(wanted.id, { deep: wanted.deep });

  void openFromQuery(give);

  return {
    say: (title) => ui.say(title),
    busy: (on) => ui.setBusy(on),
    loaded: (on) => ui.setLoaded(on),
    showLevel: () => ui.select('level'),
    seqHost,
    openArchive: (sha1) => archive.open(sha1, { deep: false }),
  };
}
