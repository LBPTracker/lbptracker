/**
 * A sequencer to an Ableton Live set (`.als`): one MIDI track per part, one
 * arrangement clip per placement, and every glide as MPE per-note expression.
 *
 * `sequencerdump` wrote one of these as well, and its output is the reason this
 * file is shaped the way it is. Measured 2026-09-24 by opening its files in
 * Live 11.3.43: **they claim schema `12.0_12049`, which Live 11 refuses
 * outright** -- and with only the version rewritten, Live 11 opens the set,
 * names the tracks, takes the tempo, and **shows every clip slot empty**. Live 11
 * fills a missing member with its default and says nothing; Live 12 refuses the
 * same file and names the member (`Member "FollowActionEnabled" of Class
 * FollowAction is missing`, from the owner's own attempt at a set written from
 * scratch). So a set that loads is not a set that says anything, and the only
 * safe file is one that carries **every member Live itself writes**.
 *
 * ❗ **That is what this module does: it writes the Live 11.3 schema member for
 * member**, as Live 11.3.43 saves an empty set and as it saves an arrangement
 * clip with MPE (the Core Library's own demo set, `11.0_11300`). Live 11 opens
 * it; Live 12 upgrades an 11 set on open, and nothing opens the other way round,
 * which is why the target is 11 and not 12. `steering/ableton-interchange.md`
 * has how it was checked and what the check cannot see.
 *
 * What goes where:
 *
 * | the sequencer | the set |
 * |---|---|
 * | a part -- one instrument, row and mixer (`partKey`) | a MIDI track, named as the MIDI export names it |
 * | parts of one row and instrument never sounding together | one track (`mergeRows`, the MIDI export's `rowGroups`), the mixer stepping where each takes over |
 * | a placement | an arrangement clip at its own cell, `stepOffset / 4` beats, as long as its chip (`clipSteps`) |
 * | placements on one track whose notes reach into the next | one clip over the union: Live plays one clip per track at a time |
 * | a chip covering the next one on its track with silence | cut where the next begins |
 * | a note's first control point | the note: the sounding key, velocity -- with a Sampler the raw key, `Key` and the scale then pitch |
 * | the glide | per-note pitch, **the control points as written** |
 * | the volume ramp -- and with a Sampler, every note's level | per-note pressure |
 * | the modulation | per-note slide, CC 74 -- with a Sampler, the filter cutoff it gives; its level rides on the pressure |
 * | `level` x the channel's volume, and `pan` | the track's volume and pan, through Live's pan law backwards so each channel gets the engine's gain (`mixerOf`) |
 * | `reverbSend` | send A, into the Reverb return |
 * | `echoSend` | send B, into the Echo return: the engine's send, the instrument's own `Params[25]` bent by it (`echoSendLevel`) |
 * | the chip's tint | the nearest of Live's 70 colours (`liveColour`), on the track and on each clip |
 * | tempo | the master's tempo |
 * | the tracker's master bus, when asked for | Live's Compressor and Limiter on the master (`als-master.ts`) |
 * | swing | a groove in the pool that every clip follows (`swingGrooveXml`) -- or, with `bakeSwing`, the notes' own times |
 *
 * ⚠️ **A glide is written as its control points and nothing else.** Live draws
 * per-note expression as straight segments between breakpoints -- the curve
 * controls at 0.5 are a straight line -- and the engine glides linearly between
 * records, so the two are the same shape. MIDI had to resample a glide into a
 * staircase of bend messages; here the resampling, the simplifier that folds it
 * back and the fifteen-channel budget that rationed it are all simply absent.
 *
 * What it cannot say: the instrument, unless `instruments` is given -- then each
 * track holds a Sampler built from it (`als-sampler.ts`), and otherwise the
 * tracks are empty -- and a glide wider than 48 semitones, Live's per-note range.
 */

import { drawnColour } from '@lbptracker/cwlib/chips.ts';
import { channelVolume, schedule, type Sequencer, type Track } from '@lbptracker/cwlib/project.ts';
import { deviceHead, dial, Ids, num, routings, target, toggle, v } from './als-xml.ts';
import { partKey, partLabel, rowGroups } from './midi.ts';
import { blockRoot, keyOffset, notePitch } from './scale.ts';
import { masterBusDevices } from './als-master.ts';
import {
  heardLevel, heldDial, LIVE_SLIDE_SEMITONES, playsPitched, samplerDevice, samplerSampleFile, slotRate, trackingRoot,
  type AlsInstrumentSource, type SamplerSample,
} from './als-sampler.ts';
import type { MasterSettings } from './audio/master.ts';
import { evaluateParam } from './envelope.ts';
import { OUTPUT_PARAMS, echoSendLevel } from './params.ts';
import type { RInstrument } from './rinstrument.ts';
import { clipStepsFor } from './song.ts';
import { swungFrame } from './swing.ts';

/** Sequencer steps in a Live beat: the grid is sixteenths. */
const STEPS_PER_BEAT = 4;

/**
 * Live's per-note pitch range, in semitones either way.
 *
 * Read off the Core Library's MPE demo (`Ninajirachi - In The Rain`): its
 * per-note pitch values sit at 170.7 per semitone -- `341.3125` for a tone,
 * `1194.59` for a fifth -- which is 8192 over 48, MPE's own default. 582 of the
 * corpus's control points glide further than that (`midi-interchange.md`), and
 * those are clamped and counted.
 */
export const ALS_BEND_RANGE = 48;
const BEND_PER_SEMITONE = 8192 / ALS_BEND_RANGE;

/** Live's Sampler filter dial, top and bottom, in Hz: its own range (`als-sampler.ts`'s tree). */
const FILTER_OPEN_HZ = 22000;
const FILTER_FLOOR_HZ = 30;

/** Live's session grid is eight scenes in its own empty set; every track carries a slot per scene. */
const SCENES = 8;

/** A Live fader's range as linear gain: -70 dB, which Live shows as -inf, to +6 dB. */
const LIVE_FADER_FLOOR = 0.0003162277571;
const LIVE_FADER_CEILING = 1.99526238;

export interface AlsExportOptions {
  /** A GUID to a readable instrument name, for the track names -- as `MidiExportOptions`. */
  readonly instrumentName?: (guid: number) => string | undefined;
  /**
   * Write the swung positions rather than the straight grid.
   *
   * Off by default for the same reason as the MIDI export's: the straight grid
   * is what the sequencer holds, and a DAW grid that the notes sit on is what
   * makes the set editable. Off, the swing is a groove every clip follows
   * (`swingGrooveXml`) and Live swings the notes as it plays them; on, every
   * time in the set -- starts, ends, the glides' control points -- is where
   * the engine plays it, and there is no groove.
   */
  readonly bakeSwing?: boolean;
  /**
   * One track per board row and instrument, not per part -- on by default.
   *
   * The grouping is the MIDI export's own (`rowGroups`, and
   * `MidiExportOptions.mergeRows` for why), so the two files have the same
   * tracks. What it buys here is an instrument to load per row rather than per
   * mixer setting: `This Is Halloween` is 124 parts on 46 tracks. The parts a
   * track holds differ in level, pan or a send, and that difference becomes
   * the track's mixer automation.
   */
  readonly mergeRows?: boolean;
  /**
   * The game's instruments, by `RInstrument` GUID, with the sample files they
   * play -- and with them a Sampler on every track that has one
   * (`als-sampler.ts`). Absent, the tracks are empty, which is the default:
   * the set is then a file of notes and nothing else of the game's.
   */
  readonly instruments?: ReadonlyMap<number, AlsInstrumentSource>;
  /**
   * The game's instruments by GUID, without their samples, for what the
   * engine reads off an instrument into the mix: its own echo send,
   * `Params[25]`, which the placement's `echoSend` only bends
   * (`echoSendLevel`). `instruments` supplies it as well; this is for a set
   * of notes alone, which carries no instrument of the game's but still
   * plays each part into the echo at the game's level.
   *
   * ⚠️ An instrument found in neither is taken to send nothing of its own,
   * as 33 of the 68 do; the placement's field then still mutes or forces it.
   */
  readonly instrumentSettings?: ReadonlyMap<number, RInstrument>;
  /**
   * Each placement's note grid in steps, by its index in `Sequencer.tracks`:
   * how long its chip is on the board, and so its clip.
   *
   * ⚠️ **The file does not hold it** (`clipStepsFor` in `song.ts`), so a
   * sequencer read from a level gets it the way the editor does on load, from
   * the notes; the editor passes its own `Clip.steps`, which is the length the
   * composer drew. Absent, or absent for a placement, it is derived.
   */
  readonly clipSteps?: readonly number[];
  /**
   * The tracker's own master bus on the master track: Live's Compressor set as
   * the glue and Live's Limiter (`als-master.ts`). Absent, the master holds no
   * device, which is the default: like the master bus itself, it is ours and
   * not the game's.
   */
  readonly masterBus?: MasterSettings;
}

export interface AlsExportResult {
  /** The set as XML. An `.als` is this, gzipped -- the caller owns the compressor. */
  readonly xml: string;
  /** MIDI tracks written, not counting the returns. */
  readonly tracks: number;
  /** Parts, which `tracks` is at most: `mergeRows` puts several on one track. */
  readonly parts: number;
  /** Mixer steps written as automation: a part taking a track over with a different mixer. */
  readonly switches: number;
  /** Arrangement clips written. */
  readonly clips: number;
  /** Placements, which `clips` is at most: overlapping ones share a clip. */
  readonly placements: number;
  readonly notes: number;
  /** Notes whose pitch moves: a glide, as the engine plays it. */
  readonly glides: number;
  /** Notes whose key left 0..127 and was clamped to it. */
  readonly clampedPitch: number;
  /** Control points that glided past ±48 semitones and were clamped. */
  readonly clampedBend: number;
  /** Control points whose modulation moves the filter further than the slide's 72 semitones, which stop there. */
  readonly clampedSlide: number;
  /**
   * Notes that begin while another of the same key on the same clip is still
   * sounding. Counted, not lost.
   *
   * ✔ **Live keeps both.** Measured 2026-09-24: a clip holding a four-beat note
   * with a one-beat note of the same key on top, and a two-step note re-struck a
   * step later, opened in Live with every note at its full length and the
   * overlaps drawn darker, where two notes lie on one another. This said
   * "Live ends the earlier where the later begins" until then, which was a
   * guess. Over the corpus: 11,528 of 953,791 notes, 11,397 of them inside one
   * placement. Whether an instrument voices both is the instrument's affair.
   */
  readonly overlapping: number;
  /**
   * The WAVs the set's Samplers play, for the project's `Samples/Imported`.
   * Empty unless `instruments` was given.
   */
  readonly samples: readonly { readonly file: string; readonly bytes: Uint8Array }[];
  /** Tracks that got a Sampler. */
  readonly instrumentTracks: number;
  /**
   * Notes whose modulation is not the one their track's Sampler is set at.
   * Their level (the pressure) and their filter cutoff (the slide) follow
   * their own; the envelopes, the resonance and the rest are the track's.
   */
  readonly offModulation: number;
}

