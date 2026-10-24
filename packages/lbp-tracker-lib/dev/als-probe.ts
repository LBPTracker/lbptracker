/**
 * What the Live probes share: a set of tracks, each one sustained sine through
 * the export's own Sampler, read off Live's peak boxes.
 *
 * `probe-als-level.ts` and `probe-als-filter.ts` are the two that use it. Each
 * row is a track with its own instrument, so each can be set apart from the
 * rest by its `Params` or by an edit to its XML. The set is the same every time:
 * the master at −inf, so nothing is heard and the track meters are the reading;
 * the Session view, where fourteen peak boxes fit; and the transport looping the
 * notes' 16 beats, so they hold while the meters settle.
 *
 * ❗ **Someone has to press Play in Live.** Neither a key posted to its window
 * nor a Max for Live device got it to play by itself
 * (`steering/ableton-interchange.md`, *How it was checked*).
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { DEFAULT_CHIP_COLOUR } from '@lbptracker/cwlib/sequencer/chips.ts';
import { readNotes, NOTE_RECORD_SIZE } from '@lbptracker/cwlib/sequencer/notes.ts';
import type { Sequencer, Track } from '@lbptracker/cwlib/sequencer/project.ts';
import { alsProjectFiles, sequencerToAls } from '../src/als.ts';
import type { RInstrument } from '@lbptracker/cwlib/resources/rinstrument.ts';

/**
 * Where each note ends: step 55 of the 64 the loop runs. ⚠️ A note as long as
 * the loop restarts while the last is still releasing, and the held peak takes
 * their sum -- 4.9 dB over on 2026-10-04 -- so the notes stop a second early.
 */
const NOTE_END = 55;

/** The sine's amplitude times the track's fader, `level x 0.75 x Volume` at the centre: −8.52 dBFS. */
export const UNITY = 0.5 * 0.75;

