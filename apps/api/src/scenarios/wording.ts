// Words the edit summaries and the clash list share: a time in minutes, and the vehicles an edit
// used.

export const minutes = (secs: number) => {
  const m = Math.abs(secs) / 60;
  return `${Number.isInteger(m) ? m : m.toFixed(1)} min`;
};

export const fleetNote = (fleet: { reused: number; added: number }) => {
  const parts: string[] = [];
  if (fleet.added) parts.push(`${fleet.added} new vehicle${fleet.added === 1 ? '' : 's'}`);
  if (fleet.reused)
    parts.push(`${fleet.reused} trip${fleet.reused === 1 ? '' : 's'} on vehicles with spare time`);
  return parts.length ? `; ${parts.join(', ')}` : '';
};