/* ------------------------------------------------------------------ the XML */


interface MixerSettings {
  readonly volume: number;
  readonly pan: number;
  /** One value per return track; `undefined` writes no `Sends` at all (the master's). */
  readonly sends?: readonly number[];
  /**
   * Which sends are switched on, one per send; all of them when omitted. A
   * return track's sends into the returns exist and are off unless one is used.
   */
  readonly sendsActive?: readonly boolean[];
  readonly width?: number;
  /** The master's own dials: tempo and the rest. */
  readonly tempo?: number;
}

const fader = (x: number) => Math.min(LIVE_FADER_CEILING, Math.max(LIVE_FADER_FLOOR, x));
const sendLevel = (x: number) => fader(Math.min(1, x));
const panValue = (x: number) => Math.min(1, Math.max(-1, x));

/** The automation target of each mixer dial a part sets, filled in as the mixer is written. */
interface MixerTargets {
  volume?: number;
  pan?: number;
  sends: number[];
}

function mixer(ids: Ids, m: MixerSettings, targets?: MixerTargets): string {
  const sends = m.sends === undefined
    ? '<Sends />'
    : [
      '<Sends>',
      ...m.sends.map((amount, i) => [
        `<TrackSendHolder Id="${i}">`,
        dial(ids, 'Send', sendLevel(amount), LIVE_FADER_FLOOR, 1, (id) => {
          if (targets) targets.sends[i] = id;
        }),
        v('Active', m.sendsActive?.[i] ?? true), '</TrackSendHolder>',
      ].join('\n')),
      '</Sends>',
    ].join('\n');
  const master = m.tempo === undefined ? [] : [
    dial(ids, 'Tempo', m.tempo, 60, 200),
    // 201 is 4/4: Live's enum is `denominator index * 99 + numerator - 1`.
    ['<TimeSignature>', v('LomId', 0), v('Manual', 201), target(ids), '</TimeSignature>'].join('\n'),
    dial(ids, 'GlobalGrooveAmount', 100, 0, 131.25),
    dial(ids, 'CrossFade', 0, -1, 1),
    v('TempoAutomationViewBottom', 60), v('TempoAutomationViewTop', 200),
  ];
  return [
    '<Mixer>',
    deviceHead(ids),
    sends,
    toggle(ids, 'Speaker'),
    v('SoloSink', false), v('PanMode', 0),
    dial(ids, 'Pan', panValue(m.pan), -1, 1, (id) => {
      if (targets) targets.pan = id;
    }),
    dial(ids, 'SplitStereoPanL', -1, -1, 1),
    dial(ids, 'SplitStereoPanR', 1, -1, 1),
    dial(ids, 'Volume', fader(m.volume), LIVE_FADER_FLOOR, LIVE_FADER_CEILING, (id) => {
      if (targets) targets.volume = id;
    }),
    v('ViewStateSesstionTrackWidth', m.width ?? 93),
    ['<CrossFadeState>', v('LomId', 0), v('Manual', 1), target(ids), '</CrossFadeState>'].join('\n'),
    '<SendsListWrapper LomId="0" />',
    ...master,
    '</Mixer>',
  ].join('\n');
}

/** A track's opening members, down to `LinkedTrackGroupId`; `envelopes` is its automation. */
const trackHead = (name: string, color: number, unfolded: boolean, envelopes: readonly string[] = []) => [
  v('LomId', 0), v('LomIdView', 0), v('IsContentSelectedInDocument', false), v('PreferredContentViewMode', 0),
  '<TrackDelay>', v('Value', 0), v('IsValueSampleBased', false), '</TrackDelay>',
  '<Name>', v('EffectiveName', name), v('UserName', name), v('Annotation', ''), v('MemorizedFirstClipName', ''), '</Name>',
  v('Color', color),
  envelopes.length === 0
    ? '<AutomationEnvelopes>\n<Envelopes />\n</AutomationEnvelopes>'
    : ['<AutomationEnvelopes>', '<Envelopes>', ...envelopes, '</Envelopes>', '</AutomationEnvelopes>'].join('\n'),
  v('TrackGroupId', -1), v('TrackUnfolded', unfolded),
  '<DevicesListWrapper LomId="0" />', '<ClipSlotsListWrapper LomId="0" />', v('ViewData', '{}'),
  '<TakeLanes>\n<TakeLanes />', v('AreTakeLanesFolded', true), '</TakeLanes>',
  v('LinkedTrackGroupId', -1),
].join('\n');

const lanes = (selectedDevice: number) => [
  '<AutomationLanes>', '<AutomationLanes>', '<AutomationLane Id="0">',
  v('SelectedDevice', selectedDevice), v('SelectedEnvelope', 0),
  v('IsContentSelectedInDocument', false), v('LaneHeight', 68),
  '</AutomationLane>', '</AutomationLanes>', v('AreAdditionalAutomationLanesFolded', false), '</AutomationLanes>',
  '<ClipEnvelopeChooserViewState>', v('SelectedDevice', 0), v('SelectedEnvelope', 0),
  v('PreferModulationVisible', false), '</ClipEnvelopeChooserViewState>',
].join('\n');

const clipSlots = (count: number) => count === 0 ? '<ClipSlotList />' : [
  '<ClipSlotList>',
  ...Array.from({ length: count }, (_, i) => [
    `<ClipSlot Id="${i}">`, v('LomId', 0), '<ClipSlot>\n<Value />\n</ClipSlot>',
    v('HasStop', true), v('NeedRefreeze', true), '</ClipSlot>',
  ].join('\n')),
  '</ClipSlotList>',
].join('\n');

const emptyArrangement = [
  '<ArrangerAutomation>', '<Events />',
  '<AutomationTransformViewState>', v('IsTransformPending', false), '<TimeAndValueTransforms />',
  '</AutomationTransformViewState>', '</ArrangerAutomation>',
].join('\n');

/** The audio sequencer every track keeps for freezing, empty. */
const freezeBody = (ids: Ids, slots: number) => [
  deviceHead(ids),
  clipSlots(slots),
  v('MonitoringEnum', 1),
  '<Sample>', emptyArrangement, '</Sample>',
  target(ids, 'VolumeModulationTarget'),
  target(ids, 'TranspositionModulationTarget'),
  target(ids, 'GrainSizeModulationTarget'),
  target(ids, 'FluxModulationTarget'),
  target(ids, 'SampleOffsetModulationTarget'),
  v('PitchViewScrollPosition', -1073741824), v('SampleOffsetModulationScrollPosition', -1073741824),
  '<Recorder>', v('IsArmed', false), v('TakeCounter', 1), '</Recorder>',
].join('\n');

const emptyDevices = '<DeviceChain>\n<Devices />\n<SignalModulations />\n</DeviceChain>';

/* ---------------------------------------------------------------- the two effects */

/**
 * One member of a Live device: a float dial, an on/off switch, an enum, or a
 * plain value -- the four shapes every member of Live's Reverb and Delay takes.
 */
type DeviceMember =
  | readonly ['f', name: string, manual: number, min: number, max: number]
  | readonly ['b', name: string, manual: boolean]
  | readonly ['e', name: string, manual: number]
  | readonly ['v', name: string, value: number | boolean];

/**
 * Live's Reverb and Delay, member for member, at the values Live 11.3.43 saved
 * them with in an empty set.
 *
 * ❗ **Derived, not transcribed**: a script read both devices out of the owner's
 * own empty set, reduced each to these four shapes, and rebuilt the XML from
 * the reduction; the rebuild matched the original line for line but for the
 * ids, the preset reference and the name. `steering/ableton-interchange.md`.
 */
const REVERB: readonly DeviceMember[] = [
  ['f', 'PreDelay', 2.5, 0.5, 250], ['b', 'BandHighOn', true], ['b', 'BandLowOn', true],
  ['f', 'BandFreq', 829.999939, 50, 18000], ['f', 'BandWidth', 5.8499999, 0.5, 9], ['b', 'SpinOn', true],
  ['f', 'EarlyReflectModFreq', 0.2535530031, 0.07400000095, 1.29999995],
  ['f', 'EarlyReflectModDepth', 3, 2, 55], ['f', 'DiffuseDelay', 0.5, 0, 1], ['b', 'ShelfHighOn', true],
  ['e', 'HighFilterType', 0], ['f', 'ShelfHiFreq', 4500.00049, 20, 16000],
  ['f', 'ShelfHiGain', 0.6999999881, 0.200000003, 1], ['b', 'ShelfLowOn', false],
  ['f', 'ShelfLoFreq', 90, 20, 15000], ['f', 'ShelfLoGain', 0.75, 0.200000003, 1], ['b', 'ChorusOn', true],
  ['f', 'SizeModFreq', 0.01999999955, 0.009999999776, 8], ['f', 'SizeModDepth', 0.01999999955, 0.009999999776, 4],
  ['f', 'DecayTime', 2500, 200, 60000], ['f', 'AllPassGain', 0.6000000238, 0.001000000047, 0.9599999785],
  ['f', 'AllPassSize', 0.400000006, 0.05000000075, 1], ['b', 'FreezeOn', false], ['b', 'FlatOn', true],
  ['b', 'CutOn', true], ['f', 'RoomSize', 100.000008, 0.2220000029, 500], ['e', 'SizeSmoothing', 0],
  ['f', 'StereoSeparation', 100, 0, 120], ['e', 'RoomType', 3],
  ['f', 'MixReflect', 1, 0.02999999933, 1.99530005], ['f', 'MixDiffuse', 1, 0.02999999933, 1.99530005],
  ['f', 'MixDirect', 1, 0, 1], ['v', 'StereoSeparationOnDrySignal', false],
];

