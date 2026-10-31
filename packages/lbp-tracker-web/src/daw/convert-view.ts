/**
 * The Export and Import panels: the song out as a `.mid`, and any `.mid` in as
 * the song. The `.als` and the `.plan` beside the first are their own modules,
 * mounted from here. What they log goes to the browser's console.
 *
 * The conversion itself is `packages/lbp-tracker-lib/src/midi.ts`, which is
 * where the interesting decisions and the corrected mistakes live. This is
 * the view around it: the options, the tally that says what the conversion
 * could and could not carry, the drop zone for a file coming back.
 *
 * ⚠️ **The tally is not decoration.** Every honest converter loses something,
 * and the one this replaces lost its glides silently. Whatever this drops is
 * counted and shown, so nobody discovers it by ear a week later.
 *
 * The export is of the song that is open, re-run when its panel is shown and
 * whenever an option or the song changes while it is; an import replaces the
 * song, through the same `openSong` a level goes through.
 */

import { confirmDialog } from '../confirm.ts';
import { createApp, watch } from 'vue';
import ControlPanel from '../controls/ControlPanel.vue';
import { midi } from '../controls/midi.ts';
import { CONTROLS } from '../controls/kit.ts';
import {
  DEFAULT_BEND_RANGE,
  midiToSequencer,
  sequencerToMidi,
  splitSequencerToMidi,
  type MidiExportResult,
  type MidiImportResult,
  type MidiSplit,
} from '@lbptracker/lib/midi.ts';
import { writeZip } from '@lbptracker/cwlib/archives/zip.ts';
import { type Sequencer } from '@lbptracker/cwlib/sequencer/project.ts';
import { songFromSequencer } from '@lbptracker/lib/song.ts';
import { currentSequencer, ensureAssets, openSong, rinstIndex, state } from './session.ts';
import { mountAlsExport } from './als-export.ts';
import { mountPlanExport } from './plan-export.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function mountConvert(opts: { isActive: () => boolean; onShow: (l: () => void) => void }): void {
  const midiDrop = $<HTMLDivElement>('cv-midiDrop');
  const midiInput = $<HTMLInputElement>('cv-midiFile');
  const saveButton = $<HTMLButtonElement>('cv-save');
  const takeButton = $<HTMLButtonElement>('cv-take');
  const optionsApp = createApp(ControlPanel);
  optionsApp.provide(CONTROLS, midi);
  optionsApp.mount('#cv-options');

  let imported: MidiImportResult | undefined;

  // What the two panels used to log on the page goes to the browser's console.
  const logTo = (tag: string) => (text: string, bad = false): void => {
    if (bad) console.warn(`[${tag}]`, text);
    else console.info(`[${tag}]`, text);
  };
  const log = logTo('export');
  const logIn = logTo('import');
  const setStatus = (id: string, text: string, bad = false) => {
    const el = $(id);
    el.textContent = text;
    el.classList.toggle('bad', bad);
  };

  interface Item { readonly value: string; readonly label: string; readonly warn?: boolean }
  function showTally(host: string, items: readonly Item[]): void {
    $(host).innerHTML = items
      .map((item) => `<span class="item${item.warn ? ' warn' : ''}"><b>${item.value}</b><span>${item.label}</span></span>`)
      .join('');
  }
  const plural = (n: number, one: string) => `${n.toLocaleString()} ${one}${n === 1 ? '' : 's'}`;

  // ---------------------------------------------------------------- export

  function options() {
    return {
      mpe: midi.picked('mode') === 'mpe',
      bakeSwing: midi.on('bakeSwing'),
      exact: midi.on('exact'),
      mergeRows: midi.on('mergeRows'),
      instrumentName: (guid: number) => rinstIndex?.get(guid)?.file.replace('.rinst', ''),
      bendRange: midi.on('autoBend') ? undefined : midi.raw('bendRange'),
    };
  }

  let exported: MidiSplit | undefined;
  let exportedName = 'song.mid';

  const asSplit = (seq: { name: string; uid: number }, result: MidiExportResult): MidiSplit => {
    const safe = (seq.name || 'song').replace(/[^\w .-]+/g, '_').trim();
    return {
      files: [{ name: `${safe || 'song'}.mid`, result }],
      notes: result.notes,
      parts: result.parts,
      events: result.events,
      bytes: result.bytes.length,
      sharedChannel: result.sharedChannel,
      dragged: result.dragged,
      timbred: result.timbred,
      flattened: result.flattened,
      droppedGlides: result.droppedGlides,
      dropped: result.dropped,
      clampedPitch: result.clampedPitch,
      clampedBend: result.clampedBend,
      patched: result.patched,
      unpatched: result.unpatched,
    };
  };

  /** Convert the song, and say what it cost. Tens of milliseconds for a big one. */
  function convert(): void {
    saveButton.disabled = true;
    $('cv-report').classList.remove('on');
    if (state.song.clips.length === 0) {
      setStatus('cv-status', 'nothing to export yet');
      return;
    }
    const seq = currentSequencer();
    const opts2 = options();
    exported = midi.picked('split') === 'packed'
      ? splitSequencerToMidi(seq, opts2)
      : asSplit(seq, sequencerToMidi(seq, opts2));
    const safe = (seq.name || 'song').replace(/[^\w .-]+/g, '_').trim();
    exportedName = exported.files.length > 1 ? `${safe || 'song'}.zip` : (exported.files[0]?.name ?? 'song.mid');
    saveButton.textContent = exported.files.length > 1 ? 'Download .zip' : 'Download .mid';

    const lost: string[] = [];
    if (exported.droppedGlides > 0) {
      lost.push(`${plural(exported.droppedGlides, 'note')} lost a glide: plain mode has one channel per instrument, and a bend there would move the whole part. Switch to MPE to keep them.`);
    }
    if (exported.flattened > 0) {
      lost.push(`${plural(exported.flattened, 'note')} lost a glide to a channel it had to share: the zone has fifteen and this passage wanted more at once.`);
    }
    if (exported.dropped > 0) {
      lost.push(`${plural(exported.dropped, 'note')} could not be written at all: more than fifteen copies of one pitch sounding together leaves no channel to tell them apart.`);
    }
    if (exported.clampedPitch > 0) lost.push(`${plural(exported.clampedPitch, 'note')} fell outside MIDI’s 0–127 and were clamped.`);
    if (exported.dragged > 0) {
      lost.push(`${plural(exported.dragged, 'note')} sit on a channel that is being bent while they sound, so a synth will pull them along with it. Reading the file back here does not.`);
    }
    if (exported.clampedBend > 0) {
      lost.push(`${plural(exported.clampedBend, 'control point')} bent further than the range allows. Turn off “pick it from the music” only if you mean to.`);
    }
    showTally('cv-tally', [
      { value: exported.notes.toLocaleString(), label: 'notes' },
      { value: String(exported.parts), label: 'parts' },
      { value: exported.events.toLocaleString(), label: 'events' },
      ...(exported.files.length > 1 ? [{ value: String(exported.files.length), label: 'files' }] : []),
      { value: `${(exported.bytes / 1024).toFixed(0)} kB`, label: 'in all' },
      ...(exported.dragged > 0 ? [{ value: exported.dragged.toLocaleString(), label: 'take on a bend', warn: true }] : []),
      ...(exported.sharedChannel > 0 ? [{ value: exported.sharedChannel.toLocaleString(), label: 'shared a channel' }] : []),
      ...(exported.patched > 0 ? [{ value: exported.patched.toLocaleString(), label: 'clips carried whole' }] : []),
      ...(lost.length === 0 ? [{ value: '✓', label: 'nothing lost' }] : []),
    ]);
    $('cv-lost').innerHTML = lost.map((line) => `<li>${line}</li>`).join('');
    $('cv-report').classList.add('on');
    saveButton.disabled = false;
    setStatus('cv-status', `${seq.name || 'untitled'}: ${plural(exported.notes, 'note')} over ${plural(exported.parts, 'part')}`);
  }

  saveButton.addEventListener('click', () => {
    if (!exported) return;
    const single = exported.files.length === 1;
    const payload = single
      ? exported.files[0].result.bytes
      : writeZip(exported.files.map((f) => ({ name: f.name, bytes: f.result.bytes })));
    const blob = new Blob([payload as unknown as BlobPart], { type: single ? 'audio/midi' : 'application/zip' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = exportedName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    log(`saved ${exportedName}, ${(payload.length / 1024).toFixed(0)} kB${single ? '' : `, ${exported.files.length} files`}`);
  });

  midi.setValue('bendRange', DEFAULT_BEND_RANGE);
  watch(
    () => [
      midi.picked('mode'), midi.picked('split'), midi.on('bakeSwing'), midi.on('exact'),
      midi.on('mergeRows'), midi.on('autoBend'), midi.raw('bendRange'),
    ],
    () => { if (opts.isActive()) convert(); },
  );
  // The song changed while the view is up: re-run, but not on every pixel of a drag.
  let timer = 0;
  state.onChange(() => {
    if (!opts.isActive()) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(convert, 250);
  });
  opts.onShow(() => void ensureAssets().then(convert, () => convert()));

  // The other exports on this panel: the song as an Ableton Live set, and as a
  // `.plan` the game can load.
  mountAlsExport({ isActive: opts.isActive, onShow: opts.onShow, log });
  mountPlanExport({ isActive: opts.isActive, onShow: opts.onShow, log });

  // ---------------------------------------------------------------- import

  function buildAssign(result: MidiImportResult): void {
    const host = $('cv-assign');
    if (!rinstIndex) {
      host.innerHTML = '';
      return;
    }
    const instruments = [...rinstIndex.entries()]
      .map(([guid, row]) => ({ guid, name: row.file.replace('.rinst', '') }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const parts = new Map<string, { name: string; guid: number; clips: number }>();
    for (const track of result.sequencer.tracks) {
      const key = `${track.name}|${track.gridY}`;
      const found = parts.get(key);
      if (found) found.clips += 1;
      else parts.set(key, { name: track.name, guid: track.guid, clips: 1 });
    }
    host.innerHTML =
      '<p class="hintline" style="margin-bottom:.4rem">what each part plays</p>' +
      [...parts.entries()].map(([key, part]) => {
        const known = rinstIndex?.has(part.guid) ?? false;
        return (
          `<div class="row" style="margin-top:.35rem"><label style="min-width:11rem" for="asg${key}">${part.name || '(unnamed)'}</label>` +
          `<select data-part="${key}" id="asg${key}">` +
          instruments.map((i) => `<option value="${i.guid}"${known && i.guid === part.guid ? ' selected' : ''}>${i.name}</option>`).join('') +
          `</select><span class="hintline" style="margin:0">${plural(part.clips, 'clip')}${known ? ' · from the file' : ''}</span></div>`
        );
      }).join('');
  }

  function assigned(): Sequencer | undefined {
    if (!imported) return undefined;
    const chosen = new Map<string, number>();
    for (const select of $('cv-assign').querySelectorAll<HTMLSelectElement>('select[data-part]')) {
      chosen.set(String(select.dataset.part), Number(select.value));
    }
    return {
      ...imported.sequencer,
      tracks: imported.sequencer.tracks.map((track) => {
        const guid = chosen.get(`${track.name}|${track.gridY}`);
        return guid === undefined ? track : { ...track, guid };
      }),
    };
  }

  async function openMidi(file: File): Promise<void> {
    midiDrop.classList.add('busy');
    setStatus('cv-midiStatus', `reading ${file.name}…`);
    $('cv-inReport').classList.remove('on');
    try {
      await ensureAssets();
      const bytes = new Uint8Array(await file.arrayBuffer());
      imported = midiToSequencer(bytes, {
        fallbackName: file.name.replace(/\.midi?$/i, ''),
        instrumentGuid: (name) => {
          for (const [guid, entry] of rinstIndex ?? []) {
            if (entry.file.replace('.rinst', '') === name) return guid;
          }
          return undefined;
        },
      });
      const lost: string[] = [];
      if (imported.unmatched > 0) lost.push(`${plural(imported.unmatched, 'note')} had no note-off and were ended at the last event.`);
      if (imported.lengthened > 0) lost.push(`${plural(imported.lengthened, 'note')} were shorter than a sixteenth and were stretched to one.`);
      if (imported.dropped > 0) lost.push(`${plural(imported.dropped, 'note')} were longer than a 128-step clip and were dropped.`);
      showTally('cv-inTally', [
        { value: imported.notes.toLocaleString(), label: 'notes' },
        { value: String(imported.clips), label: 'clips' },
        { value: `${Math.round(imported.sequencer.tempo)}`, label: 'BPM' },
        { value: imported.ours ? 'ours' : 'foreign', label: imported.ours ? 'written here' : 'from elsewhere' },
        ...(lost.length > 0 ? [{ value: String(lost.length), label: 'things to know', warn: true }] : []),
      ]);
      buildAssign(imported);
      $('cv-inReport').classList.add('on');
      takeButton.disabled = false;
      setStatus('cv-midiStatus', `${file.name}: ${plural(imported.notes, 'note')} in ${plural(imported.clips, 'clip')}`);
      for (const line of lost) logIn(line);
      midiDrop.classList.add('loaded');
      $('cv-midiTitle').textContent = `${file.name}: ${plural(imported.notes, 'note')}`;
      $('cv-midiHint').textContent = 'Click or drop to open a different file.';
    } catch (error) {
      setStatus('cv-midiStatus', String((error as Error).message ?? error), true);
      logIn(String(error), true);
    } finally {
      midiDrop.classList.remove('busy');
    }
  }

  takeButton.addEventListener('click', async () => {
    const seq = assigned();
    if (!seq) return;
    if (state.dirty && !(await confirmDialog('Throw away the unsaved changes?', 'throw them away'))) return;
    openSong(songFromSequencer(seq), `took "${seq.name}" from the MIDI file`);
    logIn(`the song is now ${seq.name || 'the imported file'}`);
  });

  function wireDrop(zone: HTMLElement, input: HTMLInputElement, open: (file: File) => void): void {
    zone.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.value = '';
      if (file) open(file);
    });
    for (const type of ['dragenter', 'dragover']) {
      zone.addEventListener(type, (event) => {
        event.preventDefault();
        zone.classList.add('over');
      });
    }
    for (const type of ['dragleave', 'drop']) {
      zone.addEventListener(type, (event) => {
        event.preventDefault();
        zone.classList.remove('over');
      });
    }
    zone.addEventListener('drop', (event) => {
      const file = (event as DragEvent).dataTransfer?.files?.[0];
      if (file) open(file);
    });
  }
  wireDrop(midiDrop, midiInput, (file) => void openMidi(file));
}
