<script setup lang="ts">
/**
 * The song's own settings: the fields of `PSequencer` a composer sets in the
 * game that have no other place in the app -- the channel count and faders,
 * tempo, swing, the echo and the reverb.
 *
 * Reads go through `state.version` so the panel follows the canvases; writes
 * go through `state.edit` with a key per control, so a slider drag is one
 * undo step. Tempo, swing, channels and faders are applied to the running
 * player without a rebuild (`Player.setSettings`); the echo and the reverb are
 * one message to the worklet.
 */
import { computed } from 'vue';
import { MIXER_CHANNELS, type Song } from '@lbptracker/lib/song.ts';
import { REVERB_SETTINGS, reverbSummary } from '@lbptracker/lib/audio/effects.ts';
import { bandOf } from '../editor/geometry.ts';
import type { EditorState } from '../editor/state.ts';
import type { ChangeKind } from '../editor/state.ts';

const props = defineProps<{ state: EditorState }>();

/**
 * ⚠️ A COPY, taken on every change. The song is a plain object, and a computed
 * that returned it unchanged would not re-run its dependents -- Vue notifies
 * only when a computed's value differs -- so the panel froze at its first
 * render and a new channel's fader never appeared. The copy is for reading;
 * every write goes through `state.edit` to the song itself.
 */
const song = computed((): Song => {
  void props.state.version.value;
  return { ...props.state.song };
});
const channels = computed(() => Array.from({ length: song.value.numChannels }, (_, i) => i));
/** How many chips land on each channel, through the board's bands. */
const perChannel = computed(() => {
  const s = song.value;
  const counts = new Array<number>(s.numChannels).fill(0);
  for (const c of s.clips) counts[bandOf(c.row, s.boardRows, s.numChannels)] += 1;
  return counts;
});

const num = (event: Event) => Number((event.target as HTMLInputElement).value);
const set = (kind: ChangeKind, key: string, fn: (value: number, s: Song) => void) => (event: Event) => {
  const value = num(event);
  if (!Number.isFinite(value)) return;
  props.state.edit(kind, (s) => fn(value, s), key);
};
const fmt = (v: number) => v.toFixed(2);

/**
 * One channel more or fewer, between one and the game's limit. ❗ No undo key:
 * each press is its own step, where a key would fold quick presses into one.
 */
const addChannels = (delta: number) => {
  props.state.edit('settings', (s) => {
    s.numChannels = Math.max(1, Math.min(MIXER_CHANNELS, s.numChannels + delta));
  });
};

/**
 * The reverb is a **choice, not a dial**: `ReverbSetting` picks one of the
 * game's presets, and a slider through it crossed values the game never uses
 * and suggested a range where there is a list of six. Each option carries the
 * game's own name for that setting and how long it rings, with the rest of the
 * measured record in its tooltip (`REVERB_NAMES`, `reverbSummary`). A song
 * that arrives with a setting outside the list keeps it, rather than being
 * quietly moved to one we know.
 */
const reverbOptions = computed(() => {
  const settings = [...REVERB_SETTINGS];
  if (!settings.includes(song.value.reverb)) settings.push(song.value.reverb);
  return settings.sort((a, b) => a - b).map((setting) => {
    const r = reverbSummary(setting);
    const damping = r.dampingHz === null ? 'no damping' : `damping ${(r.dampingHz / 1000).toFixed(0)} kHz`;
    return {
      setting,
      label: r.name ? `${r.name} · ${r.decaySeconds.toFixed(1)} s` : `setting ${setting} · ${r.decaySeconds.toFixed(1)} s`,
      title: `setting ${setting}, preset ${r.preset}: ${r.decaySeconds.toFixed(1)} s decay, `
        + `${r.preDelayMs} ms before the late field, ${damping}, `
        + `late ${r.lateDb} dB, early ${r.earlyDb} dB`,
    };
  });
});
</script>