const DELAY: readonly DeviceMember[] = [
  ['e', 'DelayLine_SmoothingMode', 0], ['b', 'DelayLine_Link', false], ['b', 'DelayLine_PingPong', false],
  ['b', 'DelayLine_SyncL', true], ['b', 'DelayLine_SyncR', true],
  ['f', 'DelayLine_TimeL', 0.02209999785, 0.001000000047, 5], ['f', 'DelayLine_TimeR', 0.02289999276, 0.001000000047, 5],
  ['f', 'DelayLine_SimpleDelayTimeL', 22.1000004, 1, 300], ['f', 'DelayLine_SimpleDelayTimeR', 22.8999996, 1, 300],
  ['f', 'DelayLine_PingPongDelayTimeL', 1, 1, 999], ['f', 'DelayLine_PingPongDelayTimeR', 1, 1, 999],
  ['e', 'DelayLine_SyncedSixteenthL', 2], ['e', 'DelayLine_SyncedSixteenthR', 2],
  ['f', 'DelayLine_OffsetL', 0, -0.3330000043, 0.3330000043], ['f', 'DelayLine_OffsetR', 0, -0.3330000043, 0.3330000043],
  ['v', 'DelayLine_CompatibilityMode', 0], ['f', 'Feedback', 0.2099999934, 0, 0.9499999881],
  ['b', 'Freeze', false], ['b', 'Filter_On', false], ['f', 'Filter_Frequency', 999.999878, 49.9999962, 18000.0059],
  ['f', 'Filter_Bandwidth', 8, 0.5, 9], ['f', 'Modulation_Frequency', 0.5, 0.01000000071, 39.9999962],
  ['f', 'Modulation_AmountTime', 0, 0, 1], ['f', 'Modulation_AmountFilter', 0, 0, 1], ['f', 'DryWet', 1, 0, 1],
  ['v', 'DryWetMode', 1], ['v', 'EcoProcessing', false],
];

/** A Live device from its members, with `set` overriding the saved values by name. */
function device(
  ids: Ids,
  tag: string,
  id: number,
  members: readonly DeviceMember[],
  set: Readonly<Record<string, number | boolean>>,
): string {
  const body = members.map((member) => {
    const [kind, name] = member;
    const value = name in set ? set[name] : member[2];
    if (kind === 'f') {
      const [, , , min, max] = member;
      return dial(ids, name, Math.min(max, Math.max(min, value as number)), min, max);
    }
    if (kind === 'b') return toggle(ids, name, value as boolean);
    if (kind === 'e') {
      return [`<${name}>`, v('LomId', 0), v('Manual', value), target(ids), `</${name}>`].join('\n');
    }
    return v(name, value);
  });
  return [`<${tag} Id="${id}">`, deviceHead(ids), v('OverwriteProtectionNumber', 2819), ...body, `</${tag}>`].join('\n');
}

/**
 * The reverb the sequencer picked, on Live's Reverb.
 *
 * `ReverbSetting` 0..5 are the six the game's menu offers, with their decay,
 * pre-delay and damping measured off the preset table
 * (`steering/lbp-audio-engine.md`, *The six the sequencer offers*); 6 and 7
 * are padding onto preset 0 and no menu offers them, so they take Small Room.
 * Two different algorithms: this sets what the two have in common -- how long
 * it rings, when the tail arrives, how dark it is, and how loud the early
 * reflections are against it -- and not a sample of the game's sound.
 */
const REVERB_SETTINGS: readonly {
  readonly decay: number; readonly preDelay: number; readonly damping?: number;
  readonly late: number; readonly early: number;
}[] = [
  { decay: 0.6, preDelay: 1, damping: 5000, late: -20, early: -50 }, // Small Room
  { decay: 1.2, preDelay: 5, damping: 5000, late: -10, early: -110 }, // Room
  { decay: 2.0, preDelay: 15, late: -25, early: -50 }, // Bright Plate: no damping
  { decay: 1.2, preDelay: 5, damping: 5000, late: -15, early: -55 }, // Hall
  { decay: 5.0, preDelay: 45, damping: 10000, late: -28, early: -46 }, // Big Hall
  { decay: 3.0, preDelay: 70, damping: 7000, late: -16, early: -52 }, // Cathedral
];

function reverbDevice(ids: Ids, setting: number): string {
  const r = REVERB_SETTINGS[setting] ?? REVERB_SETTINGS[0];
  return device(ids, 'Reverb', 0, REVERB, {
    DecayTime: r.decay * 1000,
    PreDelay: r.preDelay,
    ShelfHighOn: r.damping !== undefined,
    ...(r.damping !== undefined ? { ShelfHiFreq: r.damping } : {}),
    // The late field at Live's own level and the early reflections as far
    // below it as the game has them; Live's floor for either is -30 dB.
    MixDiffuse: 1,
    MixReflect: 10 ** ((r.early - r.late) / 20),
    MixDirect: 1,
  });
}

/**
 * Live's synced delay times, in sixteenths, by `DelayLine_SyncedSixteenth`.
 *
 * Index 2 is 3 sixteenths, read off the empty set's own delay, which carries
 * Live's "Dotted Eighth Note" preset at 2; the rest of the list is Live's
 * menu as shown in the device (`steering/ableton-interchange.md`).
 */
const DELAY_SIXTEENTHS = [1, 2, 3, 4, 5, 6, 8, 16];

/**
 * The echo on Live's Delay: `EchoTime` beats, synced where Live's menu has
 * that many sixteenths -- 2, 1 and 1.5 beats, which are 189 + 95 + 47 = 331 of
 * the corpus's 338 sequencers (`../cwlib-ts/steering/sequencer-data-model.md`) -- and in seconds at
 * the song's tempo otherwise. Feedback
 * clamps at 0.95 in both, the engine's `0x0793` and Live's own maximum.
 */
function delayDevice(ids: Ids, echoTime: number, feedback: number, tempo: number): string {
  const sync = DELAY_SIXTEENTHS.indexOf(echoTime * 4);
  const seconds = (echoTime * 60) / tempo;
  return device(ids, 'Delay', 0, DELAY, {
    DelayLine_Link: true,
    DelayLine_SyncL: sync >= 0,
    DelayLine_SyncR: sync >= 0,
    ...(sync >= 0
      ? { DelayLine_SyncedSixteenthL: sync, DelayLine_SyncedSixteenthR: sync }
      : { DelayLine_TimeL: seconds, DelayLine_TimeR: seconds }),
    Feedback: Math.min(0.95, Math.max(0, feedback)),
    DryWet: 1,
  });
}

/* ---------------------------------------------------------------- the clips */

/** One control point of one per-note list: where, in beats from the note's start, and what. */
type Point = readonly [time: number, value: number];

/** A moment of a note: steps from its start, its modulation, volume and sounding pitch. */
interface Moment {
  readonly step: number;
  readonly modulation: number;
  readonly volume: number;
  readonly sounding: number;
}

/**
 * A note's course for what the modulation moves: its control points, and between
 * two whose modulation differs, one moment more at every sixteenth of the range
 * crossed, everything linear between them as the engine ramps it.
 *
 * ❗ **The level and the cutoff are curves in the modulation, the lists straight
 * lines.** Live draws per-note expression straight between points (the curve
 * controls at 0.5), and the engine ramps the modulation straight between
 * records, but what the modulation gives -- `Params[24]` times a passband, a
 * squared cutoff times an envelope factor -- is not straight in it. Between two
 * points only, `Periastron`'s opening sweep sat 5 semitones darker than the
 * game halfway; a moment per sixteenth keeps every step of the 16 exact.
 */
function courseOf(points: readonly { step: number; modulation: number; volume: number }[], sounding: readonly number[]): Moment[] {
  const out: Moment[] = [];
  points.forEach((p, i) => {
    out.push({ step: p.step, modulation: p.modulation, volume: p.volume, sounding: sounding[i] });
    const next = points[i + 1];
    if (next === undefined) return;
    const pieces = Math.min(15, Math.ceil(Math.abs(next.modulation - p.modulation) * 15 - 1e-9));
    for (let k = 1; k < pieces; k += 1) {
      const f = k / pieces;
      out.push({
        step: p.step + (next.step - p.step) * f,
        modulation: p.modulation + (next.modulation - p.modulation) * f,
        volume: p.volume + (next.volume - p.volume) * f,
        sounding: sounding[i] + (sounding[i + 1] - sounding[i]) * f,
      });
    }
  });
  return out;
}

interface AlsNote {
  readonly key: number;
  /** Beats from the clip's start. */
  readonly time: number;
  readonly duration: number;
  readonly velocity: number;
  readonly pitch?: readonly Point[];
  readonly pressure?: readonly Point[];
  readonly slide?: readonly Point[];
}

interface AlsClip {
  /** Beats, on the arrangement. */
  readonly start: number;
  readonly length: number;
  readonly name: string;
  /** A `LIVE_PALETTE` index: the tint of the chip the clip starts with. */
  readonly color: number;
  readonly notes: AlsNote[];
}

/** Counters that are one space across the document, as Live's own sets number them. */
interface ClipIds {
  keyTrack: number;
  eventList: number;
}

/** The `GrooveId` of a clip that follows no groove, as Live writes it. */
const NO_GROOVE = -1;

