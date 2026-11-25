package gtfseditor.router.server;

import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * The service's settings, read from environment variables.
 *
 * @param port          port to listen on
 * @param threads       journeys planned at once on each timetable
 * @param maxTimetables timetables held; loading one more drops the one used longest ago
 * @param data          folder for snapshots and for zips that were fetched or uploaded
 * @param preload       timetables to load at start, by id: the path of each one's zip
 * @param bulkLimit     most journeys in one bulk request
 * @param road          whether road routing is on (decision D15)
 * @param roadGraph     the road graph folder, relative to where the service runs
 * @param roadSnapMetres how far a point may be from a road before it has no road (D19)
 * @param roadTableLimit most source × destination pairs in one road table
 */
public record Settings(int port, int threads, int maxTimetables, Path data, Map<String, Path> preload,
        int bulkLimit, RoadMode road, Path roadGraph, int roadSnapMetres, int roadTableLimit) {

    public static final String PORT_VARIABLE = "ROUTER_PORT";
    public static final String THREADS_VARIABLE = "ROUTER_THREADS";
    public static final String MAX_TIMETABLES_VARIABLE = "ROUTER_MAX_TIMETABLES";
    public static final String DATA_VARIABLE = "ROUTER_DATA";
    public static final String LOAD_VARIABLE = "ROUTER_LOAD";
    public static final String BULK_LIMIT_VARIABLE = "ROUTER_BULK_LIMIT";
    public static final String ROAD_VARIABLE = "ROUTER_ROAD";
    public static final String ROAD_GRAPH_VARIABLE = "ROUTER_ROAD_GRAPH";
    public static final String ROAD_SNAP_METRES_VARIABLE = "ROUTER_ROAD_SNAP_METRES";
    public static final String ROAD_TABLE_LIMIT_VARIABLE = "ROUTER_ROAD_TABLE_LIMIT";

    public static final int DEFAULT_PORT = 3002;
    public static final int DEFAULT_MAX_TIMETABLES = 2;
    public static final String DEFAULT_DATA = "data/router";
    public static final int DEFAULT_BULK_LIMIT = 200_000;
    public static final String DEFAULT_ROAD_GRAPH = "data/router/road/opal";
    public static final int DEFAULT_ROAD_SNAP_METRES = 500;
    public static final int DEFAULT_ROAD_TABLE_LIMIT = 100_000;

    /**
     * Whether road routing is on (decision D15): {@code auto} when the graph folder holds a graph,
     * {@code on} or refuse to start, {@code off}, or {@code only}, roads and health and nothing else.
     */
    public enum RoadMode {
        AUTO, ON, OFF, ONLY;

        /** The name in {@code ROUTER_ROAD} and in health: {@code auto}, {@code on}, {@code off}, {@code only}. */
        public String wireName() {
            return name().toLowerCase(Locale.ROOT);
        }
    }

    public Settings {
        if (port < 0 || port > 65535 || threads < 1 || maxTimetables < 1 || bulkLimit < 1
                || roadSnapMetres < 10 || roadSnapMetres > 5000 || roadTableLimit < 1) {
            throw new IllegalArgumentException("a setting is out of range");
        }
        preload = Map.copyOf(preload);
    }

    /**
     * The defaults, with everything kept under {@code data}, the road graph too (in
     * {@code data/road/opal}). Port 0 means any free port.
     */
    public static Settings defaults(Path data) {
        return new Settings(DEFAULT_PORT, defaultThreads(), DEFAULT_MAX_TIMETABLES, data, Map.of(),
                DEFAULT_BULK_LIMIT, RoadMode.AUTO, data.resolve("road/opal"), DEFAULT_ROAD_SNAP_METRES,
                DEFAULT_ROAD_TABLE_LIMIT);
    }

    public Settings withPort(int number) {
        return new Settings(number, threads, maxTimetables, data, preload, bulkLimit, road, roadGraph,
                roadSnapMetres, roadTableLimit);
    }

    public Settings withMaxTimetables(int number) {
        return new Settings(port, threads, number, data, preload, bulkLimit, road, roadGraph, roadSnapMetres,
                roadTableLimit);
    }

    public Settings withBulkLimit(int number) {
        return new Settings(port, threads, maxTimetables, data, preload, number, road, roadGraph, roadSnapMetres,
                roadTableLimit);
    }

    public Settings withRoad(RoadMode mode, Path graph) {
        return new Settings(port, threads, maxTimetables, data, preload, bulkLimit, mode, graph, roadSnapMetres,
                roadTableLimit);
    }

    public Settings withRoadTableLimit(int pairs) {
        return new Settings(port, threads, maxTimetables, data, preload, bulkLimit, road, roadGraph, roadSnapMetres,
                pairs);
    }

    /** Where timetable snapshots are kept. */
    public Path snapshots() {
        return data.resolve("snapshots");
    }

    /** Where simulation runs keep their files, a folder for each. */
    public Path sims() {
        return data.resolve("sim");
    }

    /** Where fetched and uploaded zips are kept. */
    public Path zips() {
        return data.resolve("zips");
    }

    /**
     * Reads the settings.
     *
     * @throws IllegalArgumentException if a value cannot be read, naming the variable
     */
    public static Settings from(Map<String, String> env) {
        String data = env.get(DATA_VARIABLE);
        String roadGraph = env.get(ROAD_GRAPH_VARIABLE);
        return new Settings(
                number(env, PORT_VARIABLE, DEFAULT_PORT, 1, 65535),
                number(env, THREADS_VARIABLE, defaultThreads(), 1, 256),
                number(env, MAX_TIMETABLES_VARIABLE, DEFAULT_MAX_TIMETABLES, 1, 16),
                Path.of(data == null || data.isBlank() ? DEFAULT_DATA : data.strip()),
                preload(env.get(LOAD_VARIABLE)),
                number(env, BULK_LIMIT_VARIABLE, DEFAULT_BULK_LIMIT, 1, 10_000_000),
                roadMode(env.get(ROAD_VARIABLE)),
                Path.of(roadGraph == null || roadGraph.isBlank() ? DEFAULT_ROAD_GRAPH : roadGraph.strip()),
                number(env, ROAD_SNAP_METRES_VARIABLE, DEFAULT_ROAD_SNAP_METRES, 10, 5000),
                number(env, ROAD_TABLE_LIMIT_VARIABLE, DEFAULT_ROAD_TABLE_LIMIT, 1, 100_000_000));
    }

    /** Reads {@code ROUTER_ROAD}: auto (the default), on, off or only, in any case. */
    static RoadMode roadMode(String value) {
        if (value == null || value.isBlank()) {
            return RoadMode.AUTO;
        }
        for (RoadMode mode : RoadMode.values()) {
            if (mode.wireName().equals(value.strip().toLowerCase(Locale.ROOT))) {
                return mode;
            }
        }
        throw new IllegalArgumentException(ROAD_VARIABLE + " must be auto, on, off or only, not '" + value + "'");
    }

    /** The processor's threads less two, as section 9 of the plan says, and at least one. */
    static int defaultThreads() {
        return Math.max(1, Runtime.getRuntime().availableProcessors() - 2);
    }

    static int number(Map<String, String> env, String name, int otherwise, int least, int most) {
        String value = env.get(name);
        if (value == null || value.isBlank()) {
            return otherwise;
        }
        int number;
        try {
            number = Integer.parseInt(value.strip());
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException(name + " is not a number: '" + value + "'", e);
        }
        if (number < least || number > most) {
            throw new IllegalArgumentException(name + " must be from " + least + " to " + most + ", not " + number);
        }
        return number;
    }

    /** Reads {@code id=path}, or several separated by semicolons. */
    static Map<String, Path> preload(String value) {
        Map<String, Path> preload = new LinkedHashMap<>();
        if (value == null || value.isBlank()) {
            return preload;
        }
        for (String part : value.split(";")) {
            int equals = part.indexOf('=');
            if (equals < 1 || equals == part.length() - 1 || !Timetables.isId(part.substring(0, equals).strip())) {
                throw new IllegalArgumentException(
                        LOAD_VARIABLE + " must look like id=path, or several separated by ';', not '" + value + "'");
            }
            preload.put(part.substring(0, equals).strip(), Path.of(part.substring(equals + 1).strip()));
        }
        return preload;
    }
}
