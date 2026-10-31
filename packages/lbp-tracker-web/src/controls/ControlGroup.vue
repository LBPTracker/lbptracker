<script setup lang="ts">
/**
 * One panel of faders, greyed out while its override is off.
 *
 * ❗ **The grey is not decoration.** Unticked, the group's sliders do nothing —
 * the note falls through to the instrument's own measured parameters — so it
 * has to be obvious at a glance whether what you hear is the game's or yours.
 */
import { computed, inject } from 'vue';
import { CONTROLS, type Group } from './kit.ts';
import Choice from './Choice.vue';
import Fader from './Fader.vue';

const props = defineProps<{ group: Group }>();
const controls = inject(CONTROLS)!;

const faders = controls.fadersIn(props.group.key);
/** The group's own checks, minus the one that gates it — that one is in the heading. */
const checks = controls.checksIn(props.group.key).filter((c) => c.id !== props.group.override);
const off = computed(() => !!props.group.override && !controls.checked[props.group.override]);
</script>

<template>
  <div class="group" :class="{ off }">
    <h3>
      {{ group.title }}
      <label v-if="group.override" class="check">
        <input
          :id="group.override"
          v-model="controls.checked[group.override]"
          type="checkbox"
          autocomplete="off"
        > override
      </label>
    </h3>

    <Choice :group="group.key" />

    <Fader v-for="fader in faders" :key="fader.id" :id="fader.id" />

    <template v-if="checks.length">
      <!-- `stack` gives each check its own row: the MIDI page's read as sentences. -->
      <div
        v-for="(row, i) in group.stack ? checks.map((c) => [c]) : [checks]"
        :key="i"
        class="row"
        style="margin-top:.5rem"
      >
        <span v-if="group.checksLabel && i === 0" class="row-label">{{ group.checksLabel }}</span>
        <label v-for="check in row" :key="check.id" class="check" :title="check.title">
          <input
            :id="check.id"
            v-model="controls.checked[check.id]"
            type="checkbox"
            autocomplete="off"
          > {{ check.label }}
        </label>
      </div>
    </template>

    <!-- Filled by the page: a list rather than a declaration. -->
    <div v-if="group.slotId" :id="group.slotId" style="margin-top:.45rem"></div>

    <p v-if="group.note" class="hintline">{{ group.note }}</p>
  </div>
</template>
