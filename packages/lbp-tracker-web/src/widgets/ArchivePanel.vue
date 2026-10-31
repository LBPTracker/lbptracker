<script setup lang="ts">
/**
 * The "online archive" tab: a root level hash, fetched straight from the
 * Internet Archive.
 *
 * ❗ **It needs no server** — not even the dev one — which is why it is a hash
 * and not a search. See *The search, built and then removed* in
 * `../cwlib-ts/steering/lbp-modding-toolchain.md`.
 *
 * This markup used to be a 20-line `innerHTML` string with the prose spliced
 * into it by `+`, which is why the note's default text had to be read back out
 * of the DOM (`note.textContent ?? ''`) to be restored later. It is a template
 * now and the default is just a string.
 */
import { useTemplateRef } from 'vue';

const DEFAULT_NOTE =
  'Paste the 40 digits and the level is downloaded to your browser and read there.';

defineProps<{ searchHost: string; busy?: boolean }>();
const note = defineModel<string>('note', { default: '' });
const bad = defineModel<boolean>('bad', { default: false });
const query = defineModel<string>('query', { default: '' });
const deep = defineModel<boolean>('deep', { default: false });
const emit = defineEmits<{ submit: [] }>();

const field = useTemplateRef<HTMLInputElement>('field');
defineExpose({ focus: () => field.value?.focus() });
</script>

<template>
  <div class="row">
    <input
      ref="field"
      v-model="query"
      class="archive-q"
      type="text"
      placeholder="a root level hash, or a link to its file…"
      aria-label="Root level hash"
      autocomplete="off"
      spellcheck="false"
      @keydown.enter.prevent="emit('submit')"
    >
    <button type="button" class="archive-go primary" :disabled="busy"
            @click="emit('submit')">Open</button>
    <!--
      ⚠️ `autocomplete="off"`, like every other control on these pages: Chrome
      restores a checkbox across a reload, and a switch that comes back ticked
      when the markup says otherwise is a bug that looks like the code.
    -->
    <label class="check archive-deep">
      <input v-model="deep" type="checkbox" autocomplete="off"> Whole backup
    </label>
  </div>
  <p class="archive-note" :class="{ bad }">{{ note || DEFAULT_NOTE }}</p>
  <!-- The rest of what used to be here, whole backup included, is the "open" help topic. -->
  <p class="archive-hint">
    Find a level at
    <a :href="searchHost" target="_blank" rel="noreferrer noopener">zaprit.fish</a>; its page
    shows the <b>root level</b> hash in a box under the title. It comes straight from the
    Internet Archive.
  </p>
</template>
