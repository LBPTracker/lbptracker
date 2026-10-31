/**
 * The open dialog's "online archive" tab: a level out of the Internet Archive.
 *
 * "Open a file" and "open a folder" both assume a listener already has a PS3
 * backup. Most do not. The official servers are gone, but every level published
 * to them survives in an archive indexed by <https://zaprit.fish>, and a root
 * level fetched from there is exactly the resource `../cwlib-ts/src/things/level.ts` already
 * reads -- so this ends in the same `onOpen` as a dropped file, with the same
 * bytes in the same reader.
 *
 * ❗ **One field, and it takes a hash.** The listener searches on zaprit.fish
 * itself -- a real search, with icons and hearts and everything this box would
 * only have imitated -- and copies the 40 hex digits from the level's page.
 * `rootLevelUrl` is a pure function of those digits and archive.org answers any
 * origin, so **nothing here needs a server**: not the dev server, not a proxy,
 * not anything. That is the whole reason the box is shaped like this; see
 * `packages/lbp-tracker-web/src/lbparchive.ts` for what was measured and what was removed.
 *
 * ❗ **The level's own name is put in the DOM as text, never as markup** -- it
 * comes out of a resource somebody wrote in 2011 and arrived over the network.
 */

import { createApp, h, reactive } from 'vue';
import ArchivePanel from './widgets/ArchivePanel.vue';
import { readPaste, rootLevelUrl, SEARCH_HOST } from './lbparchive.ts';
import { rememberLevel } from './link.ts';
import { bodyBytes, loading, sizeText, type LoadingJob } from './widgets/loading.ts';
import { mustWalk, walkNote, walkParts } from './resource-walk.ts';
import { FETCH_SECONDS, OPEN_SECONDS, WALK_SECONDS, type Opened } from './open-level.ts';
import type { Credit } from './song-index.ts';

/**
 * How many resources one paste may pull in, and how many at a time.
 *
 * What the walk follows, and why only that, is in `resource-walk.ts`.
 *
 * The cap is a guard against a level that references half the archive, not a
 * measured limit: "Music Gallery #3" needs 17, and an adventure map's levels and
 * chunks together came to 25.
 */
const RESOURCE_LIMIT = 250;
const AT_A_TIME = 6;

/** What a wired panel lets the page do without the reader touching it. */
export interface ArchiveOpen {
  /**
   * Open a root level by its SHA-1, as if it had been pasted into the box.
   *
   * `report`, when given, hears every line the box would say, and a failure
   * then stays where it was asked for: the song index shows it in its own
   * pane. Without it, a failure brings the archive's tab forward, or a hash
   * from a link that 404s reports itself into a tab nobody is looking at.
   * `credit` goes on to the `Opened` as it came.
   */
  open(sha1: string, opts?: { deep?: boolean; report?: Report; credit?: Credit }): Promise<void>;
  /** The tab has come into view: put the cursor in the field. */
  shown(): void;
}

/** A line about an open in progress, and whether it is a complaint. */
export type Report = (text: string, bad: boolean) => void;

/**
 * Build the panel into `host`, a tab of the open dialog.
 *
 * `onOpen` gets the same shape a dropped file produces, so a page needs no new
 * code path: the level arrives as one `BackupFile` named after its SHA-1, which
 * is what it is called in a real backup too.
 */
