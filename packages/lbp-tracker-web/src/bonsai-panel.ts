/**
 * The fourth way to open a song: a level off Bonsai.
 *
 * The archive panel (`archive-panel.ts`) opens what Mm's servers held until
 * 2021; this opens what has been published since, to the community server LBP
 * moved to. A level fetched from Bonsai is the same resource a backup holds, so
 * this ends in the same `onOpen` as a dropped file, with the same bytes in the
 * same reader.
 *
 * ❗ **Nothing here needs a server of ours.** Bonsai's API answers any origin
 * (measured, see `bonsai.ts`), so the search, the level's metadata and every
 * resource are asked for by the page itself, from a dev server, a static host
 * or a `file://` page alike.
 *
 * ❗ **The level's own name is put in the DOM as text, never as markup**, by the
 * component and by the loader alike: it was typed by whoever published it and
 * arrived over the network.
 */

import { createApp, h, reactive } from 'vue';
import BonsaiPanel from './widgets/BonsaiPanel.vue';
import {
  BONSAI_HOST, bonsaiAssetUrl, bonsaiByUserUrl, bonsaiLevelByHashUrl, bonsaiLevelUrl,
  bonsaiSearchUrl, bonsaiUserUrl, looksLikeName, rankLevels, readAnswer, readBonsaiLevel,
  readBonsaiPaste, readBonsaiUser, readSearch, searchSummary, songlessWhy, type BonsaiLevel,
} from './bonsai.ts';
import { rememberLevel } from './link.ts';
import { bodyBytes, loading, sizeText, type LoadingJob } from './widgets/loading.ts';
import { mustWalk, StopWalk, walkNote, walkParts } from './resource-walk.ts';
import { HEADER_MIN } from '@lbptracker/cwlib/resource.ts';
import { FETCH_SECONDS, OPEN_SECONDS, WALK_SECONDS, type Opened } from './open-level.ts';

/**
 * How many resources one open may pull in, the root included, and how many at
 * a time.
 *
 * ⚠️ **Sixty, because Bonsai allows seventy a minute.** The asset route is
 * rate-limited per address (`bonsaiAssetUrl`), and a walk that runs into the
 * limit gets `429` for half a minute: the songs it had would still open, but a
 * second level opened straight after would not. Sixty leaves room for that.
 * The largest music level of a sample of twelve names 69 openable parts, so
 * the cap is reachable and `walkNote` says when it was reached.
 *
 * Four at a time rather than the archive's six: the limit is on the count,
 * not the rate, so going faster only meets it sooner.
 */
const RESOURCE_LIMIT = 60;
const AT_A_TIME = 4;

/** What a wired panel lets the page do without the reader touching it. */
export interface BonsaiOpen {
  /** Open a level by its number, as if its link had been pasted into the box. */
  open(id: number, opts?: { deep?: boolean }): Promise<void>;
}

const SLOW_DOWN = 'Bonsai asked to slow down; try again in half a minute';

/**
 * Ask Bonsai's API for something, and get the whole answer or a sentence.
 *
 * ⚠️ **A fetch that throws is not "not found".** It is the network, or Bonsai
 * being down, or a `429` that came back without its CORS header -- which a
 * browser reports exactly like a network failure -- and saying "no such level"
 * then would send the reader looking for a typo that is not there.
 */
async function ask(url: string, notFound: string): Promise<unknown> {
  let answer: Response;
  try {
    answer = await fetch(url, { mode: 'cors' });
  } catch {
    throw new Error('could not reach Bonsai; it may be down or busy, so try again in a minute');
  }
  if (answer.status === 429) throw new Error(SLOW_DOWN);
  if (answer.status === 404) throw new Error(notFound);
  let body: unknown;
  try {
    body = await answer.json();
  } catch {
    throw new Error(`Bonsai answered ${answer.status} with something that is not its API`);
  }
  const read = readAnswer(body);
  if (read.error) throw new Error(answer.ok ? read.error : `Bonsai answered ${answer.status}: ${read.error}`);
  return body;
}

/**
 * The level a number or a root hash names, with its title and its root.
 *
 * ❗ **Looked up at every open**, never remembered from a previous one: the root
 * hash changes when the creator republishes and the number does not, and a
 * link should open the level as it is now.
 */
async function lookUp(wanted: number | string): Promise<BonsaiLevel> {
  const body = typeof wanted === 'number'
    ? await ask(bonsaiLevelUrl(wanted), `Bonsai has no level numbered ${wanted}`)
    : await ask(
      bonsaiLevelByHashUrl(wanted),
      'no level on Bonsai has that root hash; a hash off zaprit.fish goes in the archive’s box',
    );
  const level = readBonsaiLevel(readAnswer(body).data);
  if (!level) throw new Error('Bonsai’s answer is not a level this page can read');
  return level;
}

/** A creator a search found, and the first page of what they made. */
interface Author {
  readonly name: string;
  readonly count: number;
  readonly levels: readonly BonsaiLevel[];
}

