package gtfseditor.router.gtfs;

import gtfseditor.router.core.ArriveBy;
import gtfseditor.router.core.Journey;
import gtfseditor.router.core.JourneyChecker;
import gtfseditor.router.core.Leg;
import gtfseditor.router.core.Mode;
import gtfseditor.router.core.Place;
import gtfseditor.router.core.Preferences;
import gtfseditor.router.core.Query;
import gtfseditor.router.core.Result;
import gtfseditor.router.core.Router;
import gtfseditor.router.core.Timetable;
import java.io.PrintStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.EnumSet;
import java.util.Locale;
import java.util.Set;

/**
 * Plans journeys from the command line.
 *
 * <pre>
 * RouteCli &lt;feed.zip&gt; &lt;from&gt; &lt;to&gt; &lt;time&gt; [--date 20261117] [--snapshots &lt;folder&gt;] [--rides 8] [--walk 1200]
 *          [--avoid school_bus,ferry] [--change 120] [--water &lt;file&gt;] [--arrive-by]
 * RouteCli &lt;feed.zip&gt; --random 2000 [--area opal|all] [--within 25] [--threads 8] [--show 5] [--seed 1] [...]
 * RouteCli &lt;feed.zip&gt; --random 300 --dump &lt;file&gt; [...]
 * </pre>
 *
 * School buses are left out unless {@code --avoid} says otherwise; {@code --avoid none} leaves
 * nothing out. {@code --change} is the least time, in seconds, to change vehicles at one stop.
 * {@code --arrive-by} takes the time as the time to arrive by, and plans the journey that leaves
 * latest and still arrives then.
 *
 * <p>A place is a stop id, a station id, or {@code latitude,longitude}. A time is {@code HH:MM} or
 * {@code HH:MM:SS}; after midnight on the same service day, keep counting: {@code 24:30}.
 *
 * <p>{@code --random} plans that many test journeys inside the Opal area (Newcastle, Sydney,
 * Wollongong), checks every answer against the timetable, and reports how many had an answer and
 * how long they took. See {@link Trial}. With {@code --dump} it writes the journeys to a file
 * instead, for comparing with another planner.
 */
public final class RouteCli {

    private RouteCli() {}

