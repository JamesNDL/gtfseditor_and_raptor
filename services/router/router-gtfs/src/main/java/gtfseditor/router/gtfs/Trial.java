package gtfseditor.router.gtfs;

import gtfseditor.router.core.Journey;
import gtfseditor.router.core.Geo;
import gtfseditor.router.core.JourneyChecker;
import gtfseditor.router.core.Leg;
import gtfseditor.router.core.Mode;
import gtfseditor.router.core.Place;
import gtfseditor.router.core.Query;
import gtfseditor.router.core.Result;
import gtfseditor.router.core.Router;
import gtfseditor.router.core.Timetable;
import java.io.IOException;
import java.io.PrintStream;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.Random;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * A repeatable set of test journeys and a rough measure of how the router does on them. Used by
 * {@code RouteCli --random}. It is not the benchmark of section 10.2 of the plan, but it draws its
 * journeys the way that section asks: between stops chosen in proportion to how much service they
 * have, at times of day weighted towards the two peaks.
 */
final class Trial {

    /** A rectangle on the map. */
    record Area(String name, double south, double north, double west, double east) {
        boolean holds(double lat, double lon) {
            return lat >= south && lat <= north && lon >= west && lon <= east;
        }
    }

    /**
     * Roughly where an Opal card works: the Hunter and Newcastle in the north, Sydney, the Blue
     * Mountains in the west, Wollongong and Kiama in the south. Test journeys stay inside it.
     */
    static final Area OPAL = new Area("opal", -34.75, -32.70, 150.10, 151.85);

    private Trial() {}

    static Area area(String name) {
        return switch (name) {
            case "opal" -> OPAL;
            case "all" -> new Area("all", -90, 90, -180, 180);
            default -> throw new IllegalArgumentException("unknown area '" + name + "'; use opal or all");
        };
    }

    /** The two ends and the time of one test journey. */
    record Case(int from, int to, int depart) {}

    /**
     * Draws test journeys. Each end is a stop inside the area, picked in proportion to the number
     * of times a vehicle calls there in the day. 30% leave between 06:30 and 09:30, 30% between
     * 15:30 and 18:30, and the rest at any time from 05:00 to 22:00.
     *
     * @param withinKm if above 0, the two ends are no further apart than this in a straight line,
     *                 which is closer to the trips people make than any two stops in the area
     */
    static Case[] cases(Timetable t, Area area, int count, long seed, double withinKm) {
        int[] stops = new int[t.stopCount()];
        long[] upTo = new long[t.stopCount()];
        int eligible = 0;
        long total = 0;
        for (int stop = 0; stop < t.stopCount(); stop++) {
            if (!area.holds(t.stopLat[stop], t.stopLon[stop])) {
                continue;
            }
            long calls = 0;
            for (int j = t.stopPatternOffset[stop]; j < t.stopPatternOffset[stop + 1]; j++) {
                calls += t.patternTripCount(t.stopPatterns[j]);
            }
            total += calls;
            stops[eligible] = stop;
            upTo[eligible] = total;
            eligible++;
        }
        if (total == 0) {
            throw new IllegalArgumentException("no stop of this timetable is inside the " + area.name() + " area");
        }
        Random random = new Random(seed);
        Case[] cases = new Case[count];
        for (int i = 0; i < count; i++) {
            int from = pick(random, stops, upTo, eligible, total);
            int to = pick(random, stops, upTo, eligible, total);
            while (to == from || (withinKm > 0 && Geo.metresBetween(t.stopLat[from], t.stopLon[from],
                    t.stopLat[to], t.stopLon[to]) > withinKm * 1000)) {
                to = pick(random, stops, upTo, eligible, total);
            }
            int kind = random.nextInt(10);
            int depart = kind < 3 ? 6 * 3600 + 1800 + random.nextInt(3 * 3600)
                    : kind < 6 ? 15 * 3600 + 1800 + random.nextInt(3 * 3600)
                    : 5 * 3600 + random.nextInt(17 * 3600);
            cases[i] = new Case(from, to, depart - depart % 60); // people ask in whole minutes
        }
        return cases;
    }

    private static int pick(Random random, int[] stops, long[] upTo, int eligible, long total) {
        long wanted = (long) (random.nextDouble() * total);
        int low = 0;
        int high = eligible - 1;
        while (low < high) {
            int middle = (low + high) >>> 1;
            if (upTo[middle] > wanted) {
                high = middle;
            } else {
                low = middle + 1;
            }
        }
        return stops[low];
    }

