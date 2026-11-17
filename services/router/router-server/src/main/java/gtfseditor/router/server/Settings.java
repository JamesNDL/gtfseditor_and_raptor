package gtfseditor.router.server;

import java.nio.file.Path;
import java.util.LinkedHashMap;
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
 */
public record Settings(int port, int threads, int maxTimetables, Path data, Map<String, Path> preload,
        int bulkLimit) {

    public static final String PORT_VARIABLE = "ROUTER_PORT";
    public static final String THREADS_VARIABLE = "ROUTER_THREADS";
    public static final String MAX_TIMETABLES_VARIABLE = "ROUTER_MAX_TIMETABLES";
    public static final String DATA_VARIABLE = "ROUTER_DATA";
    public static final String LOAD_VARIABLE = "ROUTER_LOAD";
    public static final String BULK_LIMIT_VARIABLE = "ROUTER_BULK_LIMIT";

    public static final int DEFAULT_PORT = 3002;
    public static final int DEFAULT_MAX_TIMETABLES = 2;
    public static final String DEFAULT_DATA = "data/router";
    public static final int DEFAULT_BULK_LIMIT = 200_000;

    public Settings {
        if (port < 0 || port > 65535 || threads < 1 || maxTimetables < 1 || bulkLimit < 1) {
            throw new IllegalArgumentException("a setting is out of range");
        }
        preload = Map.copyOf(preload);
    }

    /** The defaults, with everything kept under {@code data}. Port 0 means any free port. */
    public static Settings defaults(Path data) {
        return new Settings(DEFAULT_PORT, defaultThreads(), DEFAULT_MAX_TIMETABLES, data, Map.of(),
                DEFAULT_BULK_LIMIT);
    }

    public Settings withPort(int number) {
        return new Settings(number, threads, maxTimetables, data, preload, bulkLimit);
    }

    public Settings withMaxTimetables(int number) {
        return new Settings(port, threads, number, data, preload, bulkLimit);
    }

    public Settings withBulkLimit(int number) {
        return new Settings(port, threads, maxTimetables, data, preload, number);
    }

    /** Where timetable snapshots are kept. */
    public Path snapshots() {
        return data.resolve("snapshots");
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
        return new Settings(
                number(env, PORT_VARIABLE, DEFAULT_PORT, 1, 65535),
                number(env, THREADS_VARIABLE, defaultThreads(), 1, 256),
                number(env, MAX_TIMETABLES_VARIABLE, DEFAULT_MAX_TIMETABLES, 1, 16),
                Path.of(data == null || data.isBlank() ? DEFAULT_DATA : data.strip()),
                preload(env.get(LOAD_VARIABLE)),
                number(env, BULK_LIMIT_VARIABLE, DEFAULT_BULK_LIMIT, 1, 10_000_000));
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
