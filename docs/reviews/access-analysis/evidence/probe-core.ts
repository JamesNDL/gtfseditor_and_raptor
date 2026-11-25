// Reviewer probes of the pure analysis rules. Run from the repo root:
//   node docs/reviews/access-analysis/evidence/probe-core.ts
import { ringProblem } from '../../../../packages/core/src/analysis/polygon.ts';
import { sampleGrid } from '../../../../packages/core/src/analysis/grid.ts';
import { summarise } from '../../../../packages/core/src/analysis/summary.ts';
import {
  accessRatio,
  carSecs,
  pairStatus,
  trafficFactorAt,
  ptSplit,
} from '../../../../packages/core/src/analysis/ratio.ts';
import { DEFAULT_ANALYSIS_SETTINGS as D } from '../../../../packages/core/src/analysis/defaults.ts';
import { ratioBands, ratioLines } from '../../../../packages/core/src/analysis/contours.ts';
import { localFrame } from '../../../../packages/core/src/analysis/local-metres.ts';

const sq: [number, number][] = [
  [151.722, -32.884],
  [151.752, -32.884],
  [151.752, -32.909],
  [151.722, -32.909],
];
console.log('Mayfield zone ringProblem:', ringProblem(sq));
const g = sampleGrid(sq, 250);
console.log('Mayfield 250 m grid: points', g.points.length, 'columns', g.columns, 'rows', g.rows);
console.log('duplicate adjacent corner:', ringProblem([sq[0], sq[0], sq[1], sq[2], sq[3]]));
console.log('closing corner repeated:', ringProblem([...sq, sq[0]]));
console.log(
  'traffic factor 08:00',
  trafficFactorAt(8 * 3600, D.trafficFactors),
  '25:00',
  trafficFactorAt(25 * 3600, D.trafficFactors),
  '09:30',
  trafficFactorAt(9.5 * 3600, D.trafficFactors),
);
console.log('car secs 600 s drive x1.4 + 300 s parking =', carSecs(600, 1.4, 300));
console.log('ratio 1800/1140 =', accessRatio(1800, 1140), '; car 0 ->', accessRatio(600, 0));
console.log(
  'status with drive 0 and parking 0:',
  pairStatus({ journeyFound: true, ptSecs: 300, driveSecs: 0 }, D),
  'ratio',
  accessRatio(300, carSecs(0, 1.4, 0)),
);
console.log(
  'summary of that pair (ok, null ratio):',
  JSON.stringify(summarise([{ status: 'ok', ratio: null }], D.breaks)),
);
console.log(
  'split, asked 08:00, journey 08:10-08:40, ride 08:12-08:38, walk 240 s:',
  JSON.stringify(
    ptSplit(
      {
        depart: 29400,
        arrive: 31200,
        walkSecs: 240,
        rides: 1,
        legs: [
          {
            type: 'ride',
            depart: 29520,
            arrive: 31080,
            board: { time: 29520 },
            alight: { time: 31080 },
          },
        ],
      },
      28800,
    ),
  ),
);
// Contours: a 3 x 3 grid rising west to east.
const f = localFrame(151.737, -32.8965);
const grid = { columns: 3, rows: 3, frame: f, origin: [0, 0] as const, spacingM: 250 };
const vals = [0.5, 1.5, 2.5, 0.5, 1.5, 2.5, 0.5, 1.5, 2.5];
const bands = ratioBands(grid, vals, [1, 2]);
console.log(
  'bands piece counts',
  bands.map((b) => `${b.from}..${b.to}:${b.polygons.length}`).join(' '),
);
console.log(
  'lines',
  ratioLines(grid, vals, [1, 2])
    .map((l) => `${l.ratio}: ${l.lines.length} line(s), ${l.lines[0]?.length} points`)
    .join('; '),
);
const holed = [...vals];
holed[4] = NaN;
console.log(
  'with the centre missing: band pieces',
  ratioBands(grid, holed, [1, 2])
    .map((b) => b.polygons.length)
    .join(','),
  'lines',
  ratioLines(grid, holed, [1, 2])
    .map((l) => l.lines.length)
    .join(','),
);
