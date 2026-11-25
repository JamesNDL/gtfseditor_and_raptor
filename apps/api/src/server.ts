import compress from '@fastify/compress';
import Fastify from 'fastify';
import { connect, migrate } from '@gtfs-editor/gtfs/db';
import { registerAnalysisPlaceRoutes } from './analysis/places-routes.ts';
import { registerAnalysisRoutes } from './analysis/routes.ts';
import { registerExportRoutes } from './export/routes.ts';
import { registerFleetRoutes } from './catalogue/routes.ts';
import { registerBaselineRoutes } from './network/baselines.ts';
import { registerInspectorRoutes } from './network/inspector.ts';
import { registerMapDataRoutes } from './network/map-data.ts';
import { registerTimelineRoutes } from './network/timelines.ts';
import { registerScenarioRoutes } from './scenarios/routes.ts';
import { registerSimRoutes } from './sim/sim.ts';
import { registerSimResultRoutes } from './sim/results-read.ts';

const PORT = Number(process.env.PORT ?? 3001);

const sql = connect();
const ran = await migrate(sql);
if (ran.length > 0) console.log(`Ran migrations ${ran.join(', ')}`);

const app = Fastify({ logger: { level: 'warn' } });
await app.register(compress, { threshold: 1024 });

registerBaselineRoutes(app, sql);
registerMapDataRoutes(app, sql);
registerInspectorRoutes(app, sql);
registerTimelineRoutes(app, sql);
registerScenarioRoutes(app, sql);
registerFleetRoutes(app, sql);
registerExportRoutes(app, sql);
registerSimRoutes(app, sql);
registerSimResultRoutes(app, sql);
registerAnalysisPlaceRoutes(app, sql);
const analyses = registerAnalysisRoutes(app, sql);

app.get('/api/health', async () => ({ ok: true }));

await app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`API listening on http://localhost:${PORT}`);

// Analyses that were going when this API last stopped carry on (D20). After listening, as the
// router fetches the timetable's export from this API.
analyses
  .resume()
  .catch((err: unknown) => app.log.error(err, 'could not pick up unfinished analyses'));
