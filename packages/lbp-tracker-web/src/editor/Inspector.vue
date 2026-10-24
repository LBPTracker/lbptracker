<script setup lang="ts">
/**
 * The inspector: the selected placement's settings -- every field of
 * `PInstrument` the game lets a composer set -- and the selected point's.
 * ⚠️ Not the name: a placed instrument cannot be renamed in the game, so
 * `Clip.name` is carried from the file and shown, never edited.
 * The song's own settings are the mixer's (`daw/MixerPanel.vue`).
 *
 * Reads go through `state.version` so the panel follows the canvases; writes
 * go through `state.edit` with a key per control, so a slider drag is one
 * undo step. The song object itself is not reactive -- see `state.ts`.
 */
import { computed } from 'vue';
import { SCALE_NAMES } from '@lbptracker/lib/scale.ts';
import { CLIP_STEP_CHOICES, highestStep, resizeClip, type ChangeKindLike } from './inspector-support.ts';
import { STEPS_PER_BAR, barOfCell, noteName, positionLabel } from './geometry.ts';
import type { Clip } from '@lbptracker/lib/song.ts';
import { chipColour, chipColourValue, type InstrumentInfo } from './instruments.ts';
import { UNTINTED, drawnColour, factoryColour } from '@lbptracker/cwlib/sequencer/chips.ts';
import Glyph from './Glyph.vue';
import { pickInstrument } from './instrument-picker.ts';
import type { EditorState } from './state.ts';

const props = defineProps<{
  state: EditorState;
  instruments: InstrumentInfo[];
  /** Prices for the sound picker, given the chip whose sound is changing. */
  costs?: (clipId: number) => ((guid: number) => { text: string; over: boolean }) | undefined;
}>();
const emit = defineEmits<{ duplicate: []; remove: []; status: [text: string] }>();

// Every computed below touches `version` first so that it re-runs on a change.
// ⚠️ `clip` is a COPY: the song is a plain object and Vue re-runs a computed's
// dependents only when its value differs, so returning the clip itself froze
// the panel after its first render. Reads come from the copy; every write
// goes through `state.edit` to the clip itself.
const clip = computed(() => {
  void props.state.version.value;
  const c = props.state.clip();
  return c ? { ...c } : undefined;
});
const point = computed(() => {
  void props.state.version.value;
  return props.state.point();
});
const stepChoices = CLIP_STEP_CHOICES;
const keyChoices = [
  { value: 0, label: 'default (C)' },
  ...['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'].map((n, i) => ({ value: 12 + i, label: n })),
];

const num = (event: Event) => Number((event.target as HTMLInputElement).value);

const setClip = (kind: ChangeKindLike, key: string, fn: (value: number, c: Clip) => void) => (event: Event) => {
  // A select with no matching option reports '' -- which `Number` reads as 0,
  // and 0 is a real value for the sound (no instrument). Not a change.
  if ((event.target as HTMLInputElement).value === '') return;
  const value = num(event);
  if (!Number.isFinite(value)) return;
  props.state.edit(kind, () => {
    const c = props.state.clip();
    if (c) fn(value, c);
  }, key);
};

/** The instrument the clip plays, for the sound field's glyph and name. */
const sound = computed(() => {
  const c = clip.value;
  return c ? props.instruments.find((i) => i.guid === c.guid) : undefined;
});

/** The sound field: the same modal picker a new chip asks with. */
const chooseSound = async () => {
  const changing = props.state.clip();
  const guid = await pickInstrument(
    props.instruments, 'Which sound?', changing ? props.costs?.(changing.id) : undefined,
  );
  if (guid === null) return;
  props.state.edit('notes', () => {
    const c = props.state.clip();
    if (!c) return;
    // ❗ A chip nobody has tinted takes the new sound's own colour, the way a
    // chip placed from the popit would; one the composer coloured keeps the
    // colour they chose. `UNTINTED` stays as it is -- it already means "the
    // instrument's own", whichever instrument that now is.
    if (c.colour === factoryColour(c.guid)) c.colour = factoryColour(guid);
    c.guid = guid;
  }, 'guid');
};

