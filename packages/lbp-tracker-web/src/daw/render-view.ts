/**
 * The Render view: the song to a WAV, in the render worker.
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
import { render } from '../controls/render.ts';
import { CONTROLS } from '../controls/kit.ts';
import { VOICES_UNLIMITED, VOICE_POOL_SIZE } from '@lbptracker/lib/polyphony.ts';
import { audibleSequencer, clock, setError, state } from './session.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function mountRender(opts: { isActive: () => boolean }): void {
  for (const [at, group] of [
    ['#rd-opt-range', 'range'],
    ['#rd-opt-pool', 'pool'],
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
  const rangeFields = $<HTMLSpanElement>('rd-rangeFields');
  const fromInput = $<HTMLInputElement>('rd-from');
  const toInput = $<HTMLInputElement>('rd-to');
  const voicesInput = $<HTMLInputElement>('rd-voices');
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

  voicesInput.value = String(VOICE_POOL_SIZE);

  const readVoices = (): number | null => {
    if (render.on('optNoCap')) return VOICES_UNLIMITED;
    const text = voicesInput.value.trim();
    if (text === '') return VOICE_POOL_SIZE;
    const value = Number(text);
    return Number.isInteger(value) && value > 0 ? value : null;
  };
  const syncVoiceCap = () => {
    voicesInput.disabled = render.on('optNoCap');
    if (render.on('optNoCap')) voicesInput.classList.remove('bad');
  };
  watch(() => render.on('optNoCap'), syncVoiceCap);
  syncVoiceCap();

  const worker = new Worker(new URL('../render-worker.ts', import.meta.url), { type: 'module' });

  let wavUrl: string | null = null;
  let wavName = 'render.wav';

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
      const cards: Card[] = [
        {
          title: 'Song', big: esc(message.name || 'untitled'), span: true,
          rows: [
            ['tracks', String(message.tracks)],
            ['tempo', `${message.tempo} BPM`],
            ['rendered', `${seconds.toFixed(1)} s, ${frames.toLocaleString()} frames`],
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
            ['reverb preset', `[${(stats.reverbPreset as number[]).join(', ')}]`],
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
    if (voiceLimit === null) {
      voicesInput.classList.add('bad');
      goButton.disabled = false;
      setStatus('the voice pool is a whole number, or "off"', true);
      return;
    }
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
    if (!wavUrl) return;
    const link = document.createElement('a');
    link.href = wavUrl;
    link.download = wavName;
    link.click();
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