<template>
  <div class="mx">
    <!-- Not here, because they have a place of their own: the name and the author
         (the name in the top bar), the loop (the transport's button, L on the
         board) and the board's rows (its "+" strip and a row's "x"). -->
    <!-- A strip per channel, as a mixing desk has: its fader upright, the level
         under it, and how many chips the board bands into it. -->
    <div class="mx-strips">
      <div v-for="ch in channels" :key="ch" class="mx-strip" :title="`${perChannel[ch]} chips on this channel`">
        <label class="mx-ch" :for="`mx-vol${ch}`">ch {{ ch }}</label>
        <input :id="`mx-vol${ch}`" class="mx-fader" type="range" min="0" max="150" step="1"
               :value="Math.round(song.volumes[ch] * 100)" autocomplete="off"
               @input="set('settings', `vol${ch}`, (v, s) => { s.volumes[ch] = v / 100; })($event)">
        <output>{{ fmt(song.volumes[ch]) }}</output>
        <span class="mx-count">{{ perChannel[ch] }} {{ perChannel[ch] === 1 ? 'chip' : 'chips' }}</span>
      </div>
      <div class="mx-strip-add">
        <button type="button" title="Add a channel" aria-label="Add a channel"
                :disabled="song.numChannels >= MIXER_CHANNELS" @click="addChannels(1)">+</button>
        <button type="button" title="Remove the last channel" aria-label="Remove the last channel"
                :disabled="song.numChannels <= 1" @click="addChannels(-1)">&minus;</button>
        <span class="mx-count">{{ song.numChannels }} of {{ MIXER_CHANNELS }}</span>
      </div>
    </div>

    <div class="mx-columns">
      <div class="group">
        <h3>song</h3>
        <div class="knob">
          <label for="mx-tempo">tempo</label>
          <input id="mx-tempo" type="range" min="20" max="400" step="1" :value="song.tempo" autocomplete="off"
                 @input="set('settings', 'tempo', (v, s) => { s.tempo = v; })($event)">
          <output>{{ song.tempo }} BPM</output>
        </div>
        <div class="knob">
          <label for="mx-swing">swing</label>
          <input id="mx-swing" type="range" min="0" max="99" step="1" :value="Math.round(song.swing * 100)" autocomplete="off"
                 @input="set('settings', 'swing', (v, s) => { s.swing = v / 100; })($event)">
          <output>{{ fmt(song.swing) }}</output>
        </div>
      </div>

      <div class="group">
        <h3>effects</h3>
        <div class="knob">
          <label for="mx-echoTime">echo time</label>
          <input id="mx-echoTime" type="range" min="0" max="80" step="1" :value="Math.round(song.echoTime * 10)" autocomplete="off"
                 @input="set('effects', 'echoTime', (v, s) => { s.echoTime = v / 10; })($event)">
          <output>{{ fmt(song.echoTime) }} beats</output>
        </div>
        <div class="knob">
          <label for="mx-echoFb">feedback</label>
          <input id="mx-echoFb" type="range" min="0" max="95" step="1" :value="Math.round(song.echoFeedback * 100)" autocomplete="off"
                 @input="set('effects', 'echoFb', (v, s) => { s.echoFeedback = v / 100; })($event)">
          <output>{{ fmt(song.echoFeedback) }}</output>
        </div>
        <div class="knob">
          <label for="mx-echoMix">echo mix</label>
          <input id="mx-echoMix" type="range" min="0" max="100" step="1" :value="Math.round(song.echoMix * 100)" autocomplete="off"
                 @input="set('effects', 'echoMix', (v, s) => { s.echoMix = v / 100; })($event)">
          <output>{{ fmt(song.echoMix) }}</output>
        </div>
        <div class="knob">
          <label for="mx-reverb">reverb</label>
          <select id="mx-reverb" class="wide" :value="song.reverb" autocomplete="off"
                  @change="set('effects', 'reverb', (v, s) => { s.reverb = v; })($event)">
            <option v-for="o in reverbOptions" :key="o.setting" :value="o.setting" :title="o.title">{{ o.label }}</option>
          </select>
        </div>
      </div>
    </div>
  </div>
</template>
