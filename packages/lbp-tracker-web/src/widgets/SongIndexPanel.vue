<script setup lang="ts">
/**
 * The song index's markup: a table of every song on the left, the chosen
 * song's variants, makers and levels on the right, each copy a button that
 * opens it.
 *
 * `song-index-panel.ts` holds the state and the fetching; this only draws it.
 * ❗ **Every name here is text, never markup**: song names, PSN handles and
 * level titles were all typed by players, and the template only interpolates.
 *
 * ❗ **The table stays put while a song is looked at.** The detail used to
 * replace the list, and coming back rebuilt it: the scroll and every page
 * loaded with "more" were gone. Side by side, the list is never torn down;
 * on a narrow screen the detail covers it with CSS alone (`.chosen` in
 * `ui.css`), which keeps the same promise.
 */
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue';
import { makerOf, openTarget, type Relation, type SongDetail, type SongFilter, type SongRow, type SortKey, type Target } from '../song-index.ts';

const props = defineProps<{
  note: string;
  bad: boolean;
  busy: boolean;
  ready: boolean;
  query: string;
  filter: Omit<SongFilter, 'query'>;
  total: number;
  shown: readonly SongRow[];
  chosen?: SongRow;
  detail?: SongDetail;
  /** Why the chosen song's detail would not load, or how its open is going. */
  detailNote: string;
  detailBad: boolean;
  generated: string;
}>();
const emit = defineEmits<{
  'update:query': [value: string];
  filter: [patch: Partial<SongFilter>];
  more: [];
  pick: [row: SongRow];
  back: [];
  open: [target: Target];
}>();

const field = useTemplateRef<HTMLInputElement>('field');
const list = useTemplateRef<HTMLDivElement>('list');
defineExpose({ focus: () => field.value?.focus() });

const tab = ref<'variants' | 'authors' | 'levels'>('variants');
watch(() => props.chosen, () => (tab.value = 'variants'));

/**
 * The table's columns, each a sort; a second click turns the order round.
 *
 * ❗ **When, then how far it went**, and nothing else: variants, tempo and
 * notes were columns and a menu each for a day, and the owner cut them as
 * numbers nobody chooses a song by. The detail still shows all of them.
 */
const COLUMNS: [SortKey, string][] = [['year', 'Year'], ['levels', 'Levels'], ['plays', 'Plays']];
const sortBy = (key: SortKey) => {
  if (props.filter.sort === key) emit('filter', { descending: !props.filter.descending });
  // Names read A to Z; every number reads biggest first.
  else emit('filter', { sort: key, descending: key !== 'name' });
};
const arrow = (key: SortKey) => (props.filter.sort === key ? (props.filter.descending ? ' ↓' : ' ↑') : '');
const ariaSort = (key: SortKey) =>
  props.filter.sort === key ? (props.filter.descending ? 'descending' : 'ascending') : 'none';

const GAMES = ['LBP1', 'LBP2', 'LBP3'];
/** What a variant's similarity cannot say on its own (`Relation` in `song-index.ts`). */
const RELATIONS: Partial<Record<Relation, string>> = {
  same_music: 'Same notes',
  extended: 'Longer',
  shortened: 'Shorter',
};
const count = (n: number) => n.toLocaleString('en-GB');
/** Plays run to ten million: three figures say enough in a column. */
const short = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : count(n);
const date = (ms: number) => (ms ? new Date(ms).toLocaleDateString('en-GB') : '–');
const percent = (s: number | null) => (s == null ? '–' : `${Math.round(s * 100)}%`);
const named = (name: string) => name || 'untitled';

/** The copy "open" means with no more said (`openTarget` in `song-index.ts`). */
const opening = computed(() => (props.detail ? openTarget(props.detail) : undefined));
const main = computed(() => opening.value?.target);

/**
 * The variants as the list shows them: oldest first, so the song reads as it
 * spread. ⚠️ **By year, because that is all a variant carries** (`Variant` in
 * `song-index.ts`); within a year the export's own order stands, which puts
 * the main variant first. A year of 0 is unknown and goes last. The main one
 * is the `center` row, the first in the file, and is marked wherever it lands.
 */
const variants = computed(() =>
  (props.detail?.variants ?? [])
    .map((v, i) => ({ v, i, main: v.relation === 'center' || i === 0 }))
    .sort((a, b) => (a.v.year || 9999) - (b.v.year || 9999) || a.i - b.i));

/**
 * ↑ and ↓ in the field walk the table, choosing as they go; Enter opens the
 * chosen song's original copy (`openTarget`). The field keeps the focus throughout, so typing
 * more narrows the list without a click back into it.
 */
