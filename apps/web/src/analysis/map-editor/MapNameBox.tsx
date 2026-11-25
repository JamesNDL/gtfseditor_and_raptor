// The name box on the map (D36): it opens just above a closed outline, a new pin or a pin being
// renamed, follows it as the map moves, and stays inside the map's edges. It is a plain div laid
// over the map and placed from `map.project`, not a MapLibre popup, so that it is ordinary React
// with the side panel's name form inside. Its place is set on the element as the map moves,
// without rendering again. Enter saves, Escape cancels.
import type { GeoJsonPosition } from '@gtfs-editor/core';
import type * as maplibregl from 'maplibre-gl';
import { useLayoutEffect, useRef } from 'react';
import { useStore } from '../../app/store.ts';
import { usePlaces } from '../analysis-api.ts';
import { nameBoxFor, type NameBoxSpec } from '../map-work.ts';
import { NameForm } from '../setup/NameForm.tsx';
import { cancelName, saveName } from './map-actions.ts';
import { nameBoxPlace } from './name-box-place.ts';

const TITLES: Record<NameBoxSpec['kind'], string> = {
  zone: 'Name the zone',
  'new-poi': 'Name the point of interest',
  'rename-poi': 'Rename the point of interest',
};

/** Puts the box above (or below) its place, its point aimed at the place. */
function placeBox(map: maplibregl.Map, box: HTMLDivElement, anchor: GeoJsonPosition): void {
  const point = map.project(anchor);
  const canvas = map.getCanvas();
  const size = { width: box.offsetWidth, height: box.offsetHeight };
  const view = { width: canvas.clientWidth, height: canvas.clientHeight };
  const { left, top, below } = nameBoxPlace(point, size, view);
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
  // The point aims at the place even when the box is pushed in from an edge.
  const aim = Math.max(14, Math.min(size.width - 14, point.x - left));
  box.style.setProperty('--aim', `${aim}px`);
  box.classList.toggle('below', below);
}

export function MapNameBox({ map }: { map: maplibregl.Map }) {
  const work = useStore((s) => s.analysis.work);
  const pois = usePlaces((s) => s.pois);
  const spec = nameBoxFor(work, pois);
  const boxRef = useRef<HTMLDivElement>(null);
  const anchorKey = spec ? spec.anchor.join(',') : null;

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box || anchorKey === null) return;
    const anchor = anchorKey.split(',').map(Number) as GeoJsonPosition;
    const put = () => placeBox(map, box, anchor);
    put();
    map.on('move', put);
    map.on('resize', put);
    return () => {
      map.off('move', put);
      map.off('resize', put);
    };
  }, [map, anchorKey]);

  if (!spec) return null;
  // The form starts afresh for each thing named; a new pin moved by another click keeps its text.
  const formKey = `${spec.kind}-${work.renamingPoiId ?? ''}-${spec.kind === 'new-poi' ? '' : anchorKey}`;
  return (
    <div ref={boxRef} className="aa-name-box panel" role="dialog" aria-label={TITLES[spec.kind]}>
      <p className="aa-name-title">{TITLES[spec.kind]}</p>
      <NameForm
        key={formKey}
        label={spec.label}
        initial={spec.initial}
        onSave={saveName}
        onCancel={cancelName}
      />
    </div>
  );
}