/**
 * The creator a query names, if it names one: the levels they published, and
 * the ones other people reuploaded with them as the original creator.
 *
 * ❗ **Two lists, because a creator is two things on Bonsai.** Somebody who
 * registered publishes under their account (`byUser?username=Subyuko`); somebody
 * whose levels came across from the archive is a name in `originalPublisher` on
 * other people's uploads (`byUser?username=!FattyMcIntosh`, 11 of them). Both
 * routes want the exact capitals, so the name is first looked up whatever its
 * case (`bonsaiUserUrl`); a name nobody registered is tried as typed.
 *
 * ⚠️ **Best effort, and never the reason a search fails.** A 404 here only means
 * "not a creator", and a 429 or a network error costs the author's half of the
 * answer, not the titles. It is also at most three requests, two of them from
 * the fifty level lists Bonsai allows an address in four minutes, which is why
 * `looksLikeName` gates it. Only the first page of each list is fetched: 100
 * levels by one creator is more than this box will be scrolled through.
 */
async function findAuthor(query: string): Promise<Author | undefined> {
  if (!looksLikeName(query)) return undefined;
  const quietly = async (url: string): Promise<unknown> => {
    try {
      return await ask(url, '');
    } catch {
      return undefined;
    }
  };
  const user = readBonsaiUser(readAnswer(await quietly(bonsaiUserUrl(query))).data);
  const name = user ?? query;
  const lists = await Promise.all(
    [user && bonsaiByUserUrl(user), bonsaiByUserUrl(`!${name}`)]
      .filter((url): url is string => Boolean(url))
      .map(async (url) => readSearch(await quietly(url))),
  );
  const seen = new Set<number>();
  const levels = lists.flatMap((list) => list.levels).filter((l) => !seen.has(l.id) && Boolean(seen.add(l.id)));
  const count = lists.reduce((sum, list) => sum + list.total, 0);
  return count > 0 ? { name, count, levels } : undefined;
}

/**
 * Wire a button to a panel it builds itself.
 *
 * `onOpen` gets the same shape a dropped file produces, so a page needs no new
 * code path: the level arrives as `BackupFile`s named after their SHA-1, which
 * is what they are called in a real backup too.
 */
