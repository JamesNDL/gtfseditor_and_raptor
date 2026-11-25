package gtfseditor.router.server;

import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import gtfseditor.router.road.LatLon;
import gtfseditor.router.road.RoadRoute;
import gtfseditor.router.road.RoadRouter;
import gtfseditor.router.road.RoadTable;
import gtfseditor.router.road.Snapped;
import gtfseditor.router.server.OsrmRequest.Annotation;
import gtfseditor.router.server.OsrmRequest.Refusal;
import io.javalin.http.Context;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.function.Supplier;

/**
 * The three OSRM-shaped endpoints at the root of the service (architecture §3.3 and §3.6; FR-13;
 * decision D16): {@code GET /route/v1/driving/…}, {@code /table/v1/driving/…} and
 * {@code /nearest/v1/driving/…}, answering as OSRM does, so that the editor's {@code ROUTER_URL}
 * can name this router with no change to {@code apps/api/src/routing/roads.ts}. An answer is 200
 * with {@code code: "Ok"}; a refusal is 400 with {@code code} and {@code message}. Times are
 * free-flow seconds and distances metres, for cars. They answer the same in road-only mode.
 */
final class OsrmApi {

    /** The longest request line and headers taken, in bytes: room for a route through 500 points. */
    static final int REQUEST_BYTES = 32 * 1024;

    /** Most points in one route. */
    private static final int ROUTE_POINTS = 500;

    /** Most points in one table. */
    private static final int TABLE_POINTS = 100;

    /** Most other drives besides the first: three routes in all. */
    private static final int MOST_ALTERNATIVES = 2;

    private static final JsonNodeFactory JSON = JsonNodeFactory.instance;

    private final RoadApi road;

    OsrmApi(RoadApi road) {
        this.road = road;
    }

    /** {@code GET /route/v1/driving/{lon,lat;…}}: one drive through the points, and others if asked for. */
    void route(Context ctx) {
        answer(ctx, () -> {
            String geometries = ctx.queryParam("geometries");
            if (geometries != null && !geometries.equals("geojson")) {
                throw new Refusal(OsrmRequest.INVALID_OPTIONS, "geometries must be geojson; '" + geometries
                        + "' is not offered");
            }
            if (OsrmRequest.flag(ctx.queryParam("steps"), "steps", false)) {
                throw new Refusal(OsrmRequest.INVALID_OPTIONS, "steps=true is not offered: routes have no steps");
            }
            boolean overview = overview(ctx.queryParam("overview"));
            int alternatives = OsrmRequest.alternatives(ctx.queryParam("alternatives"), MOST_ALTERNATIVES);
            List<LatLon> points = points(ctx, ROUTE_POINTS);
            if (points.size() < 2) {
                throw new Refusal(OsrmRequest.INVALID_OPTIONS, "a route needs at least two points");
            }
            RoadRoute found = road.router().route(points, alternatives > 0);
            if (found.status() == RoadRoute.Status.NO_ROAD) {
                throw new Refusal("NoSegment", found.reason());
            }
            if (found.status() == RoadRoute.Status.NO_ROUTE) {
                throw new Refusal("NoRoute", found.reason());
            }
            ObjectNode answer = ok();
            ArrayNode routes = answer.putArray("routes");
            routes.add(route(found, overview));
            for (RoadRoute other : found.alternatives().subList(0, Math.min(alternatives,
                    found.alternatives().size()))) {
                routes.add(route(other, overview));
            }
            ArrayNode waypoints = answer.putArray("waypoints");
            found.snapped().forEach(snapped -> waypoints.add(waypoint(snapped, null)));
            return answer;
        });
    }

    /** {@code GET /table/v1/driving/{lon,lat;…}}: drives between every source and destination. */
    void table(Context ctx) {
        answer(ctx, () -> {
            Set<Annotation> annotations = OsrmRequest.annotations(ctx.queryParam("annotations"));
            List<LatLon> points = points(ctx, TABLE_POINTS);
            int[] sources = OsrmRequest.indexes(ctx.queryParam("sources"), "sources", points.size());
            int[] destinations = OsrmRequest.indexes(ctx.queryParam("destinations"), "destinations", points.size());
            RoadRouter router = road.router();
            RoadTable table = router.table(pick(points, sources), pick(points, destinations));

            ObjectNode answer = ok();
            if (annotations.contains(Annotation.DURATION)) {
                answer.set("durations", RoadJson.grid(table.seconds()));
            }
            if (annotations.contains(Annotation.DISTANCE)) {
                answer.set("distances", RoadJson.grid(table.metres()));
            }
            // Where each point meets the roads; a point with no road keeps its own place.
            Snapped[] snapped = new Snapped[points.size()];
            answer.set("sources", waypoints(router, points, sources, snapped));
            answer.set("destinations", waypoints(router, points, destinations, snapped));
            return answer;
        });
    }

