/**
 * Road routing for cars behind a small interface ({@link gtfseditor.router.road.RoadRouter}),
 * done with GraphHopper (decision D14). {@link gtfseditor.router.road.RoadGraphBuilder} builds a
 * graph folder from OpenStreetMap; {@link gtfseditor.router.road.GraphHopperRoads} plans drives on
 * it. Nothing outside this module depends on GraphHopper.
 */
package gtfseditor.router.road;
