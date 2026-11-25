package gtfseditor.router.server;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import gtfseditor.router.road.GraphHopperRoads;
import gtfseditor.router.road.LatLon;
import gtfseditor.router.road.RoadGraphBuilder;
import gtfseditor.router.road.RoadRoute;
import gtfseditor.router.road.RoadRouter;
import gtfseditor.router.road.RoadSettings;
import gtfseditor.router.road.RoadTable;
import gtfseditor.router.road.Snapped;
import io.javalin.config.RoutesConfig;
import io.javalin.http.Context;
import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * The road side of the service (architecture §3.2 and §3.3; FR-1, FR-2): {@code POST
 * /v1/road/route} and {@code POST /v1/road/table}, road routing's part of health, and, when the
 * service runs roads only, the 503 for everything else. Whether road routing is on comes from
 * {@code ROUTER_ROAD} (decision D15). Times and distances are free-flow, for cars only.
 */
final class RoadApi implements AutoCloseable {

    /** What every timetable, journey, load, demand and simulation endpoint answers in road-only mode. */
    static final String ROADS_ONLY = "this router runs roads only";

    private static final JsonNodeFactory JSON = JsonNodeFactory.instance;

    private final Settings.RoadMode mode;
    private final Path graph;
    private final int tableLimit;
    private final int snapMetres;
    private final ObjectMapper mapper;
    /** The road router, or null when road routing is off. */
    private final GraphHopperRoads roads;
    /** What {@code road-graph.json} says: the file it was built from and when; null when off. */
    private final JsonNode info;

    private RoadApi(Settings settings, ObjectMapper mapper, GraphHopperRoads roads, JsonNode info) {
        this.mode = settings.road();
        this.graph = settings.roadGraph();
        this.tableLimit = settings.roadTableLimit();
        this.snapMetres = settings.roadSnapMetres();
        this.mapper = mapper;
        this.roads = roads;
        this.info = info;
    }

    /**
     * Opens the road graph if the settings ask for it. {@code auto} without a graph is off, with
     * one line saying so.
     *
     * @throws IllegalStateException if road routing must be on ({@code on} or {@code only}) and
     *     there is no graph, or the graph cannot be opened; the service must not start
     */
    static RoadApi open(Settings settings, ObjectMapper mapper) {
        Path graph = settings.roadGraph();
        boolean present = RoadGraphBuilder.isGraphFolder(graph);
        if (settings.road() == Settings.RoadMode.OFF || (settings.road() == Settings.RoadMode.AUTO && !present)) {
            if (settings.road() == Settings.RoadMode.AUTO) {
                System.out.println("Road routing is off: there is no road graph in " + graph);
            }
            return new RoadApi(settings, mapper, null, null);
        }
        if (!present) {
            throw new IllegalStateException(Settings.ROAD_VARIABLE + "=" + settings.road().wireName()
                    + " needs a road graph, but there is none in " + graph + " (it has no " + RoadGraphBuilder.INFO_FILE
                    + "). Build one with npm run road:data, or set " + Settings.ROAD_VARIABLE + " to auto or off.");
        }
        JsonNode info;
        try {
            info = mapper.readTree(graph.resolve(RoadGraphBuilder.INFO_FILE).toFile());
        } catch (IOException e) {
            throw new IllegalStateException("Could not read " + graph.resolve(RoadGraphBuilder.INFO_FILE) + ": "
                    + e.getMessage(), e);
        }
        GraphHopperRoads roads = GraphHopperRoads.open(new RoadSettings(graph, settings.roadSnapMetres(),
                settings.threads()));
        return new RoadApi(settings, mapper, roads, info);
    }

    /** Adds the road endpoints, and in road-only mode turns every other {@code /v1/} endpoint away. */
    void register(RoutesConfig routes) {
        routes.post("/v1/road/route", this::route);
        routes.post("/v1/road/table", this::table);
        if (mode == Settings.RoadMode.ONLY) {
            routes.before(ctx -> {
                String path = ctx.path();
                if (path.startsWith("/v1/") && !path.equals("/v1/health") && !path.startsWith("/v1/road/")) {
                    throw new ApiException(503, ROADS_ONLY);
                }
            });
        }
    }

    /** Road routing's part of {@code GET /v1/health}. */
    ObjectNode health() {
        ObjectNode road = JSON.objectNode().put("available", roads != null).put("graph", graph.toString());
        if (info != null) {
            road.put("builtFrom", info.path("sourceFile").asText()).put("builtAt", info.path("builtAt").asText());
        }
        return road.put("mode", mode.wireName());
    }

