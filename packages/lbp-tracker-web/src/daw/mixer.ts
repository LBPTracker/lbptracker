/**
 * The Song/Mixer view: one card with the song's settings (`MixerPanel.vue`),
 * and an "Engine" card with the switches that are not in the file
 * (`controls/engine.ts`, drawn by the shared control panel) and the live
 * meters -- notes sounding, dropouts, voices the pool has taken back, and the
 * gain the AGC after the game's master bus is applying.
 */

import { createApp, h } from 'vue';
import ControlPanel from '../controls/ControlPanel.vue';
import { CONTROLS } from '../controls/kit.ts';
import { engine } from '../controls/engine.ts';
import MixerPanel from './MixerPanel.vue';
import { onPlan, onPlayer, player, state } from './session.ts';

export function mountMixer(): void {
  // Two cards: the song's own settings, and the engine -- what is not in the file.
  const song = document.getElementById('mixer')!;
  const engineCard = document.getElementById('engine')!;
  const engineHost = document.createElement('div');
  const meters = document.createElement('div');
  meters.id = 'meters';
  meters.style.cssText = 'display:flex; gap:1.2rem; flex-wrap:wrap; margin-top:.8rem; font:.82rem/1.5 ui-monospace, Consolas, monospace; color: var(--dim)';
  engineCard.append(engineHost, meters);

  createApp({ render: () => h(MixerPanel, { state }) }).mount(song);

  const app = createApp({ render: () => h(ControlPanel, { grid: 'live' }) });
  app.provide(CONTROLS, engine);
  app.mount(engineHost);

  let stolen = 0;
  let notes = 0;
  let dropouts = 0;
  /** The AGC's gain as the worklet last reported it; null when it is not the bus. */
  let agcGain: number | null = null;
  const agc = (): string[][] => {
    if (agcGain === null) return [];
    const db = 20 * Math.log10(agcGain);
    return [['AGC', `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`]];
  };
  const show = () => {
    meters.innerHTML = [
      ['voices planned', player.plan.length.toLocaleString()],
      ['notes sounding', String(notes)],
      ['stolen so far', String(stolen)],
      ['dropouts', String(dropouts)],
      ...agc(),
    ].map(([k, v]) => `<span>${k} <b style="color:var(--ink);font-weight:500">${v}</b></span>`).join('');
  };
  onPlayer({
    health: (h) => {
      notes = h.notes;
      dropouts = h.dropouts;
      agcGain = h.agcGain;
      show();
    },
    stolen: (total) => {
      stolen = total;
      show();
    },
  });
  onPlan(show);
  show();
}