const onKey = (event: KeyboardEvent) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (!props.shown.length) return;
    event.preventDefault();
    const at = props.chosen ? props.shown.indexOf(props.chosen) : -1;
    const next = event.key === 'ArrowDown' ? Math.min(props.shown.length - 1, at + 1) : Math.max(0, at - 1);
    emit('pick', props.shown[next]);
    if (next >= props.shown.length - 5 && props.shown.length < props.total) emit('more');
    void nextTick(() => list.value?.querySelector('.songindex-tr.on')?.scrollIntoView({ block: 'nearest' }));
  } else if (event.key === 'Enter') {
    event.preventDefault();
    if (main.value && !props.busy) emit('open', main.value);
    else if (!props.chosen && props.shown.length) emit('pick', props.shown[0]);
  }
};

/** The next page arrives before the reader reaches the end of this one. */
const onScroll = () => {
  const el = list.value;
  if (el && props.shown.length < props.total && el.scrollTop + el.clientHeight > el.scrollHeight - 240) emit('more');
};
</script>

<template>
  <div class="songindex" :class="{ chosen: !!chosen }">
    <div class="songindex-side">
      <input
        ref="field"
        :value="query"
        class="archive-q songindex-q"
        type="text"
        placeholder="a song, a maker, or the level it came from"
        aria-label="Search the song index"
        autocomplete="off"
        spellcheck="false"
        :disabled="!ready"
        @input="emit('update:query', ($event.target as HTMLInputElement).value)"
        @keydown="onKey"
      >
      <p v-if="ready" class="songindex-count">{{ count(total) }} {{ total === 1 ? 'song' : 'songs' }}</p>
      <p v-if="note" class="archive-note" :class="{ bad }">{{ note }}</p>

      <div v-if="ready" class="songindex-table" role="grid" :aria-rowcount="total">
        <!--
          ❗ The head is inside the scroller and sticks to its top: outside it,
          the rows lost a scrollbar's width the head did not, and every number
          sat to the left of its column's name.
        -->
        <div ref="list" class="songindex-rows" @scroll.passive="onScroll">
          <div class="songindex-tr songindex-th" role="row">
            <button type="button" role="columnheader" :aria-sort="ariaSort('name')" :class="{ on: filter.sort === 'name' }"
                    @click="sortBy('name')">Song · maker{{ arrow('name') }}</button>
            <button v-for="[key, label] in COLUMNS" :key="key" type="button" role="columnheader" class="num"
                    :aria-sort="ariaSort(key)" :class="{ on: filter.sort === key }" @click="sortBy(key)">{{ label }}{{ arrow(key) }}</button>
          </div>
          <button
            v-for="row in shown"
            :key="row.id"
            type="button"
            role="row"
            class="songindex-tr"
            :class="{ on: row === chosen }"
            :aria-selected="row === chosen"
            @click="emit('pick', row)"
          >
            <span class="songindex-main" role="gridcell">
              <span class="songindex-name">{{ named(row.name) }}</span>
              <span class="picker-detail">{{ makerOf(row) }}<template v-if="row.origin"> · {{ row.origin }}</template></span>
            </span>
            <span class="num" role="gridcell">{{ row.year || '–' }}</span>
            <span class="num" role="gridcell">{{ count(row.levels) }}</span>
            <span class="num" role="gridcell" :title="count(row.plays)">{{ short(row.plays) }}</span>
          </button>
          <p v-if="!shown.length" class="picker-none">No song matches. A maker’s name or the level it came from may find it.</p>
        </div>
      </div>
    </div>

    <!-- One song: what is known about it, and every copy that can be opened. -->
    <div class="songindex-detail">
      <template v-if="chosen">
        <button type="button" class="ghost songindex-back" @click="emit('back')">← All songs</button>
        <h3 class="songindex-title">{{ named(chosen.name) }}</h3>
        <p class="songindex-by">
          by {{ makerOf(chosen) }}<template v-if="chosen.game">, from its story mode: every copy was placed from the game’s own item</template><template v-if="chosen.origin">, first in <i>{{ chosen.origin }}</i><template v-if="chosen.originAuthor && chosen.originAuthor !== chosen.author"> by {{ chosen.originAuthor }}</template></template>
        </p>
        <button type="button" class="primary songindex-open" :disabled="busy || !main" @click="main && emit('open', main)">
          {{ busy ? 'Opening…' : opening?.original ? 'Open the original' : 'Open the main variant' }}
        </button>
        <p v-if="detailNote" class="archive-note" :class="{ bad: detailBad }">{{ detailNote }}</p>
        <dl class="songindex-facts">
          <div><dt>Levels</dt><dd>{{ count(chosen.levels) }}</dd></div>
          <div><dt>Plays</dt><dd :title="count(chosen.plays)">{{ short(chosen.plays) }}</dd></div>
          <div><dt>Tempo</dt><dd>{{ chosen.tempo }}</dd></div>
          <div><dt>Notes</dt><dd>{{ count(chosen.notes) }}</dd></div>
          <div><dt>First seen</dt><dd>{{ chosen.year || '–' }}</dd></div>
        </dl>
        <p v-if="chosen.alt" class="songindex-alt">Also called {{ chosen.alt }}</p>

        <p v-if="!detail && !detailBad" class="archive-note">loading its variants…</p>
        <template v-else-if="detail">
          <div class="songindex-tabs" role="tablist">
            <button type="button" role="tab" :aria-selected="tab === 'variants'" :class="{ on: tab === 'variants' }" @click="tab = 'variants'">Variants {{ detail.variants.length }}</button>
            <button type="button" role="tab" :aria-selected="tab === 'authors'" :class="{ on: tab === 'authors' }" @click="tab = 'authors'">Makers {{ detail.authors.length }}</button>
            <button type="button" role="tab" :aria-selected="tab === 'levels'" :class="{ on: tab === 'levels' }" @click="tab = 'levels'">Levels {{ detail.levels.length }}</button>
          </div>
          <div v-if="tab === 'variants'" class="songindex-list" role="list">
            <div v-for="{ v, i, main: isMain } in variants" :key="i" class="songindex-item" role="listitem">
              <span class="songindex-main">
                <span class="songindex-name">{{ named(v.name) }}<span v-if="isMain" class="songindex-tag">Main</span><span v-else-if="RELATIONS[v.relation]" class="songindex-tag">{{ RELATIONS[v.relation] }}</span></span>
                <span class="picker-detail">{{ v.author || 'unsigned' }} · {{ count(v.notes) }} notes · {{ v.tempo }} BPM · {{ count(v.levels) }} {{ v.levels === 1 ? 'level' : 'levels' }} · {{ v.year || '–' }}</span>
              </span>
              <span class="songindex-sim" title="How close it is to the main variant">
                <span class="songindex-bar"><span :style="{ width: v.similarity == null ? '0' : percent(v.similarity) }"></span></span>{{ percent(v.similarity) }}
              </span>
              <button v-if="v.target" type="button" class="ghost" :disabled="busy" @click="emit('open', v.target)">Open</button>
            </div>
          </div>
          <div v-else-if="tab === 'authors'" class="songindex-list" role="list">
            <div v-for="a in detail.authors" :key="a.author" class="songindex-item" role="listitem">
              <span class="songindex-main">
                <span class="songindex-name">{{ a.author }}<span v-if="a.author === chosen.author" class="songindex-tag">Maker</span></span>
                <span class="picker-detail">{{ a.candidate ? 'among the first' : 'came later' }} · first seen {{ date(a.firstSeen) }}</span>
              </span>
              <span class="picker-detail">{{ count(a.copies) }} {{ a.copies === 1 ? 'copy' : 'copies' }} · {{ count(a.levels) }} {{ a.levels === 1 ? 'level' : 'levels' }}</span>
            </div>
            <p v-if="!detail.authors.length" class="picker-none">No copy carries a name.</p>
          </div>
          <div v-else class="songindex-list" role="list">
            <div v-for="l in detail.levels" :key="l.slot" class="songindex-item" role="listitem">
              <span class="songindex-main">
                <span class="songindex-name">{{ named(l.name) }}<span v-if="l.origin" class="songindex-tag">Origin</span></span>
                <span class="picker-detail">{{ l.author || 'unknown' }} · {{ GAMES[l.game] ?? '?' }} · {{ count(l.plays) }} plays · {{ date(l.seen) }}</span>
              </span>
              <button v-if="l.target" type="button" class="ghost" :disabled="busy" @click="emit('open', l.target)">Open</button>
            </div>
          </div>
        </template>
      </template>
      <p v-else-if="ready" class="songindex-empty">
        Pick a song to see its variants, who made it and the levels that use it.
        ↑ and ↓ walk the list from the search field; Enter opens the song.
      </p>
    </div>
  </div>
  <p class="archive-hint">
    Every music sequencer in the LBP2 and LBP3 levels with more than a thousand plays on the
    official servers<template v-if="generated"> (index of {{ generated }})</template>, grouped
    into songs by their notes. A copy opens from the Internet Archive, and the address bar is then
    its link.
  </p>
</template>
