// The places the access check uses (docs/architecture/access-analysis.md §8, "The owner's check"):
// for real data, the Mayfield zone in Newcastle with Newcastle city centre and Westfield Kotara;
// for the small test feed (--fixture), a zone over central Sydney, where its stops are. Each plan
// also says which sample point to open, how long its drive to the first point of interest may
// take, and the bigger zone that --speed times through the API. Not a test itself.
// Places are written [longitude, latitude], as GeoJSON and the API have them.

/** A rectangle round a centre, `km` across each way, as four corners from the north-west. */
function square([lon, lat], km) {
  const halfLat = (km / 2) * (1000 / 110_540);
  const halfLon = (km / 2) * (1000 / (111_320 * Math.cos((lat * Math.PI) / 180)));
  return [
    [lon - halfLon, lat + halfLat],
    [lon + halfLon, lat + halfLat],
    [lon + halfLon, lat - halfLat],
    [lon - halfLon, lat - halfLat],
  ];
}

/** The owner's check on real data, with the corners and places of §8. */
const real = {
  name: 'real',
  zone: {
    name: 'Mayfield',
    corners: [
      [151.722, -32.884],
      [151.752, -32.884],
      [151.752, -32.909],
      [151.722, -32.909],
    ],
  },
  pois: [
    { name: 'Newcastle city centre', at: [151.772, -32.927] },
    { name: 'Westfield Kotara', at: [151.694, -32.941] },
  ],
  /** The sample point opened in 07-point-detail.png: the one nearest Mayfield station. */
  samplePointNear: [151.736, -32.8977],
  /** The drive from the middle of the zone to the first point of interest, in minutes. */
  drive: { fromMins: 5, toMins: 20 },
  /** Waiting for a run of about 120 sample points on the real routers. */
  runMinutes: 15,
  speed: {
    zone: { name: 'Newcastle speed check', corners: square([151.75, -32.92], 7) },
    pois: [
      { name: 'Speed check: Newcastle city centre', at: [151.772, -32.927] },
      { name: 'Speed check: Westfield Kotara', at: [151.694, -32.941] },
      { name: 'Speed check: John Hunter Hospital', at: [151.693, -32.9227] },
    ],
    spacingM: 100,
  },
};

/** The same steps on the small test feed and the fake router (D32). */
const fixture = {
  name: 'fixture',
  zone: {
    name: 'Central Sydney',
    corners: [
      [151.2, -33.862],
      [151.215, -33.862],
      [151.215, -33.885],
      [151.2, -33.885],
    ],
  },
  pois: [
    { name: 'Circular Quay', at: [151.2111, -33.8615] },
    { name: 'North Sydney', at: [151.2073, -33.8402] },
  ],
  /** Near Town Hall station. */
  samplePointNear: [151.207, -33.8732],
  /** The fake router drives 12 m/s over 1.3 times the straight distance: about 2.5 minutes. */
  drive: { fromMins: 1, toMins: 10 },
  runMinutes: 2,
  speed: {
    zone: { name: 'Sydney speed check', corners: square([151.205, -33.865], 7) },
    pois: [
      { name: 'Speed check: Circular Quay', at: [151.2111, -33.8615] },
      { name: 'Speed check: North Sydney', at: [151.2073, -33.8402] },
      { name: 'Speed check: Central', at: [151.2062, -33.8832] },
    ],
    spacingM: 100,
  },
};

/** The plan by name: 'real' or 'fixture'. */
export function placesFor(name) {
  const plan = { real, fixture }[name];
  if (!plan) throw new Error(`no access check plan called "${name}" (real or fixture)`);
  return plan;
}

/** The middle of a zone's corners. */
export function middleOf(corners) {
  const lons = corners.map((c) => c[0]);
  const lats = corners.map((c) => c[1]);
  return [(Math.min(...lons) + Math.max(...lons)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2];
}
