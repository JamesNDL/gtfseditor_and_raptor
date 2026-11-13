// The simulation clock. Kept outside React state because it changes every frame.

type Listener = (secs: number) => void;

let secs = 8 * 3600;
let maxSecs = 30 * 3600;
const listeners = new Set<Listener>();

export const clock = {
  get secs() {
    return secs;
  },
  get maxSecs() {
    return maxSecs;
  },
  setMax(value: number) {
    maxSecs = value;
  },
  set(value: number) {
    secs = Math.max(0, Math.min(maxSecs, value));
    for (const l of listeners) l(secs);
  },
  /** Advances the clock by real elapsed milliseconds at the given speed, wrapping at the end of the day. */
  advance(elapsedMs: number, speed: number) {
    let next = secs + (elapsedMs / 1000) * speed;
    if (next > maxSecs) next = 0;
    clock.set(next);
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
