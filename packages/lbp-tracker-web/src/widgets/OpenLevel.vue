<script setup lang="ts">
/**
 * The open dialog's body: one tab per way in, and the songs of the level that
 * is open.
 *
 * ❗ **Tabs, not a row of buttons that each unfold a panel under the zone.**
 * Five buttons of equal weight wrapped onto two lines, the song index fell
 * alone onto the second, and a level opened from the index stacked three
 * panels and the song list into one column taller than the screen. Each way in
 * now has the whole width, and the song list is a tab of its own that the page
 * selects when a level brings more than one song (`showLevel`).
 *
 * ⚠️ **The whole body takes drops, not only the "your computer" tab.** A file
 * dragged over the dialog opens from whichever tab is showing; the overlay
 * says so while it is over.
 *
 * ⚠️ **The zone takes drops and nothing else.** Making a click anywhere on it
 * open the file picker looked convenient and was a bug: pressing "open a
 * folder" opened BOTH pickers, because `input.click()` dispatches a click on the
 * input that bubbles straight back up to the zone, where it is indistinguishable
 * from a click on the background. Two buttons, one job each.
 *
 * ❗ **The archive, Bonsai and the song index live here** rather than beside
 * the page's own wiring: their panels are mounted into the hosts below by
 * `open-panel.ts`, and the page only ever sees `OpenPanel`.
 */
import { ref, useTemplateRef } from 'vue';

export type OpenTab = 'level' | 'index' | 'archive' | 'bonsai' | 'computer';

const emit = defineEmits<{ files: [files: File[]]; drop: [transfer: DataTransfer] }>();

const title = ref('');
const busy = ref(false);
const loaded = ref(false);
const over = ref(false);
const tab = ref<OpenTab>('index');

const TABS: [OpenTab, string][] = [
  ['index', 'Song index'],
  ['archive', 'Online archive'],
  ['bonsai', 'Bonsai'],
  ['computer', 'Your computer'],
];

const fileInput = useTemplateRef<HTMLInputElement>('fileInput');
const folderInput = useTemplateRef<HTMLInputElement>('folderInput');
const seqHost = useTemplateRef<HTMLDivElement>('seqHost');
const archiveHost = useTemplateRef<HTMLDivElement>('archiveHost');
const bonsaiHost = useTemplateRef<HTMLDivElement>('bonsaiHost');
const songsHost = useTemplateRef<HTMLDivElement>('songsHost');

/**
 * ❗ **The input is cleared after every pick**, which is not tidiness: without
 * it, choosing the *same* file again fires no `change` at all, and re-reading a
 * level you have just re-exported from the game silently does nothing.
 */
const take = (input: HTMLInputElement | null) => {
  if (!input?.files) return;
  const files = [...input.files];
  input.value = '';
  if (files.length) emit('files', files);
};

/**
 * ⚠️ `dragleave` fires on every child the pointer crosses, so a plain flag
 * flickers; counting enters against leaves is what keeps the overlay steady.
 */
let depth = 0;
const onEnter = () => {
  depth++;
  over.value = true;
};
const onLeave = () => {
  depth = Math.max(0, depth - 1);
  if (depth === 0) over.value = false;
};
const onDrop = (event: DragEvent) => {
  depth = 0;
  over.value = false;
  if (event.dataTransfer) emit('drop', event.dataTransfer);
};

/** Arrow keys move along the tabs, as a tablist's do. */
const onTabKey = (event: KeyboardEvent) => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  const shown: OpenTab[] = [...(loaded.value ? ['level' as const] : []), ...TABS.map(([t]) => t)];
  const at = shown.indexOf(tab.value);
  const next = shown[(at + (event.key === 'ArrowRight' ? 1 : shown.length - 1)) % shown.length];
  tab.value = next;
  (event.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus();
  event.preventDefault();
};

/**
 * ⚠️ **Setters, not the refs themselves.** `defineExpose` unwraps a ref on the
 * way out, so a caller writing `ui.busy.value = true` gets
 * `Cannot create property 'value' on boolean 'false'` — and only at the moment
 * the zone is first used, which on this page is after a level has been read.
 */
defineExpose({
  say: (nextTitle: string) => {
    title.value = nextTitle;
  },
  setBusy: (on: boolean) => {
    busy.value = on;
  },
  setLoaded: (on: boolean) => {
    loaded.value = on;
    if (!on && tab.value === 'level') tab.value = 'index';
  },
  select: (next: OpenTab) => {
    tab.value = next;
  },
  seqHost,
  archiveHost,
  bonsaiHost,
  songsHost,
});
</script>

<template>
  <div
    class="openlv"
    :class="{ busy, over }"
    @dragenter.prevent="onEnter"
    @dragover.prevent
    @dragleave.prevent="onLeave"
    @drop.prevent="onDrop"
  >
    <div class="openlv-tabs" role="tablist" aria-label="Where to open from" @keydown="onTabKey">
      <button
        v-if="loaded"
        type="button"
        role="tab"
        data-tab="level"
        :aria-selected="tab === 'level'"
        :tabindex="tab === 'level' ? 0 : -1"
        :class="{ on: tab === 'level' }"
        @click="tab = 'level'"
      >This level</button>
      <button
        v-for="[key, label] in TABS"
        :key="key"
        type="button"
        role="tab"
        :data-tab="key"
        :aria-selected="tab === key"
        :tabindex="tab === key ? 0 : -1"
        :class="{ on: tab === key }"
        @click="tab = key"
      >{{ label }}</button>
    </div>

    <div v-show="tab === 'level'" class="openlv-pane" role="tabpanel">
      <p class="openlv-level">{{ title }}</p>
      <!-- Filled by `seq-picker.ts`: the songs of the level that is open. -->
      <div ref="seqHost"></div>
    </div>
    <!-- Filled by `song-index-panel.ts`, `archive-panel.ts` and `bonsai-panel.ts`. -->
    <div v-show="tab === 'index'" ref="songsHost" class="openlv-pane" role="tabpanel"></div>
    <div v-show="tab === 'archive'" ref="archiveHost" class="openlv-pane" role="tabpanel"></div>
    <div v-show="tab === 'bonsai'" ref="bonsaiHost" class="openlv-pane" role="tabpanel"></div>
    <div v-show="tab === 'computer'" class="openlv-pane" role="tabpanel">
      <div class="openlv-local">
        <strong>A level, a backup folder, a zip, a .mod or a song file</strong>
        <span>Drop it anywhere on this dialog, or pick it.</span>
        <input ref="fileInput" type="file" autocomplete="off" @change="take(fileInput)">
        <!--
          Dropping a folder works on its own; this is for the browsers and
          situations where the drop is not offered. `webkitdirectory` is the only
          widely supported way to pick one.
        -->
        <input ref="folderInput" type="file" webkitdirectory autocomplete="off" @change="take(folderInput)">
        <div class="row openlv-local-buttons">
          <button type="button" @click="fileInput?.click()">Open a file…</button>
          <button type="button" @click="folderInput?.click()">Open a folder…</button>
        </div>
        <span class="openlv-local-note">Nothing you open here leaves your computer.</span>
      </div>
    </div>

    <div v-if="over" class="openlv-over" aria-hidden="true"><span>Drop to open</span></div>
  </div>
</template>
