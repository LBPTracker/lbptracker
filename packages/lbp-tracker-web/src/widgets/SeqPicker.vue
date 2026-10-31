<script setup lang="ts">
/**
 * The song picker: a search box over the list of songs, inside the open dialog.
 *
 * ⚠️ **A native `<select>` with a search box beside it was the first attempt and
 * it was wrong.** Two controls for one choice, the box doing nothing until you
 * notice what it is for, and the list still a native popup that cannot show a
 * filter. The second was one field opening a floating panel, which fought the
 * dialog it lives in: a list taller than the box made the dialog scroll and
 * clipped it. So the list is simply there, in the dialog, and typing filters it.
 *
 * ❗ **The `escape()` this replaced was not decoration.** The old markup was one
 * `innerHTML` string, and only the song's *name* went through an escaper; the
 * detail column, which carries a **filename out of the opened backup**, did not.
 * A zip holding a file named `<img src=x onerror=…>` therefore ran it, and the
 * archive button downloads other people's zips by design. There is no escaper
 * here because there is nothing to escape: `{{ }}` is text.
 */
import { computed, ref, useTemplateRef, watch } from 'vue';
import { detail, matches, title, uidLabel, type PickerState, type SeqRow } from './picker-state.ts';

const props = defineProps<{
  state: PickerState;
  onPick: (key: string) => void;
  /** Save the chosen song as a file; the button appears only when this is given. */
  onSave?: (key: string) => void;
  /**
   * Copy a link to the chosen song. The page does the copying -- it is the one
   * that knows what the link is -- and answers with the link and whether it
   * reached the clipboard. ⚠️ **A refused copy is not an error**: the
   * clipboard can be denied outright, and then the URL is shown instead.
   */
  onLink?: (key: string) => Promise<{ url: string; copied: boolean }>;
}>();

const needle = ref('');
/** Which row the arrow keys are on; -1 when nothing is highlighted. */
const cursor = ref(-1);

const listEl = useTemplateRef<HTMLElement>('list');

const shown = computed(() => props.state.rows.filter((r) => matches(r, needle.value)));
const current = computed(() => props.state.rows.find((r) => r.key === props.state.chosen));

// A new level: the search starts empty and the chosen row is in view.
watch(() => props.state.rows, async () => {
  needle.value = '';
  cursor.value = -1;
  shownLink.value = '';
  await Promise.resolve();
  listEl.value?.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
});

/**
 * Choose a row. `quiet` selects without telling the page.
 *
 * ⚠️ **A click on the row that is already chosen is still a choice.** This
 * used to return early on it, and since the page closes the dialog from
 * `onPick`, clicking the song you were already on left the picker sitting
 * there with nothing happening -- the one row in the list where a click did
 * nothing at all. Only the state write is skipped now; the page hears it
 * either way and decides what a repeat means (`daw.ts`: close, and do not
 * open the song again).
 */
const pick = (key: string, quiet = false) => {
  if (key !== props.state.chosen) props.state.chosen = key;
  if (!quiet) props.onPick(key);
};
defineExpose({ pick });

/**
 * The copy button's own state: '' before, 'yes' or 'no' for a moment after.
 *
 * ❗ **The button is the receipt.** A copy that leaves nothing on screen is
 * indistinguishable from a click that missed, and the picker is a modal dialog
 * over the status bar the rest of the app reports through.
 */
const copied = ref<'' | 'yes' | 'no'>('');
let clearCopied = 0;
const copyLabel = computed(() =>
  copied.value === 'yes' ? 'Link copied' : copied.value === 'no' ? 'Here it is' : 'Copy the link');

/**
 * The link itself, shown only when the clipboard refused it.
 *
 * ⚠️ **A denied copy must still leave the reader with the link.** The
 * clipboard is a permission the embedder can withhold and there is nothing the
 * page can do about it; a field holding the URL, selected, is what is left.
 */
const shownLink = ref('');
const linkField = useTemplateRef<HTMLInputElement>('linkField');

const copyLink = async () => {
  const row = current.value;
  if (!props.onLink || !row) return;
  try {
    const done = await props.onLink(row.key);
    copied.value = done.copied ? 'yes' : 'no';
    shownLink.value = done.copied ? '' : done.url;
  } catch {
    copied.value = 'no';
    shownLink.value = '';
  }
  if (shownLink.value) {
    await Promise.resolve();
    linkField.value?.select();
  }
  window.clearTimeout(clearCopied);
  clearCopied = window.setTimeout(() => { copied.value = ''; }, 1800);
};

const onKey = async (event: KeyboardEvent) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (!shown.value.length) return;
    const step = event.key === 'ArrowDown' ? 1 : shown.value.length - 1;
    cursor.value = (cursor.value + step) % shown.value.length;
    await Promise.resolve();
    listEl.value?.children[cursor.value]?.scrollIntoView({ block: 'nearest' });
  } else if (event.key === 'Enter') {
    const row: SeqRow | undefined = shown.value[cursor.value] ?? (shown.value.length === 1 ? shown.value[0] : undefined);
    if (row) pick(row.key);
  } else {
    return;
  }
  event.preventDefault();
};
</script>

<template>
  <div v-if="state.rows.length" class="picker">
    <div class="row">
      <input
        v-model="needle"
        class="picker-search"
        type="text"
        placeholder="search the songs…"
        aria-label="Search songs"
        autocomplete="off"
        @input="cursor = shown.length ? 0 : -1"
        @keydown="onKey"
      >
      <!-- ❗ Beside the search box rather than on each row: it copies the
           link to the song that is CHOSEN, which is also the one playing, and a
           button on sixteen rows would be sixteen ways to ask the same thing. -->
      <button
        v-if="onLink && state.linkable"
        type="button"
        class="picker-link"
        :class="{ ok: copied === 'yes', bad: copied === 'no' }"
        title="Copy a link that opens this song, in this level, for anybody"
        :disabled="!current"
        @click="copyLink()"
      >{{ copyLabel }}</button>
      <button
        v-if="onSave"
        type="button"
        class="picker-save"
        title="Save the chosen song as a song file"
        :disabled="!current"
        @click="current && onSave(current.key)"
      >Save as a song file</button>
    </div>
    <!-- Only after a copy the browser would not do: the link, to take by hand. -->
    <input
      v-if="shownLink"
      ref="linkField"
      class="picker-linkfield"
      type="text"
      readonly
      :value="shownLink"
      aria-label="The link to this song"
      @focus="($event.target as HTMLInputElement).select()"
    >
    <div ref="list" class="picker-list picker-tall" role="listbox">
      <button
        v-for="(row, i) in shown"
        :key="row.key"
        type="button"
        role="option"
        class="picker-row"
        :class="{ on: row.key === state.chosen, at: i === cursor }"
        :aria-selected="row.key === state.chosen"
        @click="pick(row.key)"
      >
        <span>{{ title(row) }}</span>
        <!-- The uid is what a link names this song by, so it is on the row
             rather than only in the URL: see `seq=` in `src/link.ts`. -->
        <span v-if="uidLabel(row)" class="picker-uid">{{ uidLabel(row) }}</span>
        <span class="picker-detail">{{ detail(row) }}</span>
      </button>
    </div>
    <div class="picker-none" :hidden="shown.length > 0">nothing matches</div>
  </div>
</template>
