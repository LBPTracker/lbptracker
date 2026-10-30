/**
 * The keyboard's media keys, and the operating system's own transport, wired
 * to this one through the Media Session API.
 *
 * ❗ **A silent loop has to be playing for any of it to arrive.** The session
 * belongs to whatever the page is *playing*, and this tracker's sound comes out
 * of an `AudioWorklet`, which is not a media element: with Web Audio alone the
 * browser gives the page no session and the keys go to whatever else is open,
 * or nowhere. So a silent WAV loops in an `<audio>` element for exactly as long
 * as the transport runs, and the handlers below are what the keys then reach.
 * ⚠️ The element must not be muted and its volume must stay up: a browser hands
 * the session to audible media, and a muted element is not that. Silence is
 * fine -- nobody listens to the samples -- but silence at volume 0 is not.
 *
 * The silence is written by the project's own `writeWav`, so there is no
 * kilobyte of base64 in the source and no second WAV writer to keep in step.
 *
 * ⚠️ **`el.play()` needs a gesture.** It is only ever called from the transport
 * starting, which is a click or a key, so the promise should not reject; it is
 * caught anyway, because a rejected one is an unhandled error in the console
 * and this feature is not worth a red line.
 */

import { writeWav } from '@lbptracker/lib/wav.ts';

import { RATE, onPlan, onPlayer, player, state } from './session.ts';

/** A quarter second of nothing, at a rate small enough to keep it tiny. */
const SILENCE_RATE = 8000;
const SILENCE_SECONDS = 0.25;

/** How far the seek keys move, in seconds, when the system does not say. */
const SEEK_STEP = 10;

export function mountMediaKeys(): void {
  const session = navigator.mediaSession as MediaSession | undefined;
  if (!session) return;

  let keeper: HTMLAudioElement | null = null;
  const keepAlive = (): HTMLAudioElement => {
    if (keeper) return keeper;
    const bytes = writeWav(new Int16Array(Math.round(SILENCE_RATE * SILENCE_SECONDS)), 1, SILENCE_RATE);
    // A copy into a plain buffer: the writer hands back a view, and a Blob
    // wants the bytes themselves.
    const blob = new Blob([new Uint8Array(bytes).buffer as ArrayBuffer], { type: 'audio/wav' });
    const el = new Audio(URL.createObjectURL(blob));
    el.loop = true;
    // Not `muted`, and not volume 0: see the note at the top.
    el.volume = 1;
    // In the document rather than detached: a detached element plays, but this
    // one is the page's media session and it should be inspectable like any
    // other -- by devtools, and by the checks that drive this page.
    el.hidden = true;
    el.dataset.role = 'media-session-keeper';
    document.body.append(el);
    keeper = el;
    return el;
  };

  const title = (): string => state.song.name || 'untitled';
  const setMetadata = (): void => {
    session.metadata = new MediaMetadata({
      title: title(),
      artist: 'LBP Tracker',
      album: `${state.song.clips.length} instrument${state.song.clips.length === 1 ? '' : 's'}`,
    });
  };

  /** Tell the system where we are, so its scrubber is not lying. */
  const setPosition = (): void => {
    const duration = player.songSeconds;
    const position = player.position() / RATE;
    // ⚠️ It throws on a duration of zero, on a position past the end, and on
    // anything not finite. A song that has not been planned yet is all three.
    if (!Number.isFinite(duration) || duration <= 0) return;
    try {
      session.setPositionState({
        duration,
        position: Math.max(0, Math.min(duration, position)),
        playbackRate: 1,
      });
    } catch {
      // Some browsers are stricter than others about the numbers; the keys
      // still work without a scrubber.
    }
  };

  const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
    ['play', () => player.play()],
    // Pause where it is, which is what this transport's own pause does.
    ['pause', () => player.stop()],
    // The Stop button's own events: the chip loop drops (`lbp:stop`), the views go back (`lbp:stopped`).
    ['stop', () => {
      window.dispatchEvent(new Event('lbp:stop'));
      player.stop();
      player.seek(0);
      window.dispatchEvent(new Event('lbp:stopped'));
    }],
    // One song is open, so the track keys are the start and the end of it.
    ['previoustrack', () => player.seek(0)],
    ['nexttrack', () => player.seek(player.frameAt(0) + Math.round(player.songSeconds * RATE))],
    ['seekbackward', (details) => {
      const by = (details.seekOffset ?? SEEK_STEP) * RATE;
      player.seek(Math.max(0, player.position() - by));
    }],
    ['seekforward', (details) => {
      const by = (details.seekOffset ?? SEEK_STEP) * RATE;
      player.seek(player.position() + by);
    }],
    ['seekto', (details) => {
      if (details.seekTime === undefined) return;
      player.seek(Math.max(0, Math.round(details.seekTime * RATE)));
    }],
  ];
  for (const [action, handler] of handlers) {
    // ⚠️ An action a browser does not know throws rather than being ignored.
    try { session.setActionHandler(action, handler); } catch { /* that one is not offered here */ }
  }

  onPlayer({
    playing: (on) => {
      session.playbackState = on ? 'playing' : 'paused';
      const el = keepAlive();
      if (on) void el.play().catch(() => { /* no gesture yet: the keys wait for the next start */ });
      else el.pause();
      setPosition();
    },
    tick: setPosition,
  });
  onPlan(() => {
    setMetadata();
    setPosition();
  });
  setMetadata();
}