    public static void main(String[] args) throws Exception {
        Path snapshots = null;
        LoadOptions options = LoadOptions.defaults();
        int rides = Router.DEFAULT_MAX_RIDES;
        double walk = Router.DEFAULT_MAX_WALK_METRES;
        int random = 0;
        long seed = 1;
        String area = "opal";
        int threads = Math.max(1, Runtime.getRuntime().availableProcessors() - 2);
        int show = 0;
        double within = 0;
        Path dump = null;
        boolean arriveBy = false;
        int change = gtfseditor.router.core.Query.DEFAULT_CHANGE_SECS;
        Set<Mode> avoid = EnumSet.copyOf(Router.DEFAULT_AVOID);
        String[] plain = new String[4];
        int plainCount = 0;
        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--date" -> options = options.withServiceDate(Integer.parseInt(value(args, ++i)));
                case "--snapshots" -> snapshots = Path.of(value(args, ++i));
                case "--water" -> options = options.withWater(WaterFile.read(Path.of(value(args, ++i))));
                case "--rides" -> rides = Integer.parseInt(value(args, ++i));
                case "--walk" -> walk = Double.parseDouble(value(args, ++i));
                case "--random" -> random = Integer.parseInt(value(args, ++i));
                case "--seed" -> seed = Long.parseLong(value(args, ++i));
                case "--area" -> area = value(args, ++i);
                case "--threads" -> threads = Integer.parseInt(value(args, ++i));
                case "--show" -> show = Integer.parseInt(value(args, ++i));
                case "--change" -> change = Integer.parseInt(value(args, ++i));
                case "--dump" -> dump = Path.of(value(args, ++i));
                case "--arrive-by" -> arriveBy = true;
                case "--within" -> within = Double.parseDouble(value(args, ++i));
                case "--avoid" -> {
                    avoid.clear(); // "--avoid none" leaves nothing out, school buses included
                    for (String name : value(args, ++i).split(",")) {
                        if (!name.strip().equalsIgnoreCase("none")) {
                            avoid.add(Mode.valueOf(name.strip().toUpperCase(Locale.ROOT)));
                        }
                    }
                }
                default -> {
                    // A place may be "-33.9,151.2", so only a double dash marks an option.
                    if (args[i].startsWith("--") || plainCount == plain.length) {
                        usage("did not understand '" + args[i] + "'");
                    }
                    plain[plainCount++] = args[i];
                }
            }
        }
        if (plainCount != (random > 0 ? 1 : 4)) {
            usage(random > 0 ? "with --random, name only the zip" : "name the zip, two places and a time");
        }
        Path zip = Path.of(plain[0]);
        if (!Files.isRegularFile(zip)) {
            usage("there is no file " + zip.toAbsolutePath());
        }

        Timetable t;
        try {
            t = snapshots == null ? GtfsLoader.load(zip, options)
                    : TimetableCache.load(zip, options, snapshots).timetable();
        } catch (GtfsException e) {
            System.err.println("Could not load " + zip + ": " + e.getMessage());
            System.exit(1);
            return;
        }
        Router router = new Router(t, rides, change);
        if (random > 0 && dump != null) {
            Trial.dump(System.out, router, Trial.area(area), random, seed, walk, within, avoid, dump);
            return;
        }
        if (random > 0) {
            Trial.run(System.out, router, Trial.area(area), random, seed, walk, threads, show, within, avoid);
            return;
        }

        Place from = place(t, plain[1]);
        Place to = place(t, plain[2]);
        int depart = time(plain[3]);
        Query query = router.query(from, to, depart, rides, walk).avoiding(avoid);
        if (arriveBy) {
            ArriveBy.route(router, query, depart, Preferences.defaults()); // to warm up, as below
            Result result = ArriveBy.route(router, query, depart, Preferences.defaults());
            Journey best = result.best();
            System.out.printf("Arriving by %s: %s%n", clock(depart), best == null ? "no journey arrives in time"
                    : "leave at " + clock(best.depart()) + ", early wait " + minutes(depart - best.arrive()));
            print(System.out, t, best == null ? query : query.departingAt(best.depart()), result, describe(t, from),
                    describe(t, to));
            return;
        }
        router.route(query); // once to warm up, so the time printed is not mostly start-up
        Result result = router.route(query);
        print(System.out, t, query, result, describe(t, from), describe(t, to));
    }

    static void print(PrintStream out, Timetable t, Query query, Result result, String from, String to) {
        out.printf("From %s%n  to %s%nat or after %s%s%n%n", from, to, clock(query.depart()),
                query.avoid().isEmpty() ? "" : ", avoiding " + query.avoid());
        if (result.journeys().isEmpty()) {
            out.println(query.access().isEmpty() || query.egress().isEmpty()
                    ? "No journey: there is no stop within walking distance of one end."
                    : "No journey: nothing gets there on this service day after that time.");
        }
        for (Journey j : result.journeys()) {
            out.printf("%s%s: leave %s, arrive %s, %s, %d %s, %d %s, %s walking, %s waiting%n", j.label(),
                    j == result.best() && result.journeys().size() > 1 ? " (recommended)" : "",
                    clock(j.depart()), clock(j.arrive()), minutes(j.durationSecs()), j.rides(), j.rides() == 1 ? "ride" : "rides",
                    j.changes(), j.changes() == 1 ? "change" : "changes", minutes(j.walkSecs()),
                    minutes(j.waitSecs()));
            for (Leg leg : j.legs()) {
                String ends = clock(leg.depart()) + " to " + clock(leg.arrive());
                switch (leg.kind()) {
                    case RIDE -> out.printf("    %s  %s%s %s to %s: %s to %s  [trip %s]%n", ends,
                            leg.stayAboard() ? "stay aboard, " : "", t.tripMode(leg.trip()).wireName(),
                            t.routeNames[t.tripRoute[leg.trip()]], t.tripHeadsigns[leg.trip()],
                            t.stopNames[leg.fromStop()], t.stopNames[leg.toStop()], t.tripIds[leg.trip()]);
                    case TRANSFER -> out.printf("    %s  walk %d m to %s%n", ends, leg.metres(),
                            t.stopNames[leg.toStop()]);
                    case WALK -> out.printf("    %s  walk %d m %s%n", ends, leg.metres(),
                            leg.toStop() >= 0 ? "to " + t.stopNames[leg.toStop()] : "to the destination");
                }
            }
            String problem = JourneyChecker.problem(t, query, j);
            if (problem != null) {
                out.println("    THIS JOURNEY DOES NOT REPLAY AGAINST THE TIMETABLE: " + problem);
            }
            out.println();
        }
        out.printf("Searched in %.1f ms: %d rounds, %,d patterns scanned, %d stops to start from, %d to end at.%n",
                result.computeNanos() / 1e6, result.rounds(), result.patternsScanned(), query.access().size(),
                query.egress().size());
    }

    static Place place(Timetable t, String text) {
        String[] parts = text.split(",");
        if (parts.length == 2) {
            try {
                return new Place.Point(Double.parseDouble(parts[0].strip()), Double.parseDouble(parts[1].strip()));
            } catch (NumberFormatException e) {
                // not a position; perhaps an id with a comma in it
            }
        }
        int stop = t.stopIndex(text);
        if (stop >= 0) {
            return new Place.Stop(stop);
        }
        int station = t.stationIndex(text);
        if (station >= 0) {
            return new Place.Station(station);
        }
        usage("'" + text + "' is not a stop id, a station id or a latitude,longitude");
        return null;
    }

    static String describe(Timetable t, Place place) {
        return switch (place) {
            case Place.Stop s -> t.stopNames[s.stop()] + " (stop " + t.stopIds[s.stop()] + ")";
            case Place.Station s -> t.stationNames[s.station()] + " (station " + t.stationIds[s.station()] + ")";
            case Place.Point p -> p.lat() + ", " + p.lon();
        };
    }

    /** Reads {@code HH:MM} or {@code HH:MM:SS} into seconds. */
    static int time(String text) {
        String[] parts = text.split(":");
        try {
            if (parts.length == 2 || parts.length == 3) {
                int hours = Integer.parseInt(parts[0]);
                int minutes = Integer.parseInt(parts[1]);
                int seconds = parts.length == 3 ? Integer.parseInt(parts[2]) : 0;
                if (hours >= 0 && minutes >= 0 && minutes < 60 && seconds >= 0 && seconds < 60) {
                    return hours * 3600 + minutes * 60 + seconds;
                }
            }
        } catch (NumberFormatException e) {
            // reported below
        }
        usage("'" + text + "' is not a time; write it like 07:45 or 24:30:00");
        return 0;
    }

    static String clock(int seconds) {
        return String.format("%02d:%02d:%02d", seconds / 3600, seconds / 60 % 60, seconds % 60);
    }

    private static String minutes(int seconds) {
        return Math.round(seconds / 60.0) + " min";
    }

    private static String value(String[] args, int index) {
        if (index >= args.length) {
            usage(args[index - 1] + " needs a value");
        }
        return args[index];
    }

    private static void usage(String problem) {
        System.err.println(problem);
        System.err.println("Usage: RouteCli <feed.zip> <from> <to> <time> [--date 20261117] [--snapshots <folder>]"
                + " [--rides 8] [--walk 1200] [--avoid school_bus,ferry] [--change 120] [--water <file>] [--arrive-by]");
        System.err.println("       RouteCli <feed.zip> --random <count> [--area opal|all] [--within <km>] [--threads 8] [--show 5] [--seed 1]"
                + " [--dump <file>]");
        System.exit(2);
    }
}