/**
 * The chip's tint -- `PInstrument.Colour`, which the game draws on the board.
 *
 * ⚠️ **`look`, not `notes`.** Nothing plays it, and rebuilding the plan would
 * cut whatever the chip is sounding for a change to a colour.
 */
const setColour = (event: Event) => {
  const css = (event.target as HTMLInputElement).value;
  props.state.edit('look', () => {
    const c = props.state.clip();
    if (!c) return;
    const factory = factoryColour(c.guid);
    const picked = chipColourValue(css);
    // Picking the instrument's own colour lands on it exactly, low byte and
    // all, so the button reads "default" again rather than "reset".
    if ((picked >>> 8) === (factory >>> 8)) c.colour = factory;
    // ⚠️ **Pure white has to dodge `UNTINTED`**, which it packs to: the board
    // and the exported plan read that as the instrument's own colour, so a
    // white chip would come back as the family's. `fe` in the low byte is a
    // white that is not the neutral, and it is white under every reading of
    // that byte the game might have: ignored it is nothing, and as an opacity
    // it is 99.6%. What the game really does with it is open question 49, in cwlib's steering.
    else if ((picked | 0) === UNTINTED) c.colour = 0xfffffffe | 0;
    else c.colour = picked;
  }, 'colour');
};

/** Back to the colour the instrument's own popit item carries. */
const resetColour = () => {
  props.state.edit('look', () => {
    const c = props.state.clip();
    if (c) c.colour = factoryColour(c.guid);
  });
};

/** The swatch shows what the board draws, so white reads as the sound's own colour. */
const colourCss = (c: { colour: number; guid: number }) => chipColour(drawnColour(c.guid, c.colour));
/** Untinted: the instrument's own colour, however the file spells it. */
const isFactoryColour = (c: { colour: number; guid: number }) =>
  c.colour === factoryColour(c.guid) || c.colour === UNTINTED;

const setSteps = (event: Event) => {
  const c = props.state.clip();
  if (!c) return;
  const wanted = num(event);
  let ok = true;
  props.state.edit('notes', () => {
    ok = resizeClip(c, wanted);
  }, 'steps');
  if (!ok) {
    emit('status', `the grid cannot be shorter than its notes: the last one is on step ${highestStep(c) + 1}`);
    (event.target as HTMLSelectElement).value = String(c.steps);
  }
};

const setPoint = (field: 'pitch' | 'volume' | 'timbre') => (event: Event) => {
  const sel = point.value;
  if (!sel) return;
  const value = num(event);
  props.state.edit('notes', () => {
    sel.point[field] = Math.max(0, Math.min(field === 'timbre' ? 15 : 127, Math.round(value)));
  }, `point-${field}`);
};

const fmt = (v: number, dp = 2) => v.toFixed(dp);
</script>

