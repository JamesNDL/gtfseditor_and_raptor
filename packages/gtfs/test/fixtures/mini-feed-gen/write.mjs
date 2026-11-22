// Writes the feed's tables out as GTFS text files.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SERVICE, routes, shapes, stopTimes, stops, trips } from './feed.mjs';

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
const table = (columns, rows) =>
  [columns.join(','), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(','))].join('\n') +
  '\n';

/** Writes every table, plus the fixed agency, calendar and pathway files, into the folder `out`. */
export async function writeFeed(out) {
  await mkdir(out, { recursive: true });
  const files = {
    'agency.txt': table(
      ['agency_id', 'agency_name', 'agency_url', 'agency_timezone', 'agency_lang', 'agency_phone'],
      [
        ['XTR', 'Test Trains'],
        ['XBS', 'Test Buses'],
        ['XFY', 'Test Ferries'],
      ].map(([agency_id, agency_name]) => ({
        agency_id,
        agency_name,
        agency_url: 'https://example.com/',
        agency_timezone: 'Australia/Sydney',
        agency_lang: 'EN',
        agency_phone: '',
      })),
    ),
    'calendar.txt': table(
      [
        'service_id',
        'monday',
        'tuesday',
        'wednesday',
        'thursday',
        'friday',
        'saturday',
        'sunday',
        'start_date',
        'end_date',
      ],
      [
        {
          service_id: SERVICE,
          monday: 1,
          tuesday: 1,
          wednesday: 1,
          thursday: 1,
          friday: 1,
          saturday: 0,
          sunday: 0,
          start_date: '20260105',
          end_date: '20271231',
        },
      ],
    ),
    // Not running on Australia Day, which falls on a Tuesday in 2027.
    'calendar_dates.txt': table(
      ['service_id', 'date', 'exception_type'],
      [{ service_id: SERVICE, date: '20270126', exception_type: 2 }],
    ),
    'routes.txt': table(
      [
        'route_id',
        'agency_id',
        'route_short_name',
        'route_long_name',
        'route_desc',
        'route_type',
        'route_color',
        'route_text_color',
        'exact_times',
      ],
      routes,
    ),
    'stops.txt': table(
      [
        'stop_id',
        'stop_code',
        'stop_name',
        'stop_lat',
        'stop_lon',
        'location_type',
        'parent_station',
        'wheelchair_boarding',
        'level_id',
        'platform_code',
      ],
      stops,
    ),
    'trips.txt': table(
      [
        'route_id',
        'service_id',
        'trip_id',
        'shape_id',
        'trip_headsign',
        'direction_id',
        'block_id',
        'wheelchair_accessible',
        'route_direction',
        'trip_note',
        'bikes_allowed',
      ],
      trips,
    ),
    'stop_times.txt': table(
      [
        'trip_id',
        'arrival_time',
        'departure_time',
        'stop_id',
        'stop_sequence',
        'stop_headsign',
        'pickup_type',
        'drop_off_type',
        'shape_dist_traveled',
        'timepoint',
        'stop_note',
      ],
      stopTimes,
    ),
    'shapes.txt':
      'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence,shape_dist_traveled\n' +
      shapes.join('\n') +
      '\n',
    // A walkway between the two platforms at Central.
    'pathways.txt': table(
      [
        'pathway_id',
        'from_stop_id',
        'to_stop_id',
        'pathway_mode',
        'is_bidirectional',
        'traversal_time',
      ],
      [
        {
          pathway_id: 'XCEN-P1-P2',
          from_stop_id: 'XCEN1',
          to_stop_id: 'XCEN2',
          pathway_mode: 1,
          is_bidirectional: 1,
          traversal_time: 60,
        },
      ],
    ),
  };
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(out, name), text);
}
