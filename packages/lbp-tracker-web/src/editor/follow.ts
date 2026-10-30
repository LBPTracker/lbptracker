/**
 * Whether a scrolling view should keep the playhead in sight.
 *
 * The board scrolls to follow the playhead while the song plays (the roll
 * does not: its scrolling is the person's alone),
 * and that used to win over the person: scroll ahead to look at the next
 * bars, or back to an earlier one, and the next tick dragged the view back to
 * the playhead. So the follow is a state, not a rule: a scroll by the person
 * that leaves the playhead out of view switches it off, a scroll that brings
 * the playhead back into view switches it on, and a seek or a play from the
 * transport switches it on too.
 *
 * ❗ **Checked against the position, not the event.** A scroll event is
 * delivered on the next frame, and the scheduler's tick landed 1 ms after the
 * person's scroll and before that event, saw the follow still on and pulled
 * the view straight back (measured). So the view remembers the position it
 * last knew, and any difference at the moment of following is the person's.
 */
/** How long a page of the view takes to slide, in milliseconds. */
const GLIDE_MS = 350;

export class Follow {
  private following = true;
  private knownLeft: number;
  /** The frame request of a glide in progress, or 0. */
  private glide = 0;
  /** When that glide ought to be over; a frame request that never ran (a hidden tab) must not hold the view for ever. */
  private glideUntil = 0;

  private readonly scroller: HTMLElement;
  /** Whether the playhead is in the view as it is scrolled now; true when there is none. */
  private readonly playheadInView: () => boolean;

  constructor(scroller: HTMLElement, playheadInView: () => boolean) {
    this.scroller = scroller;
    this.playheadInView = playheadInView;
    this.knownLeft = scroller.scrollLeft;
    scroller.addEventListener('scroll', () => this.notice());
    // The person's hands outrank a glide: it stops where it is.
    for (const type of ['wheel', 'pointerdown', 'touchstart', 'keydown'] as const) {
      scroller.addEventListener(type, () => this.stop(), { passive: true });
    }
  }

  private stop(): void {
    if (!this.glide) return;
    cancelAnimationFrame(this.glide);
    this.glide = 0;
    this.knownLeft = this.scroller.scrollLeft;
  }

  /** A change of position since the view last looked is the person's: follow or not by where the playhead is now. */
  private notice(): void {
    if (this.scroller.scrollLeft === this.knownLeft) return;
    // Our own glide moves the view a little every frame: not the person's.
    if (this.glide) {
      this.knownLeft = this.scroller.scrollLeft;
      return;
    }
    this.knownLeft = this.scroller.scrollLeft;
    this.following = this.playheadInView();
  }

  /** Whether to follow right now, the person's scrolls taken into account. */
  get on(): boolean {
    this.notice();
    return this.following;
  }

  /**
   * The view's own scroll, to keep the playhead in sight. `glide` turns the
   * page into a short ease-out slide instead of a jump; a call while one is
   * running is ignored, so the slide keeps the target it set out for.
   */
  scrollTo(left: number, glide = false): void {
    if (this.glide && performance.now() < this.glideUntil) return;
    this.stop();
    const from = this.scroller.scrollLeft;
    // A target past the end of the scroll range would be reached by the first few frames and then held by the clamp: the slide has to be the distance it really covers.
    left = Math.max(0, Math.min(left, this.scroller.scrollWidth - this.scroller.clientWidth));
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!glide || reduced || Math.abs(left - from) < 4) {
      this.scroller.scrollLeft = left;
      this.knownLeft = this.scroller.scrollLeft;
      return;
    }
    const start = performance.now();
    this.glideUntil = start + GLIDE_MS + 100;
    const step = (now: number): void => {
      const k = Math.min(1, (now - start) / GLIDE_MS);
      const eased = 1 - (1 - k) ** 3;
      this.scroller.scrollLeft = from + (left - from) * eased;
      this.knownLeft = this.scroller.scrollLeft;
      if (k < 1) {
        this.glide = requestAnimationFrame(step);
      } else {
        this.glide = 0;
      }
    };
    this.glide = requestAnimationFrame(step);
  }

  /** A seek, or play pressed: back to following, wherever the view was left. */
  resume(): void {
    this.stop();
    this.knownLeft = this.scroller.scrollLeft;
    this.following = true;
  }
}
