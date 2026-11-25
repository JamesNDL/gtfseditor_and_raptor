// The Access pane's map editor (D36): while the setup is showing, a tool bar floats on the map
// beside the side panel (Draw zone, Place point of interest), a name box opens on the map over a
// zone or pin that needs a name, and the picked zone's corners and the pins can be dragged.
// MapView renders it once the map is made.
import type * as maplibregl from 'maplibre-gl';
import { useStore } from '../app/store.ts';
import { AnalysisToolbar } from './map-editor/AnalysisToolbar.tsx';
import { MapNameBox } from './map-editor/MapNameBox.tsx';
import { useMapEditing } from './map-editor/use-map-editing.ts';
import { useToolKeys } from './map-editor/use-tool-keys.ts';
import './map-editor/map-editor.css';

export function AnalysisMapEditor({ map }: { map: maplibregl.Map }) {
  const shown = useStore((s) => s.leftPane === 'analysis' && s.analysis.screen === 'setup');
  useMapEditing(map, shown);
  useToolKeys(shown);
  if (!shown) return null;
  return (
    <>
      <AnalysisToolbar />
      <MapNameBox map={map} />
    </>
  );
}