    /**
     * The road router, for the OSRM-shaped endpoints ({@link OsrmApi}) as well as these.
     *
     * @throws ApiException 503 when road routing is off
     */
    RoadRouter router() {
        if (roads == null) {
            throw new ApiException(503, "road routing is off on this router (" + Settings.ROAD_VARIABLE + " is "
                    + mode.wireName() + ", road graph " + graph + ")");
        }
        return roads;
    }

    @Override
    public void close() {
        if (roads != null) {
            roads.close();
        }
    }

    // ---- the endpoints

    /** {@code POST /v1/road/route}: one drive from {@code from} to {@code to}, through any {@code via}. */
    private void route(Context ctx) throws IOException {
        JsonNode body = request(ctx);
        List<LatLon> points = new ArrayList<>();
        points.add(RoadJson.point(body.get("from"), "from"));
        JsonNode via = body.get("via");
        if (via != null && !via.isNull()) {
            points.addAll(RoadJson.points(via, "via", true));
        }
        points.add(RoadJson.point(body.get("to"), "to"));
        long started = System.nanoTime();
        RoadRoute route = roads.route(points, false);
        long micros = (System.nanoTime() - started) / 1000;

        boolean ok = route.status() == RoadRoute.Status.OK;
        ObjectNode answer = JSON.objectNode().put("status", RoadJson.status(route.status()))
                .put("profile", RoadJson.CAR).put("freeFlow", true);
        RoadJson.putRounded(answer, "metres", ok ? route.metres() : Double.NaN);
        RoadJson.putRounded(answer, "durationSecs", ok ? route.seconds() : Double.NaN);
        answer.set("geometry", RoadJson.line(route.path()));
        ObjectNode snap = answer.putObject("snapMetres");
        RoadJson.putRounded(snap, "from", route.snapped().getFirst().metres());
        RoadJson.putRounded(snap, "to", route.snapped().getLast().metres());
        answer.put("computeMicros", micros);
        if (!ok) {
            answer.put("reason", reason(route));
        }
        ctx.json(answer);
    }

    /** {@code POST /v1/road/table}: drives for every pair of sources and destinations; rows are sources. */
    private void table(Context ctx) throws IOException {
        JsonNode body = request(ctx);
        List<LatLon> sources = RoadJson.points(body.get("sources"), "sources", false);
        List<LatLon> destinations = RoadJson.points(body.get("destinations"), "destinations", false);
        long pairs = (long) sources.size() * destinations.size();
        if (pairs > tableLimit) {
            throw ApiException.bad("a road table may hold at most " + tableLimit + " pairs of sources and"
                    + " destinations, not " + pairs + "; send the rest in another");
        }
        long started = System.nanoTime();
        RoadTable table = roads.table(sources, destinations);
        long micros = (System.nanoTime() - started) / 1000;

        ObjectNode answer = JSON.objectNode().put("profile", RoadJson.CAR).put("freeFlow", true);
        answer.set("durationsSecs", RoadJson.grid(table.seconds()));
        answer.set("metres", RoadJson.grid(table.metres()));
        answer.set("sourceSnapMetres", RoadJson.row(table.sourceSnapMetres()));
        answer.set("destinationSnapMetres", RoadJson.row(table.destinationSnapMetres()));
        ctx.json(answer.put("computeMicros", micros));
    }

    /**
     * Reads a road request: road routing must be on, the body a JSON object, and the profile car
     * (or left out).
     */
    private JsonNode request(Context ctx) throws IOException {
        router();
        JsonNode body = mapper.readTree(ctx.body());
        if (body == null || !body.isObject()) {
            throw ApiException.bad("the request must be a JSON object");
        }
        RoadJson.checkProfile(body.get("profile"));
        return body;
    }

    /** Why there is no drive. For no road, which end it is: the start, the end, or a via point. */
    private String reason(RoadRoute route) {
        if (route.status() != RoadRoute.Status.NO_ROAD) {
            return route.reason();
        }
        List<Snapped> snapped = route.snapped();
        int missing = 0;
        while (missing < snapped.size() - 1 && snapped.get(missing).found()) {
            missing++;
        }
        String which = missing == 0 ? "the start" : missing == snapped.size() - 1 ? "the end"
                : "via point " + missing;
        return which + " is more than " + snapMetres + " m from a road a car may use";
    }
}
