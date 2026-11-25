// The key to an analysis's results map (FR-19, AC-FR-19.1), on the map at the bottom left: each
// band's colour and range, no service and no road, the settings in one line, and the credit for
// the drive times. It reads the same in both themes, and is clean enough to put in a report.
import type { AnalysisDetail } from '@gtfs-editor/core';
import {
  NO_ROAD_COLOUR,
  NO_SERVICE_COLOUR,
  NO_SERVICE_RING,
  bandColours,
} from '../analysis-colours.ts';
import { OSM_CREDIT, bandLabel, bandRanges, settingsLine } from './results-text.ts';

export function AnalysisLegend({
  detail,
  poiName,
  breaks,
}: {
  detail: AnalysisDetail;
  poiName: string;
  breaks: readonly number[];
}) {
  const ranges = bandRanges(breaks);
  const colours = bandColours(ranges.length);
  return (
    <div className="panel analysis-legend" aria-label="Key to the access ratio map">
      <div className="analysis-legend-title">Access ratio to {poiName}</div>
      <div className="muted small">Public transport time ÷ car time</div>
      <ul className="analysis-legend-list">
        {ranges.map((range, k) => (
          <li key={bandLabel(range)}>
            <i className="analysis-swatch" style={{ background: colours[k] }} />
            {bandLabel(range)}
          </li>
        ))}
        <li>
          <i
            className="analysis-dot"
            style={{ background: NO_SERVICE_COLOUR, borderColor: NO_SERVICE_RING }}
          />
          No service
        </li>
        <li>
          <i className="analysis-dot" style={{ borderColor: NO_ROAD_COLOUR }} />
          No road
        </li>
      </ul>
      <div className="small">{settingsLine(detail)}</div>
      <div className="muted small">{OSM_CREDIT}</div>
    </div>
  );
}