function clipXml(clip: AlsClip, id: number, counters: ClipIds, grooveId = NO_GROOVE): string {
  const color = clip.color;
  const end = clip.start + clip.length;
  const byKey = new Map<number, { note: AlsNote; id: number }[]>();
  clip.notes.forEach((note, index) => {
    const list = byKey.get(note.key) ?? [];
    list.push({ note, id: index + 1 });
    byKey.set(note.key, list);
  });
  const keyTracks = [...byKey.entries()].sort((a, b) => a[0] - b[0]).map(([key, list]) => [
    `<KeyTrack Id="${counters.keyTrack++}">`, '<Notes>',
    ...list.sort((a, b) => a.note.time - b.note.time).map(({ note, id: noteId }) =>
      `<MidiNoteEvent Time="${num(note.time)}" Duration="${num(note.duration)}" Velocity="${note.velocity}" ` +
      `VelocityDeviation="0" OffVelocity="64" Probability="1" IsEnabled="true" NoteId="${noteId}" />`),
    '</Notes>', v('MidiKey', key), '</KeyTrack>',
  ].join('\n'));
  const lists: string[] = [];
  clip.notes.forEach((note, index) => {
    // Live's own numbers: -2 is the pitch, -1 the pressure, 74 the slide.
    for (const [cc, points] of [[-2, note.pitch], [-1, note.pressure], [74, note.slide]] as const) {
      if (points === undefined) continue;
      lists.push([
        `<PerNoteEventList Id="${counters.eventList++}" NoteId="${index + 1}" CC="${cc}">`, '<Events>',
        ...points.map(([time, value]) =>
          `<PerNoteEvent TimeOffset="${num(time)}" Value="${num(value)}" ` +
          'CurveControl1X="0.5" CurveControl1Y="0.5" CurveControl2X="0.5" CurveControl2Y="0.5" />'),
        '</Events>', '</PerNoteEventList>',
      ].join('\n'));
    }
  });
  const grid = (denominator: number, fixed: boolean) => [
    v('FixedNumerator', 1), v('FixedDenominator', denominator), v('GridIntervalPixel', 20),
    v('Ntoles', 2), v('SnapToGrid', true), v('Fixed', fixed),
  ].join('\n');
  return [
    `<MidiClip Id="${id}" Time="${num(clip.start)}">`,
    v('LomId', 0), v('LomIdView', 0),
    v('CurrentStart', clip.start), v('CurrentEnd', end),
    '<Loop>', v('LoopStart', 0), v('LoopEnd', clip.length), v('StartRelative', 0), v('LoopOn', false),
    v('OutMarker', clip.length), v('HiddenLoopStart', 0), v('HiddenLoopEnd', clip.length), '</Loop>',
    v('Name', clip.name), v('Annotation', ''), v('Color', color),
    v('LaunchMode', 0), v('LaunchQuantisation', 0),
    '<TimeSignature>', '<TimeSignatures>', '<RemoteableTimeSignature Id="0">',
    v('Numerator', 4), v('Denominator', 4), v('Time', 0),
    '</RemoteableTimeSignature>', '</TimeSignatures>', '</TimeSignature>',
    '<Envelopes>\n<Envelopes />\n</Envelopes>',
    '<ScrollerTimePreserver>', v('LeftTime', 0), v('RightTime', clip.length), '</ScrollerTimePreserver>',
    '<TimeSelection>', v('AnchorTime', 0), v('OtherTime', 0), '</TimeSelection>',
    v('Legato', false), v('Ram', false),
    '<GrooveSettings>', v('GrooveId', grooveId), '</GrooveSettings>',
    v('Disabled', false), v('VelocityAmount', 0),
    followAction(),
    '<Grid>', grid(16, false), '</Grid>',
    v('FreezeStart', 0), v('FreezeEnd', 0), v('IsWarped', true), v('TakeId', 1),
    '<Notes>',
    keyTracks.length === 0 ? '<KeyTracks />' : ['<KeyTracks>', ...keyTracks, '</KeyTracks>'].join('\n'),
    '<PerNoteEventStore>',
    lists.length === 0 ? '<EventLists />' : ['<EventLists>', ...lists, '</EventLists>'].join('\n'),
    '</PerNoteEventStore>',
    '<NoteIdGenerator>', v('NextId', clip.notes.length + 1), '</NoteIdGenerator>',
    '</Notes>',
    v('BankSelectCoarse', -1), v('BankSelectFine', -1), v('ProgramChange', -1),
    v('NoteEditorFoldInZoom', -1), v('NoteEditorFoldInScroll', 0),
    v('NoteEditorFoldOutZoom', -1), v('NoteEditorFoldOutScroll', 0),
    v('NoteEditorFoldScaleZoom', -1), v('NoteEditorFoldScaleScroll', 0),
    '<ScaleInformation>', v('RootNote', 0), v('Name', 'Major'), '</ScaleInformation>',
    v('IsInKey', false), v('NoteSpellingPreference', 3), v('PreferFlatRootNote', false),
    '<ExpressionGrid>', grid(16, false), '</ExpressionGrid>',
    '</MidiClip>',
  ].join('\n');
}

const followAction = () => [
  '<FollowAction>', v('FollowTime', 4), v('IsLinked', true), v('LoopIterations', 1),
  v('FollowActionA', 4), v('FollowActionB', 0), v('FollowChanceA', 100), v('FollowChanceB', 0),
  v('JumpIndexA', 0), v('JumpIndexB', 0), v('FollowActionEnabled', false), '</FollowAction>',
].join('\n');

/* ---------------------------------------------------------------- the groove */

/** The pool's one groove, when there is one: `GrooveId` names a groove by its `Id` in the pool. */
const SWING_GROOVE_ID = 0;

/**
 * The song's swing as a Live groove, for the pool: one bar of sixteenths, each
 * where the engine plays that step.
 *
 * The engine stretches an even step to `L(1 + swing/2)` and squeezes the odd one
 * after it (`swing.ts`), so an odd sixteenth lands `swing/2` of a step late and
 * an even one stays. A groove says the same thing the way Live hears it: a
 * groove note per sixteenth, at its swung place, with a 1/16 Base -- Live
 * moves a clip's note towards the groove note at its nearest sixteenth, and a
 * groove note on the grid moves nothing (the Live 11 manual, *Using Grooves*,
 * 13.1.1). Timing at 100 and nothing else, as Live's own swing grooves
 * (`Swing MPC 3000 16ths 64.agr`: Base 1/16, Timing 100, Quantize, Random and
 * Velocity 0); Live's Global Amount is written at 100 on the master.
 *
 * The members are the ones Live 11.3 writes for a groove in a set's pool --
 * the Core Library's `Demo & Sketch.als`, `11.0_11300`, whose nine clips point
 * at its `Swing 8-75` -- and `Grid` is an index read off Live's own
 * `Quantize 4/8/8T/16/16T/32.agr`: 0..5 in that order, so 3 is a sixteenth.
 * Its clip is an ordinary clip of the schema above, so it lives in `clipXml`.
 */
function swingGrooveXml(swing: number, counters: ClipIds): string {
  const name = `LBP swing ${Math.round(swing * 100)}`;
  const notes: AlsNote[] = Array.from({ length: 4 * STEPS_PER_BEAT }, (_, step) => ({
    // Key 36 and a sixty-fourth long, as Live's own groove notes are.
    key: 36,
    time: swungFrame(step, 1, swing) / STEPS_PER_BEAT,
    duration: 0.0625,
    velocity: 127,
  }));
  return [
    `<Groove Id="${SWING_GROOVE_ID}">`,
    v('LomId', 0), v('Name', name),
    '<Clip>', '<Value>',
    clipXml({ start: 0, length: 4, name, color: 0, notes }, 0, counters),
    '</Value>', '</Clip>',
    v('Grid', 3),
    v('QuantizationAmount', 0), v('TimingAmount', 100), v('RandomAmount', 0), v('VelocityAmount', 0),
    v('Annotation', ''), v('Selection', true),
    '<SourceContext />',
    '</Groove>',
  ].join('\n');
}

/* ---------------------------------------------------------------- the tracks */

/** A part's mixer, in Live's own terms. */
interface MixerState {
  readonly volume: number;
  readonly pan: number;
  readonly sends: readonly number[];
}

interface PartTrack {
  readonly name: string;
  readonly color: number;
  /** What the track's mixer holds before its first note. */
  readonly mixer: MixerState;
  /** Where another part takes the track over, in beats, and the mixer it brings. */
  readonly switches: readonly { readonly at: number; readonly mixer: MixerState }[];
  readonly clips: readonly AlsClip[];
  /** The track's instrument, written with the set's ids when the track is. */
  readonly instrument?: (ids: Ids) => string;
}

/** Live's time for "before the song begins": every envelope opens with an event there. */
const BEFORE_THE_SONG = -63072000;

/**
 * One parameter's envelope: its opening value, then a step at every switch
 * that changes it.
 *
 * ❗ **A step is two events at one time, the old value and then the new.** Live
 * draws a straight line between consecutive events, so a single event at the
 * switch would ramp from the previous one; its own sets write a jump as a pair
 * at the same `Time` (the Core Library demo's `BoolEvent`s at 224, a tempo
 * envelope's `FloatEvent`s at 339 in a set of the owner's).
 */
function envelope(
  id: number,
  targetId: number | undefined,
  opening: number,
  steps: readonly { at: number; value: number }[],
): string | undefined {
  if (targetId === undefined) return undefined;
  const events: [number, number][] = [[BEFORE_THE_SONG, opening]];
  let held = opening;
  for (const step of steps) {
    if (step.value === held) continue;
    events.push([step.at, held], [step.at, step.value]);
    held = step.value;
  }
  if (events.length === 1) return undefined;
  return [
    `<AutomationEnvelope Id="${id}">`,
    '<EnvelopeTarget>', v('PointeeId', targetId), '</EnvelopeTarget>',
    '<Automation>', '<Events>',
    ...events.map(([time, value], i) => `<FloatEvent Id="${i}" Time="${num(time)}" Value="${num(value)}" />`),
    '</Events>',
    '<AutomationTransformViewState>', v('IsTransformPending', false), '<TimeAndValueTransforms />',
    '</AutomationTransformViewState>',
    '</Automation>',
    '</AutomationEnvelope>',
  ].join('\n');
}

