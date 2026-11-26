// Under a setup list that shows only the places near the map's view (D41): how many saved places
// elsewhere are left out, with a button to list them all, or to go back to the nearby ones.
interface Props {
  /** How many saved places are left out. */
  hidden: number;
  /** 'zone' or 'point of interest'. */
  one: string;
  /** 'zones' or 'points of interest'. */
  many: string;
  showAll: boolean;
  onToggle: () => void;
}

export function HiddenPlaces({ hidden, one, many, showAll, onToggle }: Props) {
  if (!showAll && hidden === 0) return null;
  return (
    <p className="muted small">
      {showAll ? null : `${hidden} saved ${hidden === 1 ? one : many} elsewhere. `}
      <button type="button" className="link small" onClick={onToggle}>
        {showAll ? `Show only the ${many} near the map` : 'Show all'}
      </button>
    </p>
  );
}
