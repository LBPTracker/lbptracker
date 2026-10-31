<script setup lang="ts">
/**
 * The "Bonsai" tab: a level off Bonsai, by its link or number, or by
 * searching for it here.
 *
 * ❗ **A search box, where the archive's panel has only a hash field**, and the
 * difference is one header: Bonsai answers any origin and zaprit.fish answers
 * none, so this page can ask Bonsai directly and still needs no server of its
 * own. See `src/bonsai.ts`.
 *
 * ❗ **Everything a level says about itself is text, never markup.** Titles and
 * names arrive over the network from whoever published them; the template only
 * interpolates them, and the icon is an `<img>` whose source is built from a
 * hash `readBonsaiLevel` has already checked.
 */
import { reactive, useTemplateRef } from 'vue';
import { bonsaiIconUrl, gameName, type BonsaiLevel } from '../bonsai.ts';

const DEFAULT_NOTE =
  'Search, or paste a level’s link or number, and the level is downloaded to your browser and read there.';

defineProps<{
  host: string;
  busy?: boolean;
  /** One page or more of results, best answer first (`rankLevels`). */
  results: readonly BonsaiLevel[];
  /** The line over the results once a search has run (`searchSummary`). */
  summary?: string;
  more?: boolean;
  /** The level last opened from here, marked in the list. */
  chosen?: number;
}>();
const note = defineModel<string>('note', { default: '' });
const bad = defineModel<boolean>('bad', { default: false });
const query = defineModel<string>('query', { default: '' });
const deep = defineModel<boolean>('deep', { default: false });
const emit = defineEmits<{ submit: []; open: [level: BonsaiLevel]; more: [] }>();

const field = useTemplateRef<HTMLInputElement>('field');
defineExpose({ focus: () => field.value?.focus() });

/** Icons that would not load, by hash, so the row shows the empty square instead. */
const broken = reactive(new Set<string>());
</script>

<template>
  <div class="row">
    <input
      ref="field"
      v-model="query"
      class="archive-q"
      type="text"
      placeholder="a title, a creator’s name, or a level’s link or number…"
      aria-label="Search Bonsai by title or creator, or a level's link or number"
      autocomplete="off"
      spellcheck="false"
      @keydown.enter.prevent="emit('submit')"
    >
    <button type="button" class="archive-go primary" :disabled="busy"
            @click="emit('submit')">Search</button>
    <!-- ⚠️ `autocomplete="off"`: see the same switch in `ArchivePanel.vue`. -->
    <label class="check archive-deep">
      <input v-model="deep" type="checkbox" autocomplete="off"> Whole backup
    </label>
  </div>
  <p class="archive-note" :class="{ bad }">{{ note || DEFAULT_NOTE }}</p>
  <template v-if="summary !== undefined">
    <p class="bonsai-count">{{ summary }}</p>
    <div v-if="results.length" class="picker-list bonsai-results" role="list">
      <button
        v-for="level in results"
        :key="level.id"
        type="button"
        class="picker-row bonsai-row"
        :class="{ on: level.id === chosen }"
        role="listitem"
        :disabled="busy"
        :title="`open “${level.title}”`"
        @click="emit('open', level)"
      >
        <!-- A GUID icon is a game asset Bonsai has no image route for: an
             empty square keeps the column, rather than a broken image. ⚠️ So
             does an icon that fails, which a 200 does not rule out: Bonsai
             answered `200 image/png` with an EMPTY body for "Random Music
             Sequencer Melodies" (#19986), measured 2026-10-04. -->
        <img
          v-if="level.icon && !broken.has(level.icon)"
          class="bonsai-icon"
          :src="bonsaiIconUrl(level.icon)"
          alt=""
          loading="lazy"
          referrerpolicy="no-referrer"
          @error="broken.add(level.icon)"
        >
        <span v-else class="bonsai-icon" aria-hidden="true"></span>
        <span class="bonsai-title">{{ level.title }}</span>
        <span class="picker-detail">{{ level.author }} · {{ gameName(level.game) }}<template v-if="level.hearts"> · ♥ {{ level.hearts }}</template></span>
        <span class="picker-uid">#{{ level.id }}</span>
      </button>
      <button v-if="more" type="button" class="ghost bonsai-more" :disabled="busy"
              @click="emit('more')">More…</button>
    </div>
  </template>
  <!-- The rest of what used to be here, whole backup included, is the "open" help topic. -->
  <p class="archive-hint">
    Levels published on
    <a :href="host" target="_blank" rel="noreferrer noopener">Bonsai</a>, a community server the
    game is still played on, asked for directly by this page. A creator’s whole name finds what
    they made; a number is the one at the end of a level’s address there.
  </p>
</template>