function midiTrackXml(ids: Ids, id: number, part: PartTrack, counters: ClipIds, grooveId: number): string {
  const clips = part.clips.map((clip, i) => clipXml(clip, i, counters, grooveId));
  // The mixer first, for the ids of the dials its envelopes move -- the track
  // head that holds the envelopes comes before it in the file.
  const targets: MixerTargets = { sends: [] };
  const mixerXml = mixer(ids, { ...part.mixer }, targets);
  const envelopes = [
    envelope(0, targets.volume, fader(part.mixer.volume),
      part.switches.map((s) => ({ at: s.at, value: fader(s.mixer.volume) }))),
    envelope(1, targets.pan, panValue(part.mixer.pan),
      part.switches.map((s) => ({ at: s.at, value: panValue(s.mixer.pan) }))),
    ...part.mixer.sends.map((amount, i) => envelope(2 + i, targets.sends[i], sendLevel(amount),
      part.switches.map((s) => ({ at: s.at, value: sendLevel(s.mixer.sends[i]) })))),
  ].filter((e): e is string => e !== undefined);
  return [
    `<MidiTrack Id="${id}">`,
    trackHead(part.name, part.color, true, envelopes),
    v('SavedPlayingSlot', -1), v('SavedPlayingOffset', 0), v('Freeze', false), v('VelocityDetail', 0),
    v('NeedArrangerRefreeze', true), v('PostProcessFreezeClips', 0),
    '<DeviceChain>',
    lanes(1),
    routings('master'),
    mixerXml,
    '<MainSequencer>',
    deviceHead(ids),
    clipSlots(SCENES),
    v('MonitoringEnum', 1),
    '<ClipTimeable>', '<ArrangerAutomation>',
    clips.length === 0 ? '<Events />' : ['<Events>', ...clips, '</Events>'].join('\n'),
    '<AutomationTransformViewState>', v('IsTransformPending', false), '<TimeAndValueTransforms />',
    '</AutomationTransformViewState>', '</ArrangerAutomation>', '</ClipTimeable>',
    '<Recorder>', v('IsArmed', false), v('TakeCounter', 1), '</Recorder>',
    '<MidiControllers>',
    // One per MIDI controller and then some: Live 11 writes 131 of them.
    ...Array.from({ length: 131 }, (_, i) => target(ids, `ControllerTargets.${i}`)),
    '</MidiControllers>',
    '</MainSequencer>',
    '<FreezeSequencer>', freezeBody(ids, SCENES), '</FreezeSequencer>',
    part.instrument === undefined
      ? emptyDevices
      : ['<DeviceChain>', '<Devices>', part.instrument(ids), '</Devices>', '<SignalModulations />', '</DeviceChain>'].join('\n'),
    '</DeviceChain>',
    v('ReWireSlaveMidiTargetId', 0),
    v('PitchbendRange', 96),
    '</MidiTrack>',
  ].join('\n');
}

/**
 * A return track holding one effect.
 *
 * `sends` are this return's own sends into the returns; the ones switched on
 * are those with a level above nothing, which here is only the echo's into the
 * reverb.
 */
function returnTrackXml(
  ids: Ids,
  id: number,
  name: string,
  color: number,
  volume: number,
  sends: readonly number[],
  effect: string,
): string {
  const chain = ['<DeviceChain>', '<Devices>', effect, '</Devices>', '<SignalModulations />', '</DeviceChain>'];
  return [
    `<ReturnTrack Id="${id}">`,
    trackHead(name, color, false),
    '<DeviceChain>',
    lanes(0),
    routings('master'),
    mixer(ids, { volume, pan: 0, sends, sendsActive: sends.map((s) => s > 0) }),
    chain.join('\n'),
    '<FreezeSequencer>', freezeBody(ids, 0), '</FreezeSequencer>',
    '</DeviceChain>',
    '</ReturnTrack>',
  ].join('\n');
}

function masterTrackXml(ids: Ids, tempo: number, devices?: string): string {
  return [
    '<MasterTrack>',
    trackHead('Master', 5, false),
    '<DeviceChain>',
    lanes(0),
    routings('external'),
    mixer(ids, { volume: 1, pan: 0, tempo }),
    '<FreezeSequencer>', '<AudioSequencer Id="0">', freezeBody(ids, 0), '</AudioSequencer>', '</FreezeSequencer>',
    devices === undefined
      ? emptyDevices
      : ['<DeviceChain>', '<Devices>', devices, '</Devices>', '<SignalModulations />', '</DeviceChain>'].join('\n'),
    '</DeviceChain>',
    '</MasterTrack>',
  ].join('\n');
}

function preHearTrackXml(ids: Ids): string {
  return [
    '<PreHearTrack>',
    trackHead('Master', -1, false),
    '<DeviceChain>',
    lanes(0),
    routings('external'),
    mixer(ids, { volume: 1, pan: 0, width: 74 }),
    emptyDevices,
    '</DeviceChain>',
    '</PreHearTrack>',
  ].join('\n');
}

function sceneXml(id: number, tempo: number): string {
  return [
    `<Scene Id="${id}">`,
    followAction(),
    v('Name', ''), v('Annotation', ''), v('Color', -1),
    v('Tempo', tempo), v('IsTempoEnabled', false), v('TimeSignatureId', 201), v('IsTimeSignatureEnabled', false),
    v('LomId', 0), '<ClipSlotsListWrapper LomId="0" />',
    '</Scene>',
  ].join('\n');
}

/** Everything after the scenes, as Live 11.3 writes it for an empty set -- but for the grooves in its pool. */
function liveSetTail(lengthBeats: number, grooves: readonly string[]): string {
  const lane = (id: number, type: number, size: number, minimized: boolean) => [
    `<ExpressionLane Id="${id}">`, v('Type', type), v('Size', size), v('IsMinimized', minimized), '</ExpressionLane>',
  ].join('\n');
  return [
    '<Transport>', v('PhaseNudgeTempo', 10), v('LoopOn', false), v('LoopStart', 0),
    v('LoopLength', Math.max(4, lengthBeats)), v('LoopIsSongStart', false), v('CurrentTime', 0),
    v('PunchIn', false), v('PunchOut', false), v('MetronomeTickDuration', 0), v('DrawMode', false),
    '</Transport>',
    '<SongMasterValues>\n<SessionScrollerPos X="0" Y="0" />\n</SongMasterValues>',
    '<SignalModulations />',
    v('GlobalQuantisation', 4), v('AutoQuantisation', 0),
    '<Grid>', v('FixedNumerator', 1), v('FixedDenominator', 16), v('GridIntervalPixel', 20),
    v('Ntoles', 2), v('SnapToGrid', true), v('Fixed', false), '</Grid>',
    '<ScaleInformation>', v('RootNote', 0), v('Name', 'Major'), '</ScaleInformation>',
    v('InKey', false), v('SmpteFormat', 0),
    '<TimeSelection>', v('AnchorTime', 0), v('OtherTime', 0), '</TimeSelection>',
    '<SequencerNavigator>', '<BeatTimeHelper>', v('CurrentZoom', 0.254945054945054927), '</BeatTimeHelper>',
    '<ScrollerPos X="0" Y="0" />', '<ClientSize X="745" Y="490" />', '</SequencerNavigator>',
    v('IsContentSplitterOpen', true), v('IsExpressionSplitterOpen', true),
    '<ExpressionLanes>', lane(0, 0, 41, false), lane(1, 1, 41, false), lane(2, 2, 41, true), lane(3, 3, 41, true),
    '</ExpressionLanes>',
    '<ContentLanes>', lane(0, 4, 41, false), lane(1, 5, 25, true), '</ContentLanes>',
    v('ViewStateFxSlotCount', 4), v('ViewStateSessionMixerHeight', 120),
    '<Locators>\n<Locators />\n</Locators>',
    '<DetailClipKeyMidis />',
    '<TracksListWrapper LomId="0" />', '<VisibleTracksListWrapper LomId="0" />',
    '<ReturnTracksListWrapper LomId="0" />', '<ScenesListWrapper LomId="0" />',
    '<CuePointsListWrapper LomId="0" />',
    // ❗ **0 opens the set on the Arrangement, 1 on the Session view** -- where
    // the song is, against eight empty scenes. Measured 2026-09-24: Live's own
    // demo set says 0 and opens on its Arrangement, the empty set says 1, and an
    // export switched from 1 to 0 opened on the Arrangement with its clips.
    v('ChooserBar', 0), v('Annotation', ''), v('SoloOrPflSavedValue', true), v('SoloInPlace', true),
    v('CrossfadeCurve', 2), v('LatencyCompensation', 2), v('HighlightedTrackIndex', 0),
    '<GroovePool>', v('LomId', 0),
    grooves.length === 0 ? '<Grooves />' : ['<Grooves>', ...grooves, '</Grooves>'].join('\n'),
    '</GroovePool>',
    v('AutomationMode', false), v('SnapAutomationToGrid', true), v('ArrangementOverdub', false),
    v('ColorSequenceIndex', 0),
    '<AutoColorPickerForPlayerAndGroupTracks>', v('NextColorIndex', 0), '</AutoColorPickerForPlayerAndGroupTracks>',
    '<AutoColorPickerForReturnAndMasterTracks>', v('NextColorIndex', 0), '</AutoColorPickerForReturnAndMasterTracks>',
    v('ViewData', '{}'),
    v('ResetNonautomatedMidiControllersOnClipStarts', true),
    v('MidiFoldIn', false), v('MidiFoldMode', 0), v('MultiClipFocusMode', false),
    v('MultiClipLoopBarHeight', 0), v('MidiPrelisten', false),
    '<LinkedTrackGroups />',
    v('AccidentalSpellingPreference', 3), v('PreferFlatRootNote', false), v('UseWarperLegacyHiQMode', false),
    '<VideoWindowRect Top="-2147483648" Left="-2147483648" Bottom="-2147483648" Right="-2147483648" />',
    v('ShowVideoWindow', true), v('TrackHeaderWidth', 93),
    v('ViewStateArrangerHasDetail', true), v('ViewStateSessionHasDetail', true), v('ViewStateDetailIsSample', false),
    '<ViewStates>', v('SessionIO', 1), v('SessionSends', 1), v('SessionReturns', 1), v('SessionMixer', 1),
    v('SessionTrackDelay', 0), v('SessionCrossFade', 0), v('SessionShowOverView', 0),
    v('ArrangerIO', 1), v('ArrangerReturns', 1), v('ArrangerMixer', 1), v('ArrangerTrackDelay', 0),
    v('ArrangerShowOverView', 1), '</ViewStates>',
  ].join('\n');
}

