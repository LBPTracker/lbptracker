/**
 * The open dialog's first tab: find a song in the song index and open one of its
 * copies straight from the archive.
 *
 * The index is three kinds of static file under `fixtures/songindex/` (the
 * format is `song-index.ts`'s): `index.json`, read fresh every time because it
 * names the current export; that export's `songs.json`, loaded once when the
 * tab is first shown; and one detail file per 256th of the songs, loaded when
 * a song is picked and kept.
 *
 * ❗ **Opening is the archive's route, not a new one.** A variant or a level is
 * a SHA-1 and a uid, so this does what the demo button does: `rememberSong`
 * names the song in the address bar, then the archive panel fetches the
 * resource, and `openLevel` picks the song the link names. The address bar is
 * then the link to share, the same as for any level opened from the archive.
 * What the archive says while it works is reported here (`report`), beside
 * the copy that was asked for, so one that will not download leaves the
 * reader where another can be picked.
 */

import { createApp, h, reactive } from 'vue';
import SongIndexPanel from './widgets/SongIndexPanel.vue';
import { asset } from './assets.ts';
import { rememberSong } from './link.ts';
import type { Report } from './archive-panel.ts';
import {
  creditOf,
  detailFrom,
  INDEX_FORMATS,
  rowsFrom,
  searchSongs,
  shardFile,
  type Credit,
  type IndexHead,
  type SongColumns,
  type SongDetail,
  type SongFilter,
  type SongRow,
  type Target,
} from './song-index.ts';

const ROOT = 'fixtures/songindex';
/** Rows drawn at once; "more" adds as many again. A list of 33,000 buttons is not a list. */
const PAGE = 100;

export function wireSongIndex(opts: {
  host: HTMLElement;
  /** Fetch a resource from the archive, as a `?level=` link does, telling `report` how it goes. */
  openArchive: (sha1: string, report: Report, credit?: Credit) => Promise<void>;
}): { shown(): void } {
  const { host, openArchive } = opts;
  host.classList.add('archive', 'songindex-host');

  let head: IndexHead | undefined;
  let rows: SongRow[] = [];
  let loading: Promise<void> | undefined;
  const shards = new Map<string, Promise<Record<string, Parameters<typeof detailFrom>[0]>>>();

  const ui = reactive({
    note: '',
    bad: false,
    busy: false,
    ready: false,
    query: '',
    filter: { sort: 'levels', descending: true, minVariants: 0, minLevels: 0, year: 0 } as Omit<SongFilter, 'query'>,
    total: 0,
    shown: [] as SongRow[],
    limit: PAGE,
    chosen: undefined as SongRow | undefined,
    detail: undefined as SongDetail | undefined,
    detailNote: '',
    detailBad: false,
    generated: '',
  });

  let results: SongRow[] = [];
  const refresh = (keepLimit = false) => {
    if (!ui.ready) return;
    if (!keepLimit) ui.limit = PAGE;
    results = searchSongs(rows, { ...ui.filter, query: ui.query });
    ui.total = results.length;
    ui.shown = results.slice(0, ui.limit);
  };

  async function json<T>(path: string, fresh = false): Promise<T> {
    const answer = await fetch(asset(path), fresh ? { cache: 'no-cache' } : undefined);
    if (!answer.ok) throw new Error(`${answer.status} for ${path}`);
    return (await answer.json()) as T;
  }

  /** The list, once. A second call while the first is in flight waits for it. */
  function load(): Promise<void> {
    loading ??= (async () => {
      ui.note = 'loading the song index…';
      ui.bad = false;
      try {
        head = await json<IndexHead>(`${ROOT}/index.json`, true);
        if (!INDEX_FORMATS.includes(head.format)) {
          throw new Error(`the index is in format ${head.format}, and this page reads ${INDEX_FORMATS.join(' and ')}`);
        }
        rows = rowsFrom(await json<SongColumns>(`${ROOT}/${head.version}/songs.json`));
        ui.generated = head.generated.slice(0, 10);
        ui.ready = true;
        ui.note = '';
        refresh();
      } catch (error) {
        loading = undefined; // a later click tries again
        ui.bad = true;
        ui.note = `the song index is not available here: ${error instanceof Error ? error.message : error}`;
      }
    })();
    return loading;
  }

  async function pick(row: SongRow): Promise<void> {
    // The same row again is a no-op, unless its detail failed: then it is a retry.
    if (!head || (ui.chosen === row && ui.detail)) return;
    ui.chosen = row;
    ui.detail = undefined;
    ui.detailNote = '';
    ui.detailBad = false;
    const file = shardFile(row.id, head.shards);
    let shard = shards.get(file);
    if (!shard) {
      shard = json(`${ROOT}/${head.version}/${file}`);
      shards.set(file, shard);
    }
    try {
      const raw = (await shard)[row.id];
      if (ui.chosen !== row) return; // another song was picked meanwhile
      if (!raw) throw new Error(`song ${row.id} is not in ${file}`);
      ui.detail = detailFrom(raw);
    } catch (error) {
      shards.delete(file);
      if (ui.chosen !== row) return;
      // ❗ In the detail, where the reader is looking: the list's note sits
      // under the search field, and "loading its variants…" stayed up forever
      // when this went there.
      ui.detailBad = true;
      ui.detailNote = `its variants would not load: ${error instanceof Error ? error.message : error}`;
    }
  }

  async function open(target: Target): Promise<void> {
    if (ui.busy) return;
    ui.busy = true;
    ui.detailNote = '';
    ui.detailBad = false;
    try {
      // ❗ The song first, then the level: `rememberLevel` keeps a `seq` that
      // came with the same hash, which is what makes this the link route.
      rememberSong(target.sha1, target.uid);
      const credit = ui.chosen && creditOf(ui.chosen, target);
      await openArchive(target.sha1, (text, bad) => {
        ui.detailNote = text;
        ui.detailBad = bad;
      }, credit);
      // What is left after a good open is a progress line; a complaint stays.
      if (!ui.detailBad) ui.detailNote = '';
    } finally {
      ui.busy = false;
    }
  }

  let focusField = () => {};
  createApp({
    render: () =>
      h(SongIndexPanel, {
        ...ui,
        'onUpdate:query': (v: string) => {
          ui.query = v;
          refresh();
        },
        onFilter: (patch: Partial<SongFilter>) => {
          Object.assign(ui.filter, patch);
          refresh();
        },
        onMore: () => {
          if (ui.shown.length >= ui.total) return;
          ui.limit += PAGE;
          ui.shown = results.slice(0, ui.limit);
        },
        onPick: (row: SongRow) => void pick(row),
        onBack: () => {
          ui.chosen = undefined;
          ui.detail = undefined;
        },
        onOpen: (target: Target) => void open(target),
        ref: (el: unknown) => {
          focusField = (el as { focus(): void } | null)?.focus.bind(el) ?? (() => {});
        },
      }),
  }).mount(host);

  return { shown: () => void load().then(() => focusField()) };
}
