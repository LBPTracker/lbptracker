<script setup lang="ts">
/**
 * One labelled slider, drawn from its row of the page's spec.
 *
 * ⚠️ **The `<output>` has no id and nothing writes to it.** The old markup gave
 * every fader a matching `<output id="${id}Label">` and the page's module filled
 * it by string join, which is how a label could end up describing a different
 * slider. Here the number shown comes from the same `per` the engine is given.
 */
import { inject } from 'vue';
import { CONTROLS } from './kit.ts';

const props = defineProps<{ id: string }>();
const controls = inject(CONTROLS)!;
const fader = controls.fader(props.id);
</script>

<template>
  <div class="knob">
    <label :for="id">{{ fader.label }}</label>
    <!-- Double-click a fader to put it back where it started. -->
    <input
      :id="id"
      v-model.number="controls.positions[id]"
      type="range"
      :min="fader.min"
      :max="fader.max"
      :step="fader.step ?? 1"
      :disabled="controls.disabled(id)"
      autocomplete="off"
      @dblclick="controls.reset(id)"
    >
    <output>{{ controls.shown(id) }}</output>
  </div>
</template>