export function wireArchiveOpen(opts: {
  host: HTMLElement;
  /** Select this panel's tab. */
  show: () => void;
  onOpen: (opened: Opened) => void | Promise<void>;
}): ArchiveOpen {
  const { host, show, onOpen } = opts;
  host.classList.add('archive');

  // The markup is `widgets/ArchivePanel.vue`; this keeps the state it binds to
  // and the logic that reads it. ❗ The panel used to be a 20-line `innerHTML`
  // string, which is why the note's default had to be read back out of the DOM.
  const ui = reactive({ query: '', deep: false, note: '', bad: false, busy: false });
  let focusField = () => {};
  createApp({
    render: () =>
      h(ArchivePanel, {
        searchHost: SEARCH_HOST,
        busy: ui.busy,
        query: ui.query,
        'onUpdate:query': (v: string) => (ui.query = v),
        deep: ui.deep,
        'onUpdate:deep': (v: boolean) => (ui.deep = v),
        note: ui.note,
        bad: ui.bad,
        onSubmit: () => void submit(),
        ref: (el: unknown) => {
          focusField = (el as { focus(): void } | null)?.focus.bind(el) ?? (() => {});
        },
      }),
  }).mount(host);

  let busy = false;
  /** Who else hears this open's lines, for as long as it runs. */
  let report: Report | undefined;

  const say = (text: string, bad = false) => {
    ui.note = text;
    ui.bad = bad;
    report?.(text, bad);
  };

  // ❗ **Progress goes to two places.** The panel's note is where a reader
  // who opened the box is looking; the loader is what everyone else sees,
  // including a `?level=` link that never opened the box at all. `job` runs for
  // as long as one open does (`widgets/loading.ts`), and the two lines are
  // worded for where they appear: the note sits under a field that already
  // holds the hash, the loader has to say what is going on from nothing.
  let job: LoadingJob | undefined;
  const progress = (note: string, loud = note) => {
    say(note);
    job?.note(loud);
  };

  /**
   * One resource out of the archive. Throws with something worth reading.
   * `onBytes` follows the body as it arrives, for the root's download.
   */
  async function grab(
    sha1: string,
    onBytes?: (got: number, total: number | undefined) => void,
  ): Promise<Uint8Array> {
    // ❗ `mode: 'cors'` is the default and is spelled out because it is the
    // property being relied on: archive.org echoes the asking origin, so this
    // works from a dev server, a static host or a file:// page alike.
    const answer = await fetch(rootLevelUrl(sha1), { mode: 'cors' });
    if (!answer.ok) {
      throw new Error(
        `the archive answered ${answer.status}; check the hash, or the archive `
        + 'may never have received this level',
      );
    }
    return onBytes ? bodyBytes(answer, onBytes) : new Uint8Array(await answer.arrayBuffer());
  }

  /**
   * Fetch a level and the plans it depends on, and hand the pile over.
   *
   * ❗ **This is the whole backup as far as the tracker is concerned**, and the
   * dependency table is what makes it possible without a server: a hashed
   * dependency is a *user* resource and lives in the archive under the same URL
   * as the level, while a GUID one is a game asset that is not in the archive at
   * all (140 of "Music Gallery #3"'s 160 dependencies are GUIDs).
   *
   * ❗ **The walk is a checkbox, off by default.** Measured on "Music Gallery
   * #3": the level plus its 17 plans took 10 s against 3 s for the level alone,
   * and gave 46 sequencer rows instead of 31 — but **16 distinct songs either
   * way**, every plan being a copy of a song already placed in the level. So on
   * most levels it is seven seconds and fifteen duplicate rows for nothing,
   * which is why it is off; the one thing it can find that the level cannot, a
   * song living only as a plan, is one tick away and `?deep=1` in a link.
   * ⚠️ Except when the root cannot be opened at all: see `mustWalk`.
   */
  async function open_(sha1: string, deep = ui.deep, credit?: Credit): Promise<void> {
    if (busy) return;
    busy = true;
    ui.busy = true;
    ui.query = sha1;
    ui.deep = deep;
    job = loading(`Opening ${sha1.slice(0, 8)}… from the archive`);
    // The bar's weights (`widgets/loading.ts`): `open` is the read and the plan
    // `openLevel` does after, as a step of this job.
    const fetchStep = { key: 'fetch', seconds: FETCH_SECONDS };
    const openStep = { key: 'open', seconds: OPEN_SECONDS };
    job.plan([fetchStep, openStep]);
    progress(`fetching ${sha1.slice(0, 8)}…`, 'asking archive.org for the level…');
    try {
      const root = {
        sha1,
        bytes: await grab(sha1, (got, total) => job?.progress(
          total ? Math.min(1, got / total) : null,
          `downloading the level: ${sizeText(got)}${total ? ` of ${sizeText(total)}` : ''}…`,
        )),
      };
      // ❗ **Read once, at the start.** Ticking the box while eighteen fetches
      // are in flight must not change what this open is doing halfway through.
      const walking = mustWalk(root.bytes, deep);
      if (walking) {
        job.plan([fetchStep, { key: 'walk', seconds: WALK_SECONDS }, openStep]);
        job.step('walk', 'looking for the plans and chunks it depends on…');
      }
      const walked = walking
        ? await walkParts({
          root,
          grab,
          limit: RESOURCE_LIMIT,
          atATime: AT_A_TIME,
          progress: (have, known) => {
            progress(`${have} of ${known} resources…`, `fetching what it depends on: ${have} of ${known} resources…`);
            job?.progress(have / Math.max(1, known));
          },
        })
        : { files: [{ name: sha1, bytes: root.bytes }], missing: 0, skipped: 0 };
      job.step('open', 'opening the level…');
      const note = walkNote(walked, 'in the archive');
      say(note, note !== '');
      // ❗ **The address bar becomes the link to share.** A level opened
      // from the archive is fully named by its hash, so writing it into the URL
      // costs one `replaceState` and gives the reader something to copy; the
      // walk goes with it because it changes what the link opens. See
      // `link.ts`.
      const link = { from: 'archive', sha1, deep } as const;
      rememberLevel(link);
      // No name to give it: naming levels is what the index does, and not
      // needing the index is the point. The songs carry their own titles anyway.
      await onOpen({
        // Files are named after their SHA-1, which is what a backup calls them.
        label: `root level ${sha1.slice(0, 8)}`,
        files: walked.files,
        many: walked.files.length > 1,
        link,
        credit,
      });
    } catch (error) {
      say(error instanceof Error ? error.message : String(error), true);
      if (!report) show();
    } finally {
      busy = false;
      ui.busy = false;
      report = undefined;
      job?.done();
      job = undefined;
    }
  }

  function submit(): void {
    if (busy) return;
    const pasted = readPaste(ui.query);
    if (pasted.kind === 'hash') {
      void open_(pasted.sha1);
    } else if (pasted.kind === 'link') {
      // The hash is on that page and the page cannot be read from here; saying
      // so beats a failed fetch that looks like the archive being down.
      say('that is a link to a level’s page: open it and copy the hash from it', true);
    } else if (ui.query.trim() === '') {
      focusField();
    } else {
      say('that is not a root level hash: it is 40 hex digits, from the level’s page', true);
    }
  }

  return {
    open: (sha1, o) => {
      if (busy) return Promise.resolve();
      report = o?.report;
      return open_(sha1.toLowerCase(), o?.deep ?? ui.deep, o?.credit);
    },
    shown: () => focusField(),
  };
}
