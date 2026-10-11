<script setup lang="ts">
/** The `<select>`s of one group, label and all. */
import { inject } from 'vue';
import { CONTROLS } from './kit.ts';

const props = defineProps<{ group: string }>();
const controls = inject(CONTROLS)!;
const choices = controls.choicesIn(props.group);
</script>

<template>
  <div v-for="(choice, i) in choices" :key="choice.id" class="row"
       :style="i ? 'margin-top:.5rem' : undefined">
    <label :for="choice.id" :title="choice.title">{{ choice.label }}</label>
    <select :id="choice.id" v-model="controls.chosen[choice.id]" :title="choice.title" autocomplete="off">
      <option v-for="option in choice.options" :key="option.value" :value="option.value">
        {{ option.label }}
      </option>
    </select>
  </div>
</template>
