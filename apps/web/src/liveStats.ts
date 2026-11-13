// Values that change many times a second, published outside React state.
type Listener = (vehicles: number) => void;

let vehicles = 0;
const listeners = new Set<Listener>();

export const liveStats = {
  get vehicles() {
    return vehicles;
  },
  setVehicles(value: number) {
    vehicles = value;
    for (const l of listeners) l(value);
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