/** A 1 kHz sine at half scale, 1 s, 48 kHz PCM16 mono, looped whole: the shape of a game `.smp`. */
export function sineSmp(): Uint8Array {
  const frames = 48000;
  const data = new DataView(new ArrayBuffer(frames * 2));
  for (let i = 0; i < frames; i += 1) data.setInt16(i * 2, Math.round(16384 * Math.sin((2 * Math.PI * 1000 * i) / 48000)), true);
  const chunks: Uint8Array[] = [];
  const chunk = (id: string, body: Uint8Array) => {
    const out = new Uint8Array(8 + body.length);
    for (let i = 0; i < 4; i += 1) out[i] = id.charCodeAt(i);
    new DataView(out.buffer).setUint32(4, body.length, true);
    out.set(body, 8);
    chunks.push(out);
  };
  const fmt = new DataView(new ArrayBuffer(16));
  fmt.setUint16(0, 1, true); fmt.setUint16(2, 1, true); fmt.setUint32(4, 48000, true);
  fmt.setUint32(8, 96000, true); fmt.setUint16(12, 2, true); fmt.setUint16(14, 16, true);
  chunk('fmt ', new Uint8Array(fmt.buffer));
  chunk('data', new Uint8Array(data.buffer));
  const smpl = new DataView(new ArrayBuffer(60));
  smpl.setUint32(28, 1, true);
  smpl.setUint32(36 + 8, 0, true);
  smpl.setUint32(36 + 12, frames - 1, true);
  chunk('smpl', new Uint8Array(smpl.buffer));
  const size = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(12 + size);
  out.set([82, 73, 70, 70], 0);
  new DataView(out.buffer).setUint32(4, 4 + size, true);
  out.set([87, 65, 86, 69], 8);
  let at = 12;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

export interface ProbeRow {
  /** The track's name, which is what the peak box sits under. */
  readonly name: string;
  /** The raw note, 60 by default: the sine's own 1 kHz, since the slot's base note is 60. */
  readonly pitch?: number;
  /** The note's volume, which becomes its pressure; 127 by default. */
  readonly volume?: number;
  /** `Params` set apart from the flat instrument: the cutoff open, the sustain full, the level 1. */
  readonly params?: Readonly<Record<number, number>>;
  /** An edit to the track's XML after the export has written it. */
  readonly edit?: (track: string) => string;
}

/** A string replace that refuses to do nothing. */
export const replaceOnce = (from: string | RegExp, to: string) => (within: string): string => {
  const out = within.replace(from as string, to);
  if (out === within) throw new Error(`no match for ${String(from)}`);
  return out;
};

/** Writes the probe set under `outDir` and returns the `.als`'s path. */
export async function writeProbe(name: string, rows: readonly ProbeRow[], outDir: string): Promise<string> {
  const tracks: Track[] = rows.map((row, i) => {
    const pitch = row.pitch ?? 60;
    const volume = row.volume ?? 127;
    const bytes = new Uint8Array(2 * NOTE_RECORD_SIZE);
    bytes.set([0, pitch, volume, 0], 0);
    bytes.set([NOTE_END, pitch | 0x80, volume, 0], NOTE_RECORD_SIZE);
    const grouped = readNotes(bytes);
    return {
      guid: 1000 + i, name: '', colour: DEFAULT_CHIP_COLOUR, gridX: 0, gridY: i, stepOffset: 0,
      level: 1, pan: 0.5, echoSend: 0, reverbSend: 0, key: 0, scale: 0,
      notes: grouped.notes, records: bytes, trailingRecords: grouped.trailing.length,
    };
  });
  const seq: Sequencer = {
    uid: 1, name, author: '', tempo: 120, swing: 0, echoFeedback: 0, echoTime: 1, echoMix: 0,
    reverb: 0, loop: true, startPoint: 0, numChannels: 1, volumes: [1, 1, 1, 1, 1, 1], boardRows: tracks.length,
    tracks, lengthSteps: 64,
  };
  const sine = sineSmp();
  const instruments = new Map(rows.map((row, i) => {
    const flat: Record<number, number> = { 3: 1, 13: 1, 24: 1, ...row.params };
    const instrument: RInstrument = {
      slots: [{ baseNote: 60, baseBpm: 120, fineTune: 0, pitched: true, fitBpm: false }],
      sampleGuids: [100], splitNotes: [87, 0, 0, 0, 0, 0, 0, 0, 0], numStack: 1,
      params: Array.from({ length: 27 }, (_, k) => ({ x: flat[k] ?? 0, y: flat[k] ?? 0 })),
      arpeggio: [], arpeggiate: false,
    };
    return [1000 + i, { instrument, samples: new Map([[100, { name: 'sine_1k.smp', bytes: sine }]]) }] as const;
  }));
  const result = sequencerToAls(seq, { instruments, instrumentName: (guid) => rows[guid - 1000]?.name });
  let xml = result.xml;
  for (const [i, row] of rows.entries()) {
    if (!row.edit) continue;
    const block = [...xml.matchAll(/<MidiTrack [\s\S]*?<\/MidiTrack>/g)].map((m) => m[0])
      .find((t) => t.includes(`row ${i} - ${row.name}"`));
    if (!block) throw new Error(`no track for ${row.name}`);
    xml = xml.replace(block, row.edit(block));
  }
  const master = /<MasterTrack>[\s\S]*?<\/MasterTrack>/.exec(xml)![0];
  xml = xml.replace(master,
    replaceOnce(/(<Mixer>[\s\S]*?<Volume>\n<LomId Value="0" \/>\n<Manual Value=")[^"]*(")/, '$10.0003162277571$2')(master));
  xml = replaceOnce('<ChooserBar Value="0" />', '<ChooserBar Value="1" />')(xml);
  xml = replaceOnce('<LoopOn Value="false" />\n<LoopStart Value="0" />', '<LoopOn Value="true" />\n<LoopStart Value="0" />')(xml);

  const files = alsProjectFiles(name, gzipSync(xml), result.samples);
  for (const f of files) {
    const at = path.join(outDir, f.name);
    if (f.name.endsWith('/')) { await mkdir(at, { recursive: true }); continue; }
    await mkdir(path.dirname(at), { recursive: true });
    await writeFile(at, f.bytes);
  }
  return path.join(outDir, files[0].name);
}

/**
 * Members of the track's Sampler filter set by name: `Freq`, `Res`, and the
 * filter envelope's with an `Envelope.` prefix (`Envelope.Amount`,
 * `Envelope.SustainLevel`, `Envelope.IsOn`).
 */
export const setFilter = (members: Readonly<Record<string, number | boolean>>) => (track: string): string => {
  const start = track.indexOf('<SimplerFilter');
  const end = track.indexOf('</SimplerFilter>', start);
  if (start < 0 || end < 0) throw new Error('no SimplerFilter');
  let filter = track.slice(start, end);
  for (const [path, value] of Object.entries(members)) {
    const [outer, inner] = path.includes('.') ? path.split('.') : [undefined, path];
    const from = outer === undefined ? 0 : filter.indexOf(`<${outer}>`);
    if (from < 0) throw new Error(`no ${outer}`);
    const at = filter.indexOf(`<${inner}>\n<LomId Value="0" />\n<Manual Value="`, from);
    if (at < 0) throw new Error(`no ${path}`);
    const open = filter.indexOf('<Manual Value="', at) + '<Manual Value="'.length;
    const close = filter.indexOf('"', open);
    filter = filter.slice(0, open) + String(value) + filter.slice(close);
  }
  return track.slice(0, start) + filter + track.slice(end);
};

/** The slide row to Filter Freq at 100, and the note's slide held at `value` (a per-note CC 74 list). */
export const slideToCutoff = (value: number) => (track: string): string => {
  let out = replaceOnce(
    '<MidiCtrl.4>\n<ModConnections.0>\n<Amount Value="0" />\n<Connection Value="0" />',
    '<MidiCtrl.4>\n<ModConnections.0>\n<Amount Value="100" />\n<Connection Value="12" />',
  )(track);
  out = out.replace(/<PerNoteEventList Id="\d+" NoteId="1" CC="74">[\s\S]*?<\/PerNoteEventList>\n/, '');
  return replaceOnce(/(<PerNoteEventList Id="\d+" NoteId="1" CC="-1">[\s\S]*?<\/PerNoteEventList>)/, [
    '$1', `<PerNoteEventList Id="${9000 + Math.round(value)}" NoteId="1" CC="74">`, '<Events>',
    `<PerNoteEvent TimeOffset="0" Value="${value}" CurveControl1X="0.5" CurveControl1Y="0.5" CurveControl2X="0.5" CurveControl2Y="0.5" />`,
    '</Events>', '</PerNoteEventList>',
  ].join('\n'))(out);
};
