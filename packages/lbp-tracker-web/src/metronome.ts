/**
 * The metronome: a click on every beat while the song plays, switched from the
 * top bar.
 *
 * Ours, not the game's -- the sequencer has none -- so it stays out of the
 * plan, the worklet and every render: clicks are oscillators scheduled on the
 * audio context from `Player.beatsAhead`, the timeline the voices are posted
 * on, and leave through the master fader, so the volume slider and the VU meter
 * see them. A short look-ahead on a timer rather than one node per beat of the
 * song, because a seek, a tempo change or a loop turns the beats that were
 * coming into the wrong ones; `cancel` takes the scheduled ones back.
 */

import type { Player } from './player.ts';

const TICK_MS = 25;
const LOOK_AHEAD = 0.15;
const STORE = 'lbp-metronome';

export class Metronome {
  private on = false;
  private timer = 0;
  /** The last beat scheduled, so a tick never posts one twice. */
  private lastWhen = -Infinity;
  private live = new Set<OscillatorNode>();

  private readonly player: Player;

  constructor(player: Player) {
    this.player = player;
    try {
      this.on = localStorage.getItem(STORE) === '1';
    } catch { /* storage can be blocked; the default is off */ }
  }

  get enabled(): boolean {
    return this.on;
  }

  set enabled(on: boolean) {
    this.on = on;
    try {
      localStorage.setItem(STORE, on ? '1' : '0');
    } catch { /* a convenience, not state */ }
    this.cancel();
    if (on && this.player.playing) this.start();
    else this.halt();
  }

  /** Follow the transport: call from the player's `playing` event. */
  playing(playing: boolean): void {
    this.cancel();
    if (playing && this.on) this.start();
    else this.halt();
  }

  private start(): void {
    if (this.timer) return;
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  private halt(): void {
    window.clearInterval(this.timer);
    this.timer = 0;
  }

  /** Silence what has been scheduled and forget it: a seek or a restart moves the beats. */
  private cancel(): void {
    for (const osc of this.live) {
      try {
        osc.stop();
      } catch { /* already ended */ }
    }
    this.live.clear();
    this.lastWhen = -Infinity;
  }

  private tick(): void {
    const context = this.player.audioContext;
    const bus = this.player.mixBus;
    if (!context || !bus) return;
    for (const beat of this.player.beatsAhead(LOOK_AHEAD)) {
      // Half a millisecond is under any step the clock can take: the same beat
      // seen again from a later tick.
      if (beat.when <= this.lastWhen + 0.0005) continue;
      this.lastWhen = beat.when;
      this.click(context, bus, beat.when, beat.accent);
    }
  }

  private click(context: AudioContext, bus: AudioNode, when: number, accent: boolean): void {
    const osc = new OscillatorNode(context, { type: 'sine', frequency: accent ? 1568 : 1046 });
    const gain = new GainNode(context, { gain: 0 });
    const peak = accent ? 0.5 : 0.32;
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(peak, when + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.001, when + 0.045);
    osc.connect(gain).connect(bus);
    osc.start(when);
    osc.stop(when + 0.06);
    this.live.add(osc);
    osc.onended = () => {
      this.live.delete(osc);
      gain.disconnect();
    };
  }
}
