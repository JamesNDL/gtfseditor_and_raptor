// Values that change many times a second, published outside React state.
type Listener = (vehicles: number, waiting: number) => void;

let vehicles = 0;
let waiting = 0;
const listeners = new Set<Listener>();

export const liveStats = {
  /** Vehicles on the map: running a trip, or standing between two trips. */
  get vehicles() {
    return vehicles;
  },
  /** How many of those are standing at the end of a trip, waiting to start their next one. */
  get waiting() {
    return waiting;
  },
  setVehicles(value: number, standing = 0) {
    vehicles = value;
    waiting = standing;
    for (const l of listeners) l(value, standing);
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