<template>
  <div class="inspector">
    <div class="group" :class="{ off: !clip }">
      <h3>instrument</h3>
      <template v-if="clip">
        <div class="knob">
          <label for="clipGuid">sound</label>
          <button id="clipGuid" type="button" class="sound-field wide" @click="chooseSound">
            <Glyph v-if="sound" :family="sound.family" :colour="sound.colour" :icon="sound.icon" />
            <span class="sound-name">{{ sound ? sound.name : clip.guid ? `unknown (${clip.guid})` : '(none)' }}</span>
          </button>
        </div>
        <div class="knob">
          <label for="clipSteps">grid</label>
          <select id="clipSteps" class="wide" :value="clip.steps" autocomplete="off" @change="setSteps">
            <option v-for="s in stepChoices" :key="s" :value="s">{{ s / STEPS_PER_BAR }} bars · {{ s }} steps</option>
          </select>
        </div>
        <div class="knob">
          <label for="clipKey">key</label>
          <select id="clipKey" class="wide" :value="clip.key" autocomplete="off"
                  @change="setClip('notes', 'key', (v, c) => { c.key = v; })($event)">
            <option v-for="k in keyChoices" :key="k.value" :value="k.value">{{ k.label }}</option>
          </select>
        </div>
        <div class="knob">
          <label for="clipScale">scale</label>
          <select id="clipScale" class="wide" :value="clip.scale" autocomplete="off"
                  @change="setClip('notes', 'scale', (v, c) => { c.scale = v; })($event)">
            <option v-for="(name, i) in SCALE_NAMES" :key="i" :value="i">{{ name }}</option>
          </select>
        </div>
        <div class="knob">
          <label for="clipLevel">level</label>
          <input id="clipLevel" type="range" min="0" max="200" step="1" :value="Math.round(clip.level * 100)" autocomplete="off"
                 @input="setClip('notes', 'level', (v, c) => { c.level = v / 100; })($event)">
          <output>{{ fmt(clip.level) }}</output>
        </div>
        <div class="knob">
          <label for="clipPan">pan</label>
          <input id="clipPan" type="range" min="0" max="100" step="1" :value="Math.round(clip.pan * 100)" autocomplete="off"
                 @input="setClip('notes', 'pan', (v, c) => { c.pan = v / 100; })($event)">
          <output>{{ fmt(clip.pan) }}</output>
        </div>
        <div class="knob">
          <label for="clipEcho">echo send</label>
          <input id="clipEcho" type="range" min="0" max="100" step="1" :value="Math.round(clip.echoSend * 100)" autocomplete="off"
                 @input="setClip('notes', 'echoSend', (v, c) => { c.echoSend = v / 100; })($event)">
          <output>{{ fmt(clip.echoSend) }}</output>
        </div>
        <div class="knob">
          <label for="clipReverb">reverb send</label>
          <input id="clipReverb" type="range" min="0" max="100" step="1" :value="Math.round(clip.reverbSend * 100)" autocomplete="off"
                 @input="setClip('notes', 'reverbSend', (v, c) => { c.reverbSend = v / 100; })($event)">
          <output>{{ fmt(clip.reverbSend) }}</output>
        </div>
        <div class="knob">
          <label for="clipColour">colour</label>
          <input id="clipColour" class="swatch" type="color" :value="colourCss(clip)" autocomplete="off"
                 title="The chip's colour on the board, the way the game draws it"
                 @input="setColour">
          <button type="button" class="mini" :disabled="isFactoryColour(clip)"
                  title="Back to the colour this instrument comes with"
                  @click="resetColour">{{ isFactoryColour(clip) ? 'default' : 'reset' }}</button>
        </div>
        <div class="row" style="margin-top:.6rem">
          <span class="hintline" style="margin:0">bar {{ barOfCell(clip.cell) }}, row {{ clip.row }} · {{ clip.notes.length }} note{{ clip.notes.length === 1 ? '' : 's' }}</span>
          <span class="spacer"></span>
          <button type="button" @click="emit('duplicate')" title="Ctrl+D">duplicate</button>
          <button type="button" @click="emit('remove')" title="Delete">remove</button>
        </div>
      </template>
      <p v-else class="hintline">Select an instrument on the board.</p>
    </div>

    <div class="group" :class="{ off: !point }">
      <h3>point</h3>
      <template v-if="point">
        <div class="knob">
          <label for="ptPitch">pitch</label>
          <input id="ptPitch" type="range" min="0" max="127" step="1" :value="point.point.pitch" autocomplete="off"
                 @input="setPoint('pitch')($event)">
          <output>{{ noteName(point.point.pitch) }} · {{ point.point.pitch }}</output>
        </div>
        <div class="knob">
          <label for="ptVolume">volume</label>
          <input id="ptVolume" type="range" min="0" max="127" step="1" :value="point.point.volume" autocomplete="off"
                 @input="setPoint('volume')($event)">
          <output>{{ point.point.volume }}</output>
        </div>
        <div class="knob">
          <label for="ptTimbre">timbre</label>
          <input id="ptTimbre" type="range" min="0" max="15" step="1" :value="point.point.timbre" autocomplete="off"
                 @input="setPoint('timbre')($event)">
          <output>{{ point.point.timbre }} / 15</output>
        </div>
        <p class="hintline">
          At {{ positionLabel(point.point.thirds) }}, point {{ point.index + 1 }} of {{ point.note.points.length }}.
        </p>
      </template>
      <p v-else class="hintline">Click a point on the grid.</p>
    </div>
  </div>
</template>