/* ---------------------------------------------------------------- the song */

/**
 * Live's 70 track and clip colours, by index, as `0xRRGGBB`.
 *
 * ❗ **Measured on Live 11.3.43, 2026-09-24**, not copied from anywhere: three
 * sets of 24 folded tracks coloured 0..69 opened in Live, the headers read off
 * a capture of Live's window, three pixels a row that agreed on every row. The
 * two indices each read twice -- once on the selected first track, once not --
 * gave the same value, so the selection does not tint a header.
 * `steering/ableton-interchange.md` has how to repeat it.
 */
export const LIVE_PALETTE: readonly number[] = [
  0xff94a6, 0xffa529, 0xcc9927, 0xf7f47c, 0xbffb00, 0x1aff2f, 0x25ffa8, 0x5cffe8, 0x8bc5ff, 0x5480e4,
  0x92a7ff, 0xd86ce4, 0xe553a0, 0xffffff, 0xff3636, 0xf66c03, 0x99724b, 0xfff034, 0x87ff67, 0x3dc300,
  0x00bfaf, 0x19e9ff, 0x10a4ee, 0x007dc0, 0x886ce4, 0xb677c6, 0xff39d4, 0xd0d0d0, 0xe2675a, 0xffa374,
  0xd3ad71, 0xedffae, 0xd2e498, 0xbad074, 0x9bc48d, 0xd4fde1, 0xcdf1f8, 0xb9c1e3, 0xcdbbe4, 0xae98e5,
  0xe5dce1, 0xa9a9a9, 0xc6928b, 0xb78256, 0x99836a, 0xbfba69, 0xa6be00, 0x7db04d, 0x88c2ba, 0x9bb3c4,
  0x85a5c2, 0x8393cc, 0xa595b5, 0xbf9fbe, 0xbc7196, 0x7b7b7b, 0xaf3333, 0xa95131, 0x724f41, 0xdbc300,
  0x85961f, 0x539f31, 0x0a9c8e, 0x236384, 0x1a2f96, 0x2f52a2, 0x624bad, 0xa34bad, 0xcc2e6e, 0x3c3c3c,
];