    /**
     * Plans every case, replays each answer against the timetable, and reports how many had an
     * answer and how long they took: one at a time first, then on several threads at once.
     *
     * @param show print this many of the journeys in full, for reading
     */
    static void run(PrintStream out, Router router, Area area, int count, long seed, double walk, int threads,
            int show, double withinKm, Set<Mode> avoid) throws InterruptedException {
        Timetable t = router.timetable();
        Case[] cases = cases(t, area, count, seed, withinKm);
        Query[] queries = new Query[count];
        for (int i = 0; i < count; i++) {
            queries[i] = router.query(new Place.Stop(cases[i].from()), new Place.Stop(cases[i].to()),
                    cases[i].depart(), router.maxRides(), walk).avoiding(avoid);
        }
        for (int i = 0; i < Math.min(count, 1000); i++) {
            router.route(queries[i]); // warm-up
        }

        long[] nanos = new long[count];
        int answered = 0;
        int wrong = 0;
        long rides = 0;
        long journeys = 0;
        long patterns = 0;
        long minutes = 0;
        long bestRides = 0;
        long waiting = 0;
        long leaveLater = 0;
        int notFastest = 0;
        int alternatives = 0;
        int schoolBus = 0;
        String firstProblem = null;
        StringBuilder unanswered = new StringBuilder();
        for (int i = 0; i < count; i++) {
            Result result = router.route(queries[i]);
            nanos[i] = result.computeNanos();
            patterns += result.patternsScanned();
            if (result.journeys().isEmpty()) {
                if (unanswered.length() < 600) {
                    unanswered.append(String.format("%n      %s to %s at %s", t.stopIds[cases[i].from()],
                            t.stopIds[cases[i].to()], RouteCli.clock(cases[i].depart())));
                }
            } else {
                answered++;
                Journey best = result.best();
                minutes += best.arrive() - cases[i].depart();
                bestRides += best.rides();
                waiting += best.waitSecs();
                leaveLater += best.depart() - cases[i].depart();
                notFastest += result.recommended() == 0 ? 0 : 1;
                alternatives += result.journeys().size() - 1;
                schoolBus += best.legs().stream().anyMatch(leg -> leg.kind() == Leg.Kind.RIDE
                        && t.tripMode(leg.trip()) == Mode.SCHOOL_BUS) ? 1 : 0;
            }
            for (Journey j : result.journeys()) {
                journeys++;
                rides += j.rides();
                String problem = JourneyChecker.problem(t, queries[i], j);
                if (problem != null) {
                    wrong++;
                    firstProblem = firstProblem == null ? problem + ": " + queries[i] : firstProblem;
                }
            }
            if (i < show) {
                RouteCli.print(out, t, queries[i], result,
                        RouteCli.describe(t, new Place.Stop(cases[i].from())),
                        RouteCli.describe(t, new Place.Stop(cases[i].to())));
                out.println("----------------------------------------");
            }
        }
        // Other programs share the machine, so each query is timed three more times and its quickest
        // run kept.
        for (int pass = 0; pass < 3; pass++) {
            for (int i = 0; i < count; i++) {
                nanos[i] = Math.min(nanos[i], router.route(queries[i]).computeNanos());
            }
        }
        Arrays.sort(nanos);
        long total = Arrays.stream(nanos).sum();

        out.printf("%,d journeys between stops in the %s area, chosen by how busy the stops are%n", count,
                area.name());
        out.printf("up to %d rides, seed %d%s%s%n", router.maxRides(), seed,
                withinKm > 0 ? ", ends within " + withinKm + " km" : "", avoid.isEmpty() ? "" : ", avoiding " + avoid);
        out.printf("  with an answer       %,d (%.1f%%)%n", answered, 100.0 * answered / count);
        out.printf("  journeys returned    %,d, %.1f rides each on average%n", journeys,
                journeys == 0 ? 0 : (double) rides / journeys);
        if (answered > 0) {
            out.println("the recommended journey, on average");
            out.printf("  asked time to arrival %,d min%n", minutes / answered / 60);
            out.printf("  can leave later by    %,d min%n", leaveLater / answered / 60);
            out.printf("  waiting on the way    %.1f min%n", waiting / 60.0 / answered);
            out.printf("  rides                 %.2f%n", (double) bestRides / answered);
            out.printf("  is not the fastest    %.1f%% of the time%n", 100.0 * notFastest / answered);
            out.printf("  uses a school bus     %.1f%% of the time%n", 100.0 * schoolBus / answered);
            out.printf("  alternatives offered  %.2f%n", (double) alternatives / answered);
        }
        out.printf("  failed the replay    %,d%s%n", wrong, firstProblem == null ? "" : "  first: " + firstProblem);
        out.printf("  patterns scanned     %,d each on average, of %,d%n", patterns / count, t.patternCount());
        out.println("one thread, the quickest of four runs of each journey");
        out.printf("  median               %.2f ms%n", nanos[count / 2] / 1e6);
        out.printf("  95th percentile      %.2f ms%n", nanos[(int) (count * 0.95)] / 1e6);
        out.printf("  99th percentile      %.2f ms%n", nanos[(int) (count * 0.99)] / 1e6);
        out.printf("  slowest              %.2f ms%n", nanos[count - 1] / 1e6);
        out.printf("  per second           %,.0f%n", count / (total / 1e9));
        if (threads > 1) {
            out.printf("%d threads%n  per second           %,.0f%n", threads, perSecond(router, queries, threads));
        }
        if (!unanswered.isEmpty()) {
            out.println("  some with no answer:" + unanswered);
        }
    }

