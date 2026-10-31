/**
 * The Render view: the song to a WAV, in the render worker, and on request the
 * same samples as OGG Vorbis or MP3 (`encode` in `render-worker.ts`).
 *
 * All it does is hand the song to `render-worker.ts` and show what comes
 * back: the finished samples for the waveform, and the same 48 kHz WAV bytes
 * `packages/lbp-tracker-lib/dev/render-level.ts` would have written, handed
 * to an `<audio>` element as a blob. Playback of the result is the browser's
 * only job here -- no resampling, no `playbackRate`.
 *
 * ❗ It renders **the song that is open**, as it is heard: the same rows the
 * player schedules under the mutes and solos, so what is heard on the
 * transport is what the file will hold.
 */

import { createApp, h, watch } from 'vue';
import Checks from '../controls/Checks.vue';
import Choice from '../controls/Choice.vue';
import Fader from '../controls/Fader.vue';
import { render } from '../controls/render.ts';
import { CONTROLS } from '../controls/kit.ts';
import { POOL_UNLIMITED_AT } from '../controls/engine.ts';
import { VOICES_UNLIMITED } from '@lbptracker/lib/polyphony.ts';
import { reverbSummary } from '@lbptracker/lib/audio/effects.ts';
import { audibleSequencer, clock, setError, state } from './session.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function mountRender(opts: { isActive: () => boolean }): void {
  for (const [at, group] of [
    ['#rd-opt-range', 'range'],
    ['#rd-opt-stage', 'stage'],
    ['#rd-opt-clip', 'clip'],
  ] as const) {
    const app = createApp({ render: () => h(Checks, { group }) });
    app.provide(CONTROLS, render);
    app.mount(at);
  }
  const masterApp = createApp({ render: () => h(Choice, { group: 'master' }) });
  masterApp.provide(CONTROLS, render);
  masterApp.mount('#rd-opt-master');
  const voicesApp = createApp({ render: () => h(Fader, { id: 'renderVoices' }) });
  voicesApp.provide(CONTROLS, render);
  voicesApp.mount('#rd-voices');
  const rangeFields = $<HTMLSpanElement>('rd-rangeFields');
  const fromInput = $<HTMLInputElement>('rd-from');
  const toInput = $<HTMLInputElement>('rd-to');
  const goButton = $<HTMLButtonElement>('rd-go');
  const saveButton = $<HTMLButtonElement>('rd-save');
  const statusLine = $<HTMLDivElement>('rd-status');
  const barFill = $<HTMLDivElement>('rd-bar').firstElementChild as HTMLDivElement;
  const statsGrid = $<HTMLDivElement>('rd-stats');
  const player = $<HTMLAudioElement>('rd-player');
  const canvas = $<HTMLCanvasElement>('rd-wave');
  const playPause = $<HTMLButtonElement>('rd-playPause');
  const timesLabel = $<HTMLSpanElement>('rd-times');
  const volSlider = $<HTMLInputElement>('rd-vol');
  const formatSelect = $<HTMLSelectElement>('rd-format');
  const qualitySelect = $<HTMLSelectElement>('rd-quality');
  const qualityRow = $<HTMLDivElement>('rd-qualityRow');

  /** The slider's last step is no cap at all, as on the engine card. */
  const readVoices = (): number => {
    const size = render.raw('renderVoices');
    return size >= POOL_UNLIMITED_AT ? VOICES_UNLIMITED : size;
  };

  const worker = new Worker(new URL('../render-worker.ts', import.meta.url), { type: 'module' });

  let wavUrl: string | null = null;
  let wavName = 'render.wav';

  // ------------------------------------------------------------ the format
  // WAV is what the render makes; OGG and MP3 are encoded from its samples when
  // asked for, once per format and setting, until the next render.
  type Format = 'wav' | 'ogg' | 'mp3';
  const QUALITIES: Record<Exclude<Format, 'wav'>, { value: number; label: string }[]> = {
    mp3: [
      { value: 320, label: '320 kbit/s' },
      { value: 256, label: '256 kbit/s' },
      { value: 192, label: '192 kbit/s' },
      { value: 128, label: '128 kbit/s' },
    ],
    // Vorbis's own quality scale; the rates are its nominal ones at 48 kHz stereo.
    ogg: [
      { value: 8, label: 'q8, about 256 kbit/s' },
      { value: 6, label: 'q6, about 192 kbit/s' },
      { value: 4, label: 'q4, about 128 kbit/s' },
    ],
  };
  const LABEL: Record<Format, string> = { wav: 'WAV', ogg: 'OGG', mp3: 'MP3' };
  const MIME: Record<Format, string> = { wav: 'audio/wav', ogg: 'audio/ogg', mp3: 'audio/mpeg' };
  /** A per-viewer convenience, so wrapped: storage can be blocked, and the page works without it. */
  const remember = (key: string, value?: string): string | null => {
    try {
      if (value === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, value);
    } catch { /* not kept, that is all */ }
    return null;
  };
  const format = (): Format => formatSelect.value as Format;
  const quality = (): number => Number(qualitySelect.value);
  const paintFormat = () => {
    const f = format();
    qualityRow.hidden = f === 'wav';
    if (f !== 'wav') {
      const keep = remember(`lbp-render-quality-${f}`);
      qualitySelect.innerHTML = '';
      for (const q of QUALITIES[f]) qualitySelect.add(new Option(q.label, String(q.value)));
      if (keep && QUALITIES[f].some((q) => String(q.value) === keep)) qualitySelect.value = keep;
    }
    saveButton.textContent = `Download .${f}`;
  };
  const saved = remember('lbp-render-format');
  if (saved === 'wav' || saved === 'ogg' || saved === 'mp3') formatSelect.value = saved;
  paintFormat();
  formatSelect.addEventListener('change', () => {
    remember('lbp-render-format', format());
    paintFormat();
  });
  qualitySelect.addEventListener('change', () => remember(`lbp-render-quality-${format()}`, qualitySelect.value));

  /** Encoded files of the current render, by format and setting. */
  const encoded = new Map<string, string>();
  let encoding = false;
  const fileName = (f: Format) => `${(state.song.name || 'song').replace(/[^\w.-]+/g, '_')}.${f}`;
  const download = (url: string, name: string) => {
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
  };

  const setStatus = (text: string, bad = false) => {
    statusLine.textContent = text;
    statusLine.classList.toggle('bad', bad);
  };

  function parseTime(text: string): number | null | undefined {
    const trimmed = text.trim();
    if (trimmed === '') return undefined;
    const parts = trimmed.split(':');
    if (parts.length > 2 || parts.some((p) => p === '' || !/^\d+(\.\d+)?$/.test(p))) return null;
    const seconds = parts.length === 2 ? Number(parts[0]) * 60 + Number(parts[1]) : Number(parts[0]);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
  }

  const setBar = (fraction: number) => {
    barFill.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
  };

  /**
   * How much of a render each phase is worth. ⚠️ Measured: on the 368-second
   * reference render the mix is 92% of the wait.
   */
  const WEIGHTS: Record<string, { start: number; span: number; label: string }> = {
    voices: { start: 0, span: 0.02, label: 'scheduling voices' },
    mix: { start: 0.02, span: 0.92, label: 'mixing voices' },
    effects: { start: 0.94, span: 0.06, label: 'echo and reverb' },
  };

  function resetResults() {
    if (wavUrl) URL.revokeObjectURL(wavUrl);
    wavUrl = null;
    for (const url of encoded.values()) URL.revokeObjectURL(url);
    encoded.clear();
    player.removeAttribute('src');
    player.load();
    saveButton.disabled = true;
    statsGrid.innerHTML = '';
    peaks = null;
    canvas.classList.add('empty');
    for (const el of [playPause, volSlider]) el.disabled = true;
    paint();
    syncTransport();
  }

  // ---------------------------------------------------------- the player
  // The waveform IS the transport for the rendered file: it draws the
  // position, takes the clicks and the keys. The `<audio>` stays the decoder.

  let peaks: Float32Array | null = null;
  let scrubbing = false;
  const PLAY = '▶';
  const PAUSE = '⏸';

  function paint() {
    const context = canvas.getContext('2d')!;
    const { width, height } = canvas;
    context.clearRect(0, 0, width, height);
    if (!peaks) return;
    const duration = Number.isFinite(player.duration) ? player.duration : 0;
    const played = duration > 0 ? Math.round((player.currentTime / duration) * width) : 0;
    const mid = height / 2;
    for (let x = 0; x < width; x += 1) {
      const h = Math.max(1, peaks[x] * (height - 6));
      context.fillStyle = x <= played ? '#6fd3a0' : '#3d4a52';
      context.fillRect(x, mid - h / 2, 1, h);
    }
    if (duration > 0) {
      context.fillStyle = '#e6e8ec';
      context.fillRect(Math.min(played, width - 2), 0, 2, height);
    }
  }

  function syncTransport() {
    const duration = Number.isFinite(player.duration) ? player.duration : 0;
    timesLabel.textContent = `${clock(player.currentTime)} / ${clock(duration)}`;
    playPause.textContent = player.paused ? PLAY : PAUSE;
    playPause.setAttribute('aria-label', player.paused ? 'Play' : 'Pause');
    canvas.setAttribute('aria-valuemax', duration.toFixed(1));
    canvas.setAttribute('aria-valuenow', player.currentTime.toFixed(1));
    canvas.setAttribute('aria-valuetext', peaks ? `${clock(player.currentTime)} of ${clock(duration)}` : 'nothing rendered yet');
  }

  function frame() {
    paint();
    syncTransport();
    if (!player.paused && !player.ended) requestAnimationFrame(frame);
  }

  function seekTo(clientX: number) {
    const duration = Number.isFinite(player.duration) ? player.duration : 0;
    if (!peaks || duration <= 0) return;
    const box = canvas.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    player.currentTime = ratio * duration;
    paint();
    syncTransport();
  }

  canvas.addEventListener('pointerdown', (event) => {
    if (!peaks) return;
    scrubbing = true;
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // not a tracked pointer
    }
    seekTo(event.clientX);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (scrubbing) seekTo(event.clientX);
  });
  canvas.addEventListener('pointerup', (event) => {
    scrubbing = false;
    try {
      canvas.releasePointerCapture(event.pointerId);
    } catch {
      // as above
    }
  });

  const togglePlay = () => {
    if (!peaks) return;
    if (player.paused) void player.play();
    else player.pause();
  };
  playPause.addEventListener('click', togglePlay);

  canvas.addEventListener('keydown', (event) => {
    const duration = Number.isFinite(player.duration) ? player.duration : 0;
    if (!peaks || duration <= 0) return;
    const step = event.shiftKey ? 30 : 5;
    const set = (t: number) => {
      player.currentTime = Math.min(duration, Math.max(0, t));
      paint();
      syncTransport();
    };
    switch (event.key) {
      case ' ':
      case 'Enter': togglePlay(); break;
      case 'ArrowLeft': set(player.currentTime - step); break;
      case 'ArrowRight': set(player.currentTime + step); break;
      case 'Home': set(0); break;
      case 'End': set(duration); break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
  });

  volSlider.addEventListener('input', () => {
    player.volume = Number(volSlider.value);
    player.muted = player.volume === 0;
    syncTransport();
  });
  player.addEventListener('play', frame);
  player.addEventListener('pause', () => { paint(); syncTransport(); });
  player.addEventListener('ended', () => { paint(); syncTransport(); });
  player.addEventListener('loadedmetadata', () => { paint(); syncTransport(); });
  player.addEventListener('timeupdate', () => { if (!scrubbing) syncTransport(); });

  function drawWave(left: Float32Array, right: Float32Array) {
    const { width } = canvas;
    const envelope = new Float32Array(width);
    const per = Math.max(1, Math.floor(left.length / width));
    for (let x = 0; x < width; x += 1) {
      let peak = 0;
      const start = x * per;
      for (let i = start; i < start + per && i < left.length; i += 1) {
        const v = Math.max(Math.abs(left[i]), Math.abs(right[i]));
        if (v > peak) peak = v;
      }
      envelope[x] = peak;
    }
    peaks = envelope;
    canvas.classList.remove('empty');
    for (const el of [playPause, volSlider]) el.disabled = false;
    paint();
    syncTransport();
  }

  worker.onmessage = (event: MessageEvent) => {
    const message = event.data as Record<string, unknown>;
    if (message.type === 'status') {
      setStatus(String(message.text));
      return;
    }
    if (message.type === 'progress') {
      const done = Number(message.done);
      const total = Number(message.total);
      const weight = WEIGHTS[String(message.phase)];
      if (!weight) return;
      const within = total > 0 ? done / total : 0;
      setBar(weight.start + weight.span * within);
      setStatus(`${weight.label}… ${(within * 100).toFixed(0)}%`);
      return;
    }
    if (message.type === 'done') {
      const stats = message.stats as Record<string, number | number[]>;
      drawWave(message.left as Float32Array, message.right as Float32Array);
      if (wavUrl) URL.revokeObjectURL(wavUrl);
      wavUrl = URL.createObjectURL(new Blob([message.wav as BlobPart], { type: 'audio/wav' }));
      wavName = `${(state.song.name || 'song').replace(/[^\w.-]+/g, '_')}.wav`;
      player.src = wavUrl;
      saveButton.disabled = false;
      goButton.disabled = false;

      const seconds = Number(stats.seconds);
      const frames = Number(stats.frames);
      const elapsed = Number(stats.elapsed);
      const pct = (x: unknown) => `${(Number(x) * 100).toFixed(1)}%`;
      const secs = (ms: unknown) => `${(Number(ms) / 1000).toFixed(2)} s`;
      const esc = (x: unknown) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      type Card = { title: string; big: string; unit?: string; rows: [string, string][]; span?: boolean };
      // Five cards of a size, the song first; its name is in the bar already.
      const reverb = reverbSummary(state.song.reverb);
      const cards: Card[] = [
        {
          title: 'Song', big: clock(seconds), unit: 'rendered',
          rows: [
            ['tempo', `${message.tempo} BPM`],
            ['tracks', String(message.tracks)],
            ['frames', frames.toLocaleString()],
          ],
        },
        {
          title: 'Notes', big: String(stats.played), unit: 'played',
          rows: [['skipped', String(stats.skipped)], ['cut by the voice pool', String(stats.stolen)]],
        },
        {
          title: 'Effects', big: pct(stats.echoRel), unit: 'echo, of the dry mix',
          rows: [
            ['echo delay', `${Number(stats.echoSeconds).toFixed(3)} s`],
            ['reverb', pct(stats.reverbRel)],
            ['preset', esc(reverb.name ?? `setting ${state.song.reverb}`)],
          ],
        },
        {
          title: 'Output', big: Number(stats.peak).toFixed(3), unit: 'peak',
          rows: [
            ['RMS', Number(stats.rms).toFixed(5)],
            ['clipped', `${((100 * Number(stats.clippedFrames)) / frames).toFixed(2)}% of frames`],
            ...(Number(stats.norm) !== 1 ? [['normalised by', Number(stats.norm).toFixed(3)] as [string, string]] : []),
          ],
        },
        {
          title: 'Render time', big: `${elapsed.toFixed(2)} s`, unit: `${(seconds / elapsed).toFixed(1)}x realtime`,
          rows: [['voices', secs(stats.voicesMs)], ['mix', secs(stats.mixMs)], ['effects', secs(stats.effectsMs)]],
        },
      ];
      statsGrid.innerHTML = cards
        .map((c) =>
          `<div class="stat-card${c.span ? ' span' : ''}"><h3>${c.title}</h3>` +
          `<div class="big">${c.big}${c.unit ? `<small>${c.unit}</small>` : ''}</div>` +
          `<dl>${c.rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></div>`)
        .join('');
      setBar(1);
      setStatus(`done: ${seconds.toFixed(1)} s rendered in ${elapsed.toFixed(2)} s`);
      return;
    }
    if (message.type === 'encoded') {
      const f = message.format as Exclude<Format, 'wav'>;
      const bytes = message.bytes as Uint8Array;
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: MIME[f] }));
      encoded.set(`${f}:${message.quality}`, url);
      encoding = false;
      saveButton.disabled = false;
      setStatus(`${LABEL[f]} ready, ${(bytes.length / 1048576).toFixed(1)} MB`);
      download(url, fileName(f));
      return;
    }
    if (message.type === 'encode-error') {
      encoding = false;
      saveButton.disabled = false;
      setStatus('the file could not be encoded', true);
      setError(String(message.text));
      return;
    }
    if (message.type === 'error') {
      goButton.disabled = false;
      setStatus('failed', true);
      setError(String(message.text));
    }
  };

  goButton.addEventListener('click', () => {
    setError('');
    goButton.disabled = true;
    saveButton.disabled = true;
    const from = render.on('useRange') ? parseTime(fromInput.value) : undefined;
    const to = render.on('useRange') ? parseTime(toInput.value) : undefined;
    fromInput.classList.toggle('bad', from === null);
    toInput.classList.toggle('bad', to === null);
    if (from === null || to === null) {
      goButton.disabled = false;
      setStatus('a time looks like 90 or 1:30', true);
      return;
    }
    if (to !== undefined && to <= (from ?? 0)) {
      toInput.classList.add('bad');
      goButton.disabled = false;
      setStatus('the end has to come after the start', true);
      return;
    }
    const voiceLimit = readVoices();
    resetResults();
    setBar(0);
    worker.postMessage({
      type: 'render',
      // What is heard: the rows the mutes and solos leave, as on the transport.
      sequencer: audibleSequencer(),
      from: from ?? 0,
      seconds: to === undefined ? 0 : to - (from ?? 0),
      voiceLimit,
      reverb: render.on('optReverb'),
      echo: render.on('optEcho'),
      clip: render.on('optClip'),
      master: render.picked('master'),
    });
  });

  saveButton.addEventListener('click', () => {
    if (!wavUrl || encoding) return;
    const f = format();
    if (f === 'wav') {
      download(wavUrl, wavName);
      return;
    }
    const ready = encoded.get(`${f}:${quality()}`);
    if (ready) {
      download(ready, fileName(f));
      return;
    }
    encoding = true;
    saveButton.disabled = true;
    setStatus(`encoding ${LABEL[f]}…`);
    worker.postMessage({ type: 'encode', format: f, quality: quality() });
  });

  watch(() => render.on('useRange'), () => {
    const on = render.on('useRange');
    fromInput.disabled = !on;
    toInput.disabled = !on;
    rangeFields.classList.toggle('off', !on);
    if (!on) {
      fromInput.classList.remove('bad');
      toInput.classList.remove('bad');
    } else fromInput.focus();
  });

  // The button follows the song: something to render, or not.
  const sync = () => {
    goButton.disabled = state.song.clips.length === 0;
  };
  state.onChange(sync);
  sync();
  setBar(0);
  void opts;
}