/** sRGB `0xRRGGBB` to CIE Lab, D65: the space where a colour's nearest neighbour looks nearest. */
function lab(rgb: number): [number, number, number] {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const r = lin((rgb >> 16) & 0xff);
  const g = lin((rgb >> 8) & 0xff);
  const b = lin(rgb & 0xff);
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const PALETTE_LAB = LIVE_PALETTE.map(lab);

/**
 * The Live colour nearest a chip's tint.
 *
 * `rgba` is `PInstrument.Colour` as `drawnColour` gives it -- packed RGBA,
 * the low byte not an opacity (`chips.ts`). Nearest by CIE76 distance in Lab,
 * so a sky-blue chip lands on Live's sky blue and not on whichever blue happens
 * to be closest in raw RGB.
 */
export function liveColour(rgba: number): number {
  const [l, a, b] = lab((rgba >>> 8) & 0xffffff);
  let best = 0;
  let bestDistance = Infinity;
  PALETTE_LAB.forEach(([pl, pa, pb], index) => {
    const d = (l - pl) ** 2 + (a - pa) ** 2 + (b - pb) ** 2;
    if (d < bestDistance) {
      bestDistance = d;
      best = index;
    }
  });
  return best;
}

export function sequencerToAls(sequencer: Sequencer, options: AlsExportOptions = {}): AlsExportResult {
  const bakeSwing = options.bakeSwing ?? false;
  /** A position in steps to beats on the arrangement. */
  const beats = (step: number) =>
    (bakeSwing ? swungFrame(step, 1, sequencer.swing) : step) / STEPS_PER_BEAT;

  // The parts, in board order, and the tracks they go on -- the same grouping,
  // the same order and the same merge as the MIDI export, so the two files list
  // the same song the same way.
  const byKey = new Map<string, number[]>();
  sequencer.tracks.forEach((track, index) => {
    const key = partKey(track);
    const found = byKey.get(key);
    if (found) found.push(index);
    else byKey.set(key, [index]);
  });
  const parts = [...byKey.values()].map((tracks) => ({
    track: sequencer.tracks[tracks[0]],
    tracks,
    cell: Math.min(...tracks.map((i) => sequencer.tracks[i].gridX)),
  })).sort((a, b) => a.track.gridY - b.track.gridY || a.cell - b.cell || a.track.guid - b.track.guid);
  const groups = rowGroups(sequencer, parts, options.mergeRows ?? true);
  /** Which part each placement belongs to. */
  const partOf = new Map<number, number>();
  parts.forEach((part, index) => {
    for (const placement of part.tracks) partOf.set(placement, index);
  });
  const sameMixer = (a: MixerState, b: MixerState) =>
    a.volume === b.volume && a.pan === b.pan && a.sends.every((s, i) => s === b.sends[i]);

  const events = schedule(sequencer);
  const byPlacement = new Map<number, typeof events>();
  for (const event of events) {
    const list = byPlacement.get(event.track) ?? [];
    list.push(event);
    byPlacement.set(event.track, list);
  }

  /**
   * Each part's echo send as the engine plays it: the instrument's own
   * `Params[25]` at the modulation the part's notes mostly open at, bent by
   * the placement's `echoSend` (`echoSendLevel`).
   *
   * ❗ **The placement's field is not the send.** It is a bipolar offset: 0.5
   * leaves the instrument's own send alone, 0 mutes it and 1 forces unity.
   * Written as the send itself, every part between 0 and 1 went into Live's
   * echo too loud, a median 19.6 dB over the game where both echo
   * (`steering/ableton-interchange.md`), and a part at 0.5 or under on an
   * instrument with no send of its own echoed in Live and not in the game.
   *
   * A Live send is one per track, so a note opening at another modulation
   * takes its part's: 615 of the corpus's 953,791 notes.
   */
  const echoSends = parts.map((part) => {
    const offset = 2 * part.track.echoSend - 1;
    const send = (options.instruments?.get(part.track.guid)?.instrument
      ?? options.instrumentSettings?.get(part.track.guid))?.params[OUTPUT_PARAMS.send];
    if (send === undefined) return echoSendLevel(0, offset);
    const counts = new Map<number, number>();
    for (const index of part.tracks) {
      for (const event of byPlacement.get(index) ?? []) {
        const m = Math.round(event.modulation * 15);
        counts.set(m, (counts.get(m) ?? 0) + 1);
      }
    }
    const commonest = [...counts].reduce((best, entry) => (entry[1] > best[1] ? entry : best), [0, -1])[0];
    return echoSendLevel(evaluateParam(send, commonest / 15), offset);
  });
  /**
   * A part's mixer, as Live holds it: the engine's gain on each channel, put
   * through Live's pan law backwards.
   *
   * ❗ **The two pan laws differ and the difference is folded into the fader.**
   * The engine's is linear -- `L = 2(1 - p)`, `R = 2p` on a mono sample, the
   * 2 being the factor that enters with `Params[24]` (`synth-engine.md`), so a
   * centred part is at unity. Live's is constant power, `sqrt(2) cos(theta)` and
   * `sqrt(2) sin(theta)`, also unity at the centre and +3 dB at either end
   * (the Live 11 manual's Audio Fact Sheet, 34.3.9). The same two gains come
   * out of Live when the angle gives the same ratio, `theta = atan2(p, 1 - p)`,
   * and the fader makes up the rest, `sqrt(2) * sqrt((1 - p)^2 + p^2)`: 1 at the
   * centre, `sqrt(2)` hard over. Writing the plain `2p - 1` instead put a part
   * at pan 0.25 at 1.31 : 0.54 where the game plays 1.5 : 0.5.
   *
   * `level` times the channel's volume is the rest of the gain the placement
   * and the mixer own; the instrument's `Params[24]` is the instrument's, and
   * the instrument is whatever the user loads. The echo send is the engine's
   * (`echoSends`).
   */
  const mixerOf = (part: number): MixerState => {
    const track = parts[part].track;
    const p = Math.min(1, Math.max(0, track.pan));
    const gain = track.level * channelVolume(sequencer, track);
    return {
      volume: gain * Math.SQRT2 * Math.hypot(1 - p, p),
      pan: (4 / Math.PI) * Math.atan2(p, 1 - p) - 1,
      sends: [track.reverbSend, echoSends[part]],
    };
  };

  let notes = 0;
  let glides = 0;
  let clampedPitch = 0;
  let clampedBend = 0;
  let clampedSlide = 0;
  let overlapping = 0;
  let clipCount = 0;
  let switchCount = 0;
  let lengthBeats = 0;
  let instrumentTracks = 0;
  let offModulation = 0;
  const seen = new Map<string, number>();

  /**
   * Every sample the set's Samplers play, prepared once, by sample GUID.
   *
   * ⚠️ **A file name is not a sample's identity**: two of the game's sample
   * GUIDs share one name, and a kit once played the other's kick for it
   * (`steering/game-assets.md`). A second GUID under a taken name gets its
   * GUID appended.
   */
  const prepared = new Map<number, SamplerSample | null>();
  const fileOwner = new Map<string, number>();
  const sampleFor = (source: AlsInstrumentSource, guid: number): SamplerSample | undefined => {
    const hit = prepared.get(guid);
    if (hit !== undefined) return hit ?? undefined;
    const raw = source.samples.get(guid);
    let made: SamplerSample | null = null;
    if (raw !== undefined) {
      made = samplerSampleFile(raw.name, raw.bytes);
      const owner = fileOwner.get(made.file);
      if (owner !== undefined && owner !== guid) made = { ...made, file: made.file.replace(/\.wav$/, `-${guid}.wav`) };
      fileOwner.set(made.file, guid);
    }
    prepared.set(guid, made);
    return made ?? undefined;
  };

  const partTracks: PartTrack[] = groups.map((group) => {
    const own = parts[group[0]].track;
    const placements = group.flatMap((part) => parts[part].tracks);
    const source = options.instruments?.get(own.guid);
    const modulationMoves = placements.some((i) =>
      (byPlacement.get(i) ?? []).some((e) => e.points.some((p) => p.modulation !== 0)));
    // The instrument's settings, from what the track's notes mostly use: one
    // modulation and one `Key` per Sampler, since a Sampler has one of each.
    let modulation = 0;
    let keyShift = 0;
    if (source !== undefined) {
      const modulations = new Map<number, number>();
      const shifts = new Map<number, number>();
      for (const index of placements) {
        const shift = keyOffset(sequencer.tracks[index].key);
        for (const event of byPlacement.get(index) ?? []) {
          const m = Math.round(event.modulation * 15);
          modulations.set(m, (modulations.get(m) ?? 0) + 1);
          shifts.set(shift, (shifts.get(shift) ?? 0) + 1);
        }
      }
      const commonest = (counts: Map<number, number>) =>
        [...counts].reduce((best, entry) => (entry[1] > best[1] ? entry : best), [0, -1])[0];
      modulation = commonest(modulations);
      keyShift = commonest(shifts);
      for (const [m, count] of modulations) if (m !== modulation) offModulation += count;
    }
    // ❗ **The level the modulation gives rides on the pressure, note by note.**
    // The engine reads `Params[24]` and the filter at each note's modulation,
    // as it moves, and a Sampler holds one; Live's pressure is linear in
    // amplitude like the engine's volume (measured). So the Sampler sits at
    // the loudest level the track's notes reach and every control point's
    // pressure comes down by its own level against that. `Periastron` opens on
    // a `pulse_wave` chord that swells from modulation 0 to 13, `Params[24]`
    // 0.094 to 0.17; the Sampler held 0.094 and the swell was gone.
    const levels = new Map<number, number>();
    const levelAt = (m: number): number => {
      if (source === undefined) return 1;
      const step = Math.round(m * 15);
      let hit = levels.get(step);
      if (hit === undefined) levels.set(step, hit = heardLevel(source.instrument, step / 15));
      return hit;
    };
    const courses = new Map<object, Moment[]>();
    /** A note's course (`courseOf`), once. */
    const courseFor = (event: (typeof events)[number]): Moment[] => {
      let hit = courses.get(event);
      if (hit === undefined) {
        const placement = sequencer.tracks[event.track];
        const blockKey = blockRoot(placement.key);
        courses.set(event, hit = courseOf(event.points, event.points.map((p) => notePitch(p.pitch, placement.scale, blockKey))));
      }
      return hit;
    };
    let loudest = 0;
    if (source !== undefined) {
      for (const index of placements) {
        for (const event of byPlacement.get(index) ?? []) for (const m of courseFor(event)) loudest = Math.max(loudest, levelAt(m.modulation));
      }
    }
    /** The pressure a control point takes off the Sampler's volume, 1 without a Sampler. */
    const gainAt = (m: number) => (source !== undefined && loudest > 0 ? levelAt(m) / loudest : 1);

    // ❗ **The cutoff the modulation gives rides on the slide, note by note.**
    // The Sampler is set at the commonest modulation and its slide row raises the
    // dial 72 semitones x slide/127 (`LIVE_SLIDE_SEMITONES`, measured). So when
    // the track's modulation moves, the dial sits at the lowest any control
    // point wants (`heldDial`: Live's cutoff, where the note is heard, at the
    // engine's for that point's modulation and pitch) and each point's slide
    // carries it up from there. Where the engine bypasses its filter the slide
    // opens Live's as far as it goes. `Periastron` opens on a `pulse_wave` chord
    // whose modulation goes 0 to 13, its held cutoff 24 kHz down to 1.6 kHz; the
    // Sampler held the first and none of the sweep.
    const root = source === undefined
      ? 60
      : trackingRoot(source.instrument, placements.flatMap((i) => (byPlacement.get(i) ?? []).map((e) => e.pitch)));
    const varies = source !== undefined && placements.some((i) =>
      (byPlacement.get(i) ?? []).some((e) => e.points.some((p) => Math.round(p.modulation * 15) !== modulation)));
    /** Each note's moments' dials (its course), in Hz within Live's range, when the modulation moves. */
    const pointDials = new Map<object, number[]>();
    let filterOn = false;
    let lowest = Infinity;
    let highest = 0;
    let envelopeCut = 0;
    if (source !== undefined && varies) {
      const held = heldDial(source.instrument, modulation / 15, keyShift, root);
      for (const index of placements) {
        for (const event of byPlacement.get(index) ?? []) {
          pointDials.set(event, courseFor(event).map((moment) => {
            const rate = slotRate(source.instrument, event.pitch, moment.sounding);
            const wanted = held.at(moment.modulation, event.pitch, rate);
            if (Number.isFinite(wanted)) filterOn = true;
            return wanted;
          }));
        }
      }
      // ❗ **Under Live's floor the envelope gives way, not the dial.** The dial
      // stops at 30 Hz; what a point wants under that comes off the envelope's
      // amount instead, which lowers every point's heard cutoff alike (by the
      // amount times the reference's heard level). `Periastron`'s `pulse_wave`
      // wanted its dial near 20 Hz at the end of its sweep, and stuck at 1.8 kHz
      // where the game goes on down to 1.2 kHz.
      let floorest = Infinity;
      for (const wanted of pointDials.values()) for (const w of wanted) if (w < floorest) floorest = w;
      if (floorest < FILTER_FLOOR_HZ && held.heard > 0) envelopeCut = (12 * Math.log2(FILTER_FLOOR_HZ / floorest)) / held.heard;
      const lift = 2 ** ((envelopeCut * held.heard) / 12);
      for (const [event, wanted] of pointDials) {
        pointDials.set(event, wanted.map((w) => {
          const dial = Math.min(FILTER_OPEN_HZ, Math.max(FILTER_FLOOR_HZ, w * lift));
          lowest = Math.min(lowest, dial);
          highest = Math.max(highest, dial);
          return dial;
        }));
      }
    }
    const sweeps = varies && filterOn && highest > lowest * 1.0001;
    const slideFor = (dial: number): number => {
      const semitones = 12 * Math.log2(dial / lowest);
      if (semitones > LIVE_SLIDE_SEMITONES + 1e-9) clampedSlide += 1;
      return Math.min(127, (127 * semitones) / LIVE_SLIDE_SEMITONES);
    };
    // ❗ **The slide is written for every note of a track or for none of it.**
    // A note with no slide list leaves a synth on whatever the last one said.
    // Without a Sampler it is the modulation, for an instrument the user loads,
    // on every note of a track whose modulation ever moves off 0.
    const slides = source !== undefined ? sweeps : modulationMoves;
    /** Every note's start and part, for the mixer's switches. */
    const starts: { at: number; part: number }[] = [];

    // A placement's window: its cell, for as long as the chip is on the board --
    // its note grid, whether or not notes fill it -- and further only if a note
    // sounds past it. `sounding` is where its own last note stops.
    const windows = placements.map((index) => {
      const track: Track = sequencer.tracks[index];
      const reach = Math.ceil(track.notes.reduce((most, note) => Math.max(most, note.endPosition + 1), 1));
      const grid = options.clipSteps?.[index]
        ?? clipStepsFor(track.notes.reduce((most, note) => Math.max(most, note.endStep), -1));
      return {
        index, gridX: track.gridX, from: track.stepOffset,
        to: track.stepOffset + Math.max(grid, reach), sounding: track.stepOffset + reach,
      };
    }).sort((a, b) => a.from - b.from || a.gridX - b.gridX);
    // ⚠️ **Live plays one arrangement clip per track at a time**: where two
    // overlap, the later hides the earlier's tail and its notes never sound.
    // So windows whose NOTES reach into the next become one clip over the union,
    // whichever parts they belong to -- two parts share a track only if their
    // notes never sound together, and a window runs from the cell's start,
    // before its notes. A chip that only covers the next one with silence is
    // cut where the next begins, and stays a clip of its own.
    const merged: { from: number; to: number; sounding: number; cells: number[]; members: number[] }[] = [];
    for (const w of windows) {
      const last = merged[merged.length - 1];
      if (last !== undefined && w.from < last.sounding) {
        last.to = Math.max(last.to, w.to);
        last.sounding = Math.max(last.sounding, w.sounding);
        last.cells.push(w.gridX);
        last.members.push(w.index);
      } else {
        if (last !== undefined) last.to = Math.min(last.to, w.from);
        merged.push({ from: w.from, to: w.to, sounding: w.sounding, cells: [w.gridX], members: [w.index] });
      }
    }

    const clips: AlsClip[] = merged.map((span) => {
      const start = beats(span.from);
      const length = beats(span.to) - start;
      lengthBeats = Math.max(lengthBeats, start + length);
      const clipNotes: AlsNote[] = [];
      for (const member of span.members) {
        const placement = sequencer.tracks[member];
        const root = blockRoot(placement.key);
        const pitchOf = (raw: number) => notePitch(raw, placement.scale, root);
        for (const event of byPlacement.get(member) ?? []) {
          starts.push({ at: beats(event.step), part: partOf.get(member) ?? group[0] });
          const first = pitchOf(event.pitch);
          // ❗ **With a Sampler the note is the raw one, the note the tracker's
          // roll shows, and `Key` and the scale are pitch.** The engine picks
          // the slot off the raw note and only then quantises and transposes
          // (`scale.ts`), so the zones are its walk as it is, the track's
          // commonest `Key` sits in the pitched zones' roots (`samplerZones`),
          // and what is left -- another part's `Key`, a note the scale moves, a
          // glide -- is per-note pitch. A note on an unpitched slot gets none:
          // the engine plays those at one rate whatever the pitch. Written as
          // the sounding note instead, a part keyed off the track's commonest
          // played its notes through the zones next door: `Periastron`'s row 2
          // kit, keyed D on a track keyed D#, hit the tom for its closed hi-hat
          // (2026-10-04). Without a Sampler the note is the one that sounds,
          // as in the MIDI export: an instrument the user loads knows no `Key`.
          const sampled = source !== undefined;
          const key = sampled ? event.pitch : Math.min(127, Math.max(0, first));
          if (!sampled && key !== first) clampedPitch += 1;
          const at = beats(event.step);
          /** Where a control point falls, in beats from the note's start. */
          const offset = (p: { step: number }) => beats(event.step + p.step) - at;
          let pitch: Point[] | undefined;
          const bends = sampled
            ? (playsPitched(source.instrument, event.pitch)
              ? event.points.map((p) => pitchOf(p.pitch) - event.pitch - keyShift)
              : event.points.map(() => 0))
            : event.points.map((p) => pitchOf(p.pitch) - first);
          if (bends.some((s) => s !== 0)) {
            pitch = event.points.map((p, i) => {
              const s = bends[i];
              if (Math.abs(s) > ALS_BEND_RANGE) clampedBend += 1;
              return [offset(p), Math.max(-ALS_BEND_RANGE, Math.min(ALS_BEND_RANGE, s)) * BEND_PER_SEMITONE];
            });
          }
          if (event.points.some((p) => pitchOf(p.pitch) !== first)) glides += 1;
          const level = (volume: number) => Math.min(127, Math.max(0, Math.round(volume)));
          // The ramp, and the note that opens at 0: Live has no velocity 0, so
          // that opening rides on the pressure exactly as it does in the MIDI.
          const ramped = event.hasVolumeAutomation || level(event.volume) === 0;
          // ❗ **With a Sampler, every note's level rides on the pressure**, a
          // flat note's as a single point. The Sampler's Pressure row to Volume
          // at 100 leaves a note with no pressure at all silent: the first sets
          // written with only the ramps on it played nothing, every meter flat
          // (2026-09-24).
          // With a Sampler the level and the slide follow the note's course, a
          // moment per sixteenth of modulation crossed; without one, the points.
          const course = sampled ? courseFor(event) : undefined;
          const gains = (course ?? event.points).map((m) => gainAt(m.modulation));
          const swells = gains.some((g) => g !== gains[0]);
          const pressure = sampled
            ? (ramped || swells
              ? course!.map((m, i): Point => [offset(m), Math.min(127, Math.max(0, m.volume)) * gains[i]])
              : [[0, Math.min(127, Math.max(0, event.volume)) * gains[0]] as const])
            : ramped ? event.points.map((p): Point => [offset(p), level(p.volume)]) : undefined;
          const slide = slides
            ? (sampled
              ? course!.map((m, i): Point => [offset(m), slideFor(pointDials.get(event)![i])])
              : event.points.map((p): Point => [offset(p), Math.round(p.modulation * 127)]))
            : undefined;
          clipNotes.push({
            key,
            time: at - start,
            duration: beats(event.step + event.durationSteps) - at,
            // With a Sampler the pressure holds the whole level and the
            // Sampler's Vel → Vol is 0 (`als-sampler.ts`), so the velocity is
            // only the 127 a note must have to be a note.
            velocity: source !== undefined ? 127 : Math.max(1, level(event.volume)),
            pitch,
            pressure,
            slide,
          });
          notes += 1;
        }
      }
      // Same key, still sounding: two notes lying on one another in Live's clip.
      const lastEnd = new Map<number, number>();
      for (const note of [...clipNotes].sort((a, b) => a.time - b.time)) {
        if ((lastEnd.get(note.key) ?? -Infinity) > note.time + 1e-9) overlapping += 1;
        lastEnd.set(note.key, Math.max(lastEnd.get(note.key) ?? -Infinity, note.time + note.duration));
      }
      const cells = [...new Set(span.cells)].sort((a, b) => a - b);
      const opener = sequencer.tracks[span.members[0]];
      return {
        start,
        length,
        name: cells.length === 1 ? `cell ${cells[0]}` : `cells ${cells[0]}-${cells[cells.length - 1]}`,
        // The chip's own tint, so a merged track keeps its chips' colours.
        color: liveColour(drawnColour(opener.guid, opener.colour)),
        notes: clipNotes,
      };
    });
    clipCount += clips.length;

    // ❗ **The mixer changes wherever a part's note starts after another part's**,
    // not once per part. Parts on one track interleave -- A at cell 0, B at
    // cell 2, A again at cell 4 -- and a value set once per part leaves A's
    // second cell on B's mixer. The MIDI export did exactly that until
    // 2026-09-24 and steps the same way as this now (`mixerEvents` in `midi.ts`).
    starts.sort((a, b) => a.at - b.at);
    let current = starts[0]?.part ?? group[0];
    const opening = mixerOf(current);
    const switches: { at: number; mixer: MixerState }[] = [];
    let held = opening;
    for (const start of starts) {
      if (start.part === current) continue;
      current = start.part;
      const next = mixerOf(current);
      if (sameMixer(next, held)) continue;
      switches.push({ at: start.at, mixer: next });
      held = next;
    }
    switchCount += switches.length;

    // The label the MIDI export writes, with the same `#2` for a repeat.
    const label = partLabel(own, options.instrumentName);
    const n = (seen.get(label) ?? 0) + 1;
    seen.set(label, n);
    let instrument: ((ids: Ids) => string) | undefined;
    if (source !== undefined) {
      instrumentTracks += 1;
      const name = options.instrumentName?.(own.guid) ?? label;
      instrument = (ids) => samplerDevice(ids, source.instrument, (guid) => sampleFor(source, guid), {
        modulation: modulation / 15, keyShift, trackingRoot: root, volume: loudest, tempo: sequencer.tempo, name,
        filter: sweeps ? { on: true, hz: lowest, slide: true, envelopeCut } : undefined,
      });
    }
    return {
      name: n > 1 ? `${label} #${n}` : label,
      color: liveColour(drawnColour(own.guid, own.colour)),
      mixer: opening,
      switches,
      clips,
      instrument,
    };
  });

  const ids = new Ids();
  const counters: ClipIds = { keyTrack: 0, eventList: 0 };
  // ❗ **Unbaked, the swing is a groove every clip follows**: the notes stay on
  // Live's grid, where they can be edited, and Live swings them as it plays.
  // Baked, the notes already carry it and a groove would swing them twice; with
  // no swing there is nothing to say and the pool stays empty, as Live's is.
  const grooved = !bakeSwing && sequencer.swing > 0;
  const grooveId = grooved ? SWING_GROOVE_ID : NO_GROOVE;
  let trackId = 0;
  const body = [
    '<Tracks>',
    ...partTracks.map((part) => midiTrackXml(ids, trackId++, part, counters, grooveId)),
    returnTrackXml(ids, trackId++, 'Reverb', 4, 1, [0, 0], reverbDevice(ids, sequencer.reverb)),
    // ❗ **`EchoMix` is the return's fader and the echo feeds the reverb.** The
    // engine adds `EchoMix` times the delayed signal to all four of its output
    // lanes, and lanes 2-3 are the reverb's input (`steering/synth-engine.md`,
    // *The echo*): so the echo return sends into the reverb, post-fader, at 1.
    returnTrackXml(ids, trackId++, 'Echo', 11, sequencer.echoMix, [1, 0],
      delayDevice(ids, sequencer.echoTime, sequencer.echoFeedback, sequencer.tempo)),
    '</Tracks>',
    masterTrackXml(ids, sequencer.tempo, options.masterBus && masterBusDevices(ids, options.masterBus)),
    preHearTrackXml(ids),
    '<SendsPre>', '<SendPreBool Id="0" Value="false" />', '<SendPreBool Id="1" Value="false" />', '</SendsPre>',
    '<Scenes>', ...Array.from({ length: SCENES }, (_, i) => sceneXml(i, sequencer.tempo)), '</Scenes>',
    liveSetTail(lengthBeats, grooved ? [swingGrooveXml(sequencer.swing, counters)] : []),
  ].join('\n');

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    // ❗ The schema is Live 11.3's, to the revision: `MinorVersion` is what Live
    // checks. `Creator` is free text -- sets written by other tools say so there
    // and open -- so it says who wrote this one.
    '<Ableton MajorVersion="5" MinorVersion="11.0_11300" SchemaChangeCount="7" Creator="LBP Tracker" Revision="">',
    '<LiveSet>',
    v('NextPointeeId', ids.end),
    v('OverwriteProtectionNumber', 2819),
    v('LomId', 0), v('LomIdView', 0),
    body,
    '</LiveSet>',
    '</Ableton>',
    '',
  ].join('\n');

  return {
    xml,
    tracks: partTracks.length,
    parts: parts.length,
    switches: switchCount,
    clips: clipCount,
    placements: sequencer.tracks.length,
    notes,
    glides,
    clampedPitch,
    clampedBend,
    clampedSlide,
    overlapping,
    // Read after the body is written: the Samplers prepare their samples as
    // they are written, and only those are the set's.
    samples: [...prepared.values()]
      .filter((s): s is SamplerSample => s !== null)
      .map((s) => ({ file: s.file, bytes: s.wav })),
    instrumentTracks,
    offModulation,
  };
}

/**
 * The files of a Live project holding the set and its samples, as a zip wants
 * them: `<name> Project/<name>.als`, the samples under `Samples/Imported`, and
 * `Ableton Project Info`.
 *
 * ❗ **The empty `Ableton Project Info` folder is not decoration.** Live finds
 * a sample by its path relative to the project only when it knows it is in
 * one, and that folder is how it knows: the same set without it opened with
 * `Il file "piano_c4.wav" non può essere aperto` in Live's log, and with it
 * found the file. Measured 2026-09-24 on Live 11.3.43.
 */
export function alsProjectFiles(
  name: string,
  als: Uint8Array,
  samples: readonly { readonly file: string; readonly bytes: Uint8Array }[],
): { name: string; bytes: Uint8Array }[] {
  const safe = name.replace(/[^\w .-]+/g, '_').trim() || 'song';
  const root = `${safe} Project`;
  return [
    { name: `${root}/${safe}.als`, bytes: als },
    { name: `${root}/Ableton Project Info/`, bytes: new Uint8Array(0) },
    ...samples.map((s) => ({ name: `${root}/Samples/Imported/${s.file}`, bytes: s.bytes })),
  ];
}