    /**
     * Plans every case and writes it with its journeys to a file, one case to a line as JSON, for
     * comparing with another planner. See {@code tools/compare-tfnsw.mjs}. A second file beside it,
     * ending {@code .trips}, lists the id of every trip of the timetable, so that the comparison can
     * tell a trip this timetable lacks from one the router chose not to use.
     */
    static void dump(PrintStream out, Router router, Area area, int count, long seed, double walk, double withinKm,
            Set<Mode> avoid, Path file) throws IOException {
        Timetable t = router.timetable();
        Case[] cases = cases(t, area, count, seed, withinKm);
        try (Writer w = Files.newBufferedWriter(file, StandardCharsets.UTF_8)) {
            for (Case c : cases) {
                // From and to the stops' positions on the map, not the stops themselves: asked for a
                // stop, the TfNSW planner boards only there, and the two planners stop being comparable.
                Query query = router.query(new Place.Point(t.stopLat[c.from()], t.stopLon[c.from()]),
                        new Place.Point(t.stopLat[c.to()], t.stopLon[c.to()]), c.depart(), router.maxRides(), walk)
                        .avoiding(avoid);
                Result result = router.route(query);
                StringBuilder line = new StringBuilder(2048);
                line.append("{\"from\":").append(stop(t, c.from())).append(",\"to\":").append(stop(t, c.to()))
                        .append(",\"depart\":").append(c.depart())
                        .append(",\"recommended\":").append(result.recommended()).append(",\"journeys\":[");
                for (int j = 0; j < result.journeys().size(); j++) {
                    Journey journey = result.journeys().get(j);
                    line.append(j == 0 ? "" : ",").append("{\"label\":").append(quoted(journey.label()))
                            .append(",\"depart\":").append(journey.depart())
                            .append(",\"arrive\":").append(journey.arrive())
                            .append(",\"rides\":").append(journey.rides())
                            .append(",\"changes\":").append(journey.changes())
                            .append(",\"walkSecs\":").append(journey.walkSecs()).append(",\"legs\":[");
                    for (int k = 0; k < journey.legs().size(); k++) {
                        Leg leg = journey.legs().get(k);
                        line.append(k == 0 ? "" : ",").append("{\"kind\":\"").append(leg.kind())
                                .append("\",\"from\":").append(leg.fromStop() < 0 ? "null" : stop(t, leg.fromStop()))
                                .append(",\"to\":").append(leg.toStop() < 0 ? "null" : stop(t, leg.toStop()))
                                .append(",\"depart\":").append(leg.depart())
                                .append(",\"arrive\":").append(leg.arrive())
                                .append(",\"metres\":").append(leg.metres());
                        if (leg.kind() == Leg.Kind.RIDE) {
                            line.append(",\"trip\":").append(quoted(t.tripIds[leg.trip()]))
                                    .append(",\"route\":").append(quoted(t.routeNames[t.tripRoute[leg.trip()]]))
                                    .append(",\"mode\":").append(quoted(t.tripMode(leg.trip()).wireName()))
                                    .append(",\"stayAboard\":").append(leg.stayAboard());
                        }
                        line.append('}');
                    }
                    line.append("]}");
                }
                w.write(line.append("]}\n").toString());
            }
        }
        Path trips = file.resolveSibling(file.getFileName() + ".trips");
        Files.write(trips, Arrays.asList(t.tripIds), StandardCharsets.UTF_8);
        out.printf("Wrote %,d test journeys to %s and %,d trip ids to %s%n", count, file.toAbsolutePath(),
                t.tripCount(), trips.toAbsolutePath());
    }

    private static String stop(Timetable t, int stop) {
        return "{\"id\":" + quoted(t.stopIds[stop]) + ",\"name\":" + quoted(t.stopNames[stop]) + ",\"lat\":"
                + t.stopLat[stop] + ",\"lon\":" + t.stopLon[stop] + "}";
    }

    /** A string as JSON writes it. */
    private static String quoted(String text) {
        StringBuilder b = new StringBuilder(text.length() + 2).append('"');
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c == '"' || c == '\\') {
                b.append('\\').append(c);
            } else if (c < ' ') {
                b.append(String.format("\\u%04x", (int) c));
            } else {
                b.append(c);
            }
        }
        return b.append('"').toString();
    }

    /** Runs every query three times over, shared out between the threads, and times the lot. */
    private static double perSecond(Router router, Query[] queries, int threads) throws InterruptedException {
        int passes = 3;
        AtomicInteger next = new AtomicInteger();
        Thread[] workers = new Thread[threads];
        long started = System.nanoTime();
        for (int i = 0; i < threads; i++) {
            workers[i] = new Thread(() -> {
                for (int at = next.getAndIncrement(); at < queries.length * passes; at = next.getAndIncrement()) {
                    router.route(queries[at % queries.length]);
                }
            });
            workers[i].start();
        }
        for (Thread worker : workers) {
            worker.join();
        }
        return queries.length * passes / ((System.nanoTime() - started) / 1e9);
    }
}