export function wireBonsaiOpen(opts: {
  button: HTMLElement;
  host: HTMLElement;
  onOpen: (opened: Opened) => void | Promise<void>;
}): BonsaiOpen {
  const { button, host, onOpen } = opts;
  host.classList.add('archive', 'bonsai');
  host.hidden = true;

  const ui = reactive({
    query: '',
    deep: false,
    note: '',
    bad: false,
    busy: false,
    results: [] as BonsaiLevel[],
    searched: undefined as string | undefined,
    summary: undefined as string | undefined,
    next: undefined as number | undefined,
    chosen: undefined as number | undefined,
  });
  let focusField = () => {};
  createApp({
    render: () =>
      h(BonsaiPanel, {
        host: BONSAI_HOST,
        busy: ui.busy,
        results: ui.results,
        summary: ui.summary,
        more: ui.next !== undefined,
        chosen: ui.chosen,
        query: ui.query,
        'onUpdate:query': (v: string) => (ui.query = v),
        deep: ui.deep,
        'onUpdate:deep': (v: boolean) => (ui.deep = v),
        note: ui.note,
        bad: ui.bad,
        onSubmit: () => void submit(),
        onOpen: (level: BonsaiLevel) => void open_(level, ui.deep),
        onMore: () => void search(ui.searched ?? '', ui.next),
        ref: (el: unknown) => {
          focusField = (el as { focus(): void } | null)?.focus.bind(el) ?? (() => {});
        },
      }),
  }).mount(host);

  let busy = false;
  const say = (text: string, bad = false) => {
    ui.note = text;
    ui.bad = bad;
  };

  // ❗ **Progress goes to two places**, for the reason given beside the same
  // two lines in `archive-panel.ts`: a `?bonsai=` link never opens this box.
  let job: LoadingJob | undefined;
  const progress = (note: string, loud = note) => {
    say(note);
    job?.note(loud);
  };

  /**
   * One resource off Bonsai. Throws with something worth reading.
   *
   * ⚠️ **A `429` ends the walk, it does not skip a part**: every part still in
   * the queue would get the same answer, and asking keeps the block going.
   */
  async function grab(
    sha1: string,
    onBytes?: (got: number, total: number | undefined) => void,
  ): Promise<Uint8Array> {
    const answer = await fetch(bonsaiAssetUrl(sha1), { mode: 'cors' });
    if (answer.status === 429) throw new StopWalk(SLOW_DOWN);
    if (!answer.ok) throw new Error(`Bonsai answered ${answer.status} for ${sha1.slice(0, 8)}`);
    return onBytes ? bodyBytes(answer, onBytes) : new Uint8Array(await answer.arrayBuffer());
  }

  /**
   * A search: titles and descriptions, and the creator the words name, ranked
   * together (`rankLevels`). A further page, when `skip` says so, is ranked on
   * its own and appended: re-sorting what is already on screen would move the
   * row the reader was about to click.
   */
  async function search(query: string, skip?: number): Promise<void> {
    if (busy || query === '') return;
    busy = true;
    ui.busy = true;
    say(skip ? 'fetching more…' : `searching Bonsai for “${query}”…`);
    try {
      const [page, author] = await Promise.all([
        ask(bonsaiSearchUrl(query, skip), 'Bonsai has no search here').then(readSearch),
        skip === undefined ? findAuthor(query) : undefined,
      ]);
      const before = skip === undefined ? [] : ui.results;
      const seen = new Set(before.map((l) => l.id));
      const fresh = [...(author?.levels ?? []), ...page.levels]
        .filter((l) => !seen.has(l.id) && Boolean(seen.add(l.id)));
      ui.results = [...before, ...rankLevels(query, fresh)];
      if (skip === undefined) {
        ui.searched = query;
        ui.summary = searchSummary(query, page.total, author);
      }
      ui.next = page.next;
      say(ui.results.length ? 'pick a level to open it' : '');
    } catch (error) {
      say(error instanceof Error ? error.message : String(error), true);
    } finally {
      busy = false;
      ui.busy = false;
    }
  }

  /**
   * Fetch a level and, when asked, the parts it depends on, and hand the pile
   * over.
   *
   * `wanted` is a level the search already described, or a number or a root
   * hash to look up first (`lookUp`); the lookup is what gives the title, which
   * the archive route has no way to know.
   */
  async function open_(wanted: BonsaiLevel | number | string, deep: boolean): Promise<void> {
    if (busy) return;
    busy = true;
    ui.busy = true;
    ui.deep = deep;
    const named = typeof wanted === 'object' ? `level ${wanted.id}`
      : typeof wanted === 'number' ? `level ${wanted}` : `the level ${wanted.slice(0, 8)}…`;
    job = loading(`Opening ${named} from Bonsai`);
    // The bar's weights, as on the archive route (`open_` in `archive-panel.ts`).
    const fetchStep = { key: 'fetch', seconds: FETCH_SECONDS };
    const openStep = { key: 'open', seconds: OPEN_SECONDS };
    const lookStep = { key: 'look', seconds: typeof wanted === 'object' ? 0 : 0.8 };
    job.plan([lookStep, fetchStep, openStep]);
    progress(`asking Bonsai for ${named}…`);
    try {
      const level = typeof wanted === 'object' ? wanted : await lookUp(wanted);
      ui.chosen = level.id;
      const songless = songlessWhy(level);
      if (songless) throw new Error(songless);
      job.step('fetch', `downloading “${level.title}”…`);
      progress(`fetching “${level.title}”…`, `downloading “${level.title}”…`);
      let rootBytes: Uint8Array;
      try {
        rootBytes = await grab(level.sha1, (got, total) => job?.progress(
          total ? Math.min(1, got / total) : null,
          `downloading “${level.title}”: ${sizeText(got)}${total ? ` of ${sizeText(total)}` : ''}…`,
        ));
      } catch (error) {
        if (error instanceof StopWalk) throw error;
        throw new Error(`the level’s file would not come: ${
          error instanceof Error ? error.message : String(error)}`);
      }
      // ⚠️ An empty 200 is how Bonsai can answer for a file it does not have:
      // see `walkParts`.
      if (rootBytes.length < HEADER_MIN) {
        throw new Error(`Bonsai lists “${level.title}” but sent an empty file for it`);
      }
      const root = { sha1: level.sha1, bytes: rootBytes };
      // ❗ Read once, at the start, and not optional for an adventure: see
      // `open_` in `archive-panel.ts` and `mustWalk`.
      const walking = mustWalk(root.bytes, deep);
      if (walking) {
        job.plan([lookStep, fetchStep, { key: 'walk', seconds: WALK_SECONDS }, openStep]);
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
        : { files: [{ name: level.sha1, bytes: root.bytes }], missing: 0, skipped: 0 };
      job.step('open', 'opening the level…');
      const note = walkNote(walked, 'on Bonsai');
      say(note, note !== '');
      host.hidden = note === '';
      // ❗ **The address bar becomes the link to share**, by number: see
      // `link.ts`, and `lookUp` on why not by hash.
      const link = { from: 'bonsai', id: level.id, deep } as const;
      rememberLevel(link);
      await onOpen({
        label: `${level.title} by ${level.author}`,
        files: walked.files,
        many: walked.files.length > 1,
        link,
      });
    } catch (error) {
      host.hidden = false;
      say(error instanceof Error ? error.message : String(error), true);
    } finally {
      busy = false;
      ui.busy = false;
      job?.done();
      job = undefined;
    }
  }

  function submit(): void {
    if (busy) return;
    const typed = readBonsaiPaste(ui.query);
    if (typed.kind === 'id') void open_(typed.id, ui.deep);
    else if (typed.kind === 'hash') void open_(typed.sha1, ui.deep);
    else if (typed.kind === 'words') void search(typed.query);
    else focusField();
  }

  button.addEventListener('click', () => {
    host.hidden = !host.hidden;
    if (!host.hidden) focusField();
  });

  return {
    open: (id, o) => {
      // Opened from a link rather than from the box: show the box anyway, or a
      // level that will not come reports itself into a panel nobody can see.
      host.hidden = false;
      ui.query = String(id);
      return open_(id, o?.deep ?? ui.deep);
    },
  };
}