    /** {@code GET /nearest/v1/driving/{lon,lat}}: the nearest point on a road; always one, whatever {@code number}. */
    void nearest(Context ctx) {
        answer(ctx, () -> {
            String number = ctx.queryParam("number");
            if (number != null) {
                OsrmRequest.count(number, "number", 1);
            }
            List<LatLon> points = points(ctx, 1);
            Snapped snapped = road.router().nearest(points.getFirst());
            if (!snapped.found()) {
                throw new Refusal("NoSegment", "there is no road a car may use near the point");
            }
            ObjectNode answer = ok();
            answer.putArray("waypoints").add(waypoint(snapped, null).set("nodes",
                    JSON.arrayNode().add(0).add(0)));
            return answer;
        });
    }

    // ---- reading

    /** The points of the path, refusing more than {@code most} (TooBig; for nearest, more than one). */
    private static List<LatLon> points(Context ctx, int most) {
        List<LatLon> points = OsrmRequest.points(ctx.pathParam("coordinates"));
        if (points.size() > most) {
            if (most == 1) {
                throw new Refusal(OsrmRequest.INVALID_OPTIONS, "nearest takes one point, not " + points.size());
            }
            throw new Refusal("TooBig", "at most " + most + " points may be sent here, not " + points.size());
        }
        return points;
    }

    /** {@code overview}: {@code full} or {@code simplified} (both give the whole line) or {@code false}. */
    private static boolean overview(String value) {
        if (value == null || value.equals("full") || value.equals("simplified")) {
            return true;
        }
        if (value.equals("false")) {
            return false;
        }
        throw new Refusal(OsrmRequest.INVALID_OPTIONS, "overview must be full, simplified or false, not '" + value
                + "'");
    }

    private static List<LatLon> pick(List<LatLon> points, int[] indexes) {
        List<LatLon> picked = new ArrayList<>(indexes.length);
        for (int index : indexes) {
            picked.add(points.get(index));
        }
        return picked;
    }

    // ---- answering

    /** Sends what {@code work} builds, or OSRM's 400 with {@code code} and {@code message}. */
    private static void answer(Context ctx, Supplier<ObjectNode> work) {
        try {
            ctx.json(work.get());
        } catch (Refusal refusal) {
            ctx.status(400).json(JSON.objectNode().put("code", refusal.code()).put("message", refusal.getMessage()));
        }
    }

    private static ObjectNode ok() {
        return JSON.objectNode().put("code", "Ok");
    }

    /** One route as OSRM writes it; its weight is its duration. */
    private static ObjectNode route(RoadRoute found, boolean overview) {
        ObjectNode route = JSON.objectNode();
        RoadJson.putRounded(route, "distance", found.metres());
        RoadJson.putRounded(route, "duration", found.seconds());
        RoadJson.putRounded(route, "weight", found.seconds());
        route.put("weight_name", "duration");
        if (overview) {
            route.putObject("geometry").put("type", "LineString").set("coordinates", RoadJson.line(found.path()));
        }
        ArrayNode legs = route.putArray("legs");
        for (RoadRoute.Leg hop : found.legs()) {
            ObjectNode leg = legs.addObject();
            RoadJson.putRounded(leg, "distance", hop.metres());
            RoadJson.putRounded(leg, "duration", hop.seconds());
            leg.put("summary", "").putArray("steps");
        }
        return route;
    }

    /** The table's waypoints for these indexes, snapping each point once (kept in {@code snapped}). */
    private static ArrayNode waypoints(RoadRouter router, List<LatLon> points, int[] indexes, Snapped[] snapped) {
        ArrayNode waypoints = JSON.arrayNode(indexes.length);
        for (int index : indexes) {
            if (snapped[index] == null) {
                snapped[index] = router.nearest(points.get(index));
            }
            waypoints.add(waypoint(snapped[index], points.get(index)));
        }
        return waypoints;
    }

    /**
     * A waypoint: where the point meets the roads, and how far that is from it. With no road
     * nearby, its location is {@code asked} and its distance {@code null}.
     */
    private static ObjectNode waypoint(Snapped snapped, LatLon asked) {
        LatLon at = snapped.found() ? snapped.point() : asked;
        ObjectNode waypoint = JSON.objectNode();
        waypoint.putArray("location").add(sixPlaces(at.lon())).add(sixPlaces(at.lat()));
        waypoint.put("name", "");
        RoadJson.putRounded(waypoint, "distance", snapped.metres());
        return waypoint;
    }

    private static double sixPlaces(double degrees) {
        return Math.round(degrees * 1e6) / 1e6;
    }
}
