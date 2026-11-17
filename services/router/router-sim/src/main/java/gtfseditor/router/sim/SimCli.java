package gtfseditor.router.sim;

import gtfseditor.router.core.Timetable;
import gtfseditor.router.gtfs.GtfsException;
import gtfseditor.router.gtfs.GtfsLoader;
import gtfseditor.router.gtfs.LoadOptions;
import gtfseditor.router.gtfs.TimetableCache;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * The simulator from the command line.
 *
 * <pre>
 * SimCli demand generate &lt;feed.zip&gt; --out &lt;file.csv[.gz]&gt; [--journeys 100000] [--seed 1] [--area opal] [--within 25]
 *        [--focus 1] [--people 1]
 * SimCli demand check &lt;file&gt; [--zip &lt;feed.zip&gt;]
 *
 * SimCli run &lt;feed.zip&gt; --demand &lt;file&gt; --out &lt;folder&gt;      a BAU run, on the published timetable
 *        [--area all] [--walk 500] [--change-penalty 600] [--share 1] [--school-buses]
 * SimCli run &lt;feed.zip&gt; --bau &lt;folder&gt; --out &lt;folder&gt;        a scenario run, against a BAU run
 *        [--threshold 600] [--give-up 3600|none]
 * SimCli run &lt;feed.zip&gt; --from-plans &lt;folder&gt; [--out &lt;folder&gt;]   capacity on, from a run's kept plans
 *
 * for any run: [--capacity] [--full-at 1.0] [--left-behind 5] [--threads n] [--no-reuse] [--name text]
 * wherever a zip is named: [--date 20261117] [--snapshots &lt;folder&gt;]
 * </pre>
 *
 * Areas are {@code all}, {@code opal}, {@code newcastle}, {@code sydney}, {@code wollongong} or
 * {@code south,west,north,east}. Times are seconds. See the README.
 */
public final class SimCli {

    private SimCli() {}

    public static void main(String[] args) throws Exception {
        try {
            if (args.length >= 2 && args[0].equals("demand") && args[1].equals("generate")) {
                generate(args);
            } else if (args.length >= 2 && args[0].equals("demand") && args[1].equals("check")) {
                check(args);
            } else if (args.length >= 1 && args[0].equals("run")) {
                run(args);
            } else {
                usage("say what to do: demand generate, demand check, or run");
            }
        } catch (IllegalArgumentException | GtfsException e) {
            System.err.println(e.getMessage());
            System.exit(1);
        }
    }

    private static void generate(String[] args) throws IOException {
        Path zip = null;
        Path out = null;
        Path snapshots = null;
        LoadOptions options = LoadOptions.defaults();
        int journeys = 100_000;
        long seed = 1;
        Area area = Area.OPAL;
        double within = DemandGenerator.DEFAULT_WITHIN_KM;
        double focus = 1.0;
        int people = 1;
        for (int i = 2; i < args.length; i++) {
            switch (args[i]) {
                case "--out" -> out = Path.of(value(args, ++i));
                case "--journeys" -> journeys = Integer.parseInt(value(args, ++i));
                case "--seed" -> seed = Long.parseLong(value(args, ++i));
                case "--area" -> area = Area.parse(value(args, ++i));
                case "--within" -> within = Double.parseDouble(value(args, ++i));
                case "--focus" -> focus = Double.parseDouble(value(args, ++i));
                case "--people" -> people = Integer.parseInt(value(args, ++i));
                case "--date" -> options = options.withServiceDate(Integer.parseInt(value(args, ++i)));
                case "--snapshots" -> snapshots = Path.of(value(args, ++i));
                default -> zip = plain(args[i], zip);
            }
        }
        if (zip == null || out == null) {
            usage("demand generate needs a zip and --out <file>");
        }
        Timetable t = load(zip, options, snapshots);
        Demand demand = DemandGenerator.generate(t, area, journeys, seed, within, focus, people);
        DemandWriter.write(demand, out);
        DemandReport.Figures f = DemandReport.figures(demand);
        System.out.printf("Wrote %,d made-up journeys by %,d users, standing for %,d people, to %s%n", f.rows(),
                f.users(), f.people(), out.toAbsolutePath());
        System.out.printf("  area %s, ends within %s km, seed %d; busiest hour %02d:00 with %,d%n",
                area == null ? "all" : area.text(), within > 0 ? Double.toString(within) : "any", seed,
                f.busiestHour(), f.busiestHourPeople());
    }

    private static void check(String[] args) throws IOException {
        Path file = null;
        Path zip = null;
        Path snapshots = null;
        LoadOptions options = LoadOptions.defaults();
        for (int i = 2; i < args.length; i++) {
            switch (args[i]) {
                case "--zip" -> zip = Path.of(value(args, ++i));
                case "--date" -> options = options.withServiceDate(Integer.parseInt(value(args, ++i)));
                case "--snapshots" -> snapshots = Path.of(value(args, ++i));
                default -> file = plain(args[i], file);
            }
        }
        if (file == null) {
            usage("demand check needs a file");
        }
        DemandReader.Read read = DemandReader.read(file);
        Demand demand = read.demand();
        if (zip != null) {
            demand = demand.located(load(zip, options, snapshots), read.report());
        }
        System.out.println(file.toAbsolutePath());
        read.report().print(System.out, demand);
        if (zip == null) {
            System.out.println("  Stop ids were not looked up; name the published timetable with --zip to check them.");
        }
    }

    private static void run(String[] args) throws IOException, InterruptedException {
        Path zip = null;
        Path demandFile = null;
        Path bau = null;
        Path fromPlans = null;
        Path out = null;
        Path snapshots = null;
        String name = null;
        LoadOptions options = LoadOptions.defaults();
        SimSettings settings = new SimSettings();
        for (int i = 1; i < args.length; i++) {
            switch (args[i]) {
                case "--demand" -> demandFile = Path.of(value(args, ++i));
                case "--bau" -> bau = Path.of(value(args, ++i));
                case "--from-plans" -> fromPlans = Path.of(value(args, ++i));
                case "--out" -> out = Path.of(value(args, ++i));
                case "--name" -> name = value(args, ++i);
                case "--area" -> settings.area = Area.parse(value(args, ++i));
                case "--walk" -> settings.walkMetres = Double.parseDouble(value(args, ++i));
                case "--change-penalty" -> settings.changePenaltySecs = Integer.parseInt(value(args, ++i));
                case "--share" -> settings.shareOneIn = Integer.parseInt(value(args, ++i));
                case "--school-buses" -> settings.schoolBuses = true;
                case "--threshold" -> settings.switchThresholdSecs = Integer.parseInt(value(args, ++i));
                case "--give-up" -> {
                    String limit = value(args, ++i);
                    settings.giveUpSecs = limit.equals("none") ? -1 : Integer.parseInt(limit);
                }
                case "--capacity" -> settings.capacity = true;
                case "--full-at" -> settings.fullAt = Double.parseDouble(value(args, ++i));
                case "--left-behind" -> settings.maxLeftBehind = Integer.parseInt(value(args, ++i));
                case "--threads" -> settings.threads = Integer.parseInt(value(args, ++i));
                case "--no-reuse" -> settings.reusePlans = false;
                case "--date" -> options = options.withServiceDate(Integer.parseInt(value(args, ++i)));
                case "--snapshots" -> snapshots = Path.of(value(args, ++i));
                default -> zip = plain(args[i], zip);
            }
        }
        int ways = (demandFile != null ? 1 : 0) + (bau != null ? 1 : 0) + (fromPlans != null ? 1 : 0);
        if (zip == null || ways != 1) {
            usage("run needs a zip and one of --demand <file>, --bau <folder> or --from-plans <folder>");
        }
        if (out == null && fromPlans != null) {
            out = fromPlans.resolve("capacity");
        }
        if (out == null) {
            usage("run needs --out <folder>");
        }
        if (Files.exists(out.resolve(SimRun.PROPERTIES))) {
            usage(out + " already holds a run; name another folder, or remove that one first");
        }
        settings.check();

        long started = System.nanoTime();
        Timetable t = load(zip, options, snapshots);
        System.out.printf("Timetable loaded in %.1f s: %,d trips, %,d stops%n", (System.nanoTime() - started) / 1e9,
                t.tripCount(), t.stopCount());
        long[] printed = {System.nanoTime()};
        Progress progress = (stage, done, total) -> {
            // A line when a stage starts or ends, and otherwise every quarter of a minute.
            if (done == 0 || done == total || System.nanoTime() - printed[0] > 15e9) {
                printed[0] = System.nanoTime();
                System.out.printf("  %-6s %,d of %,d%n", stage, done, total);
            }
        };
        SimRun.Done done;
        if (demandFile != null) {
            DemandReader.Read read = DemandReader.read(demandFile);
            String label = name != null ? name : "BAU" + (settings.area == null ? ", whole network"
                    : " bounded " + settings.area.text());
            done = SimRun.bau(t, read.demand(), read.report(), settings, label, out, progress);
        } else if (bau != null) {
            done = SimRun.scenario(t, bau, settings, name != null ? name : "Scenario against " + bau.getFileName(), out,
                    progress);
        } else {
            done = SimRun.withCapacity(t, fromPlans, settings,
                    name != null ? name : fromPlans.getFileName() + " with capacity", out, progress);
        }
        System.out.println();
        System.out.print(Json.readable(done.summary()));
        System.out.printf("%nFiles are in %s%n", done.folder().toAbsolutePath());
    }

    private static Timetable load(Path zip, LoadOptions options, Path snapshots) throws IOException {
        if (!Files.isRegularFile(zip)) {
            usage("there is no file " + zip.toAbsolutePath());
        }
        return snapshots == null ? GtfsLoader.load(zip, options)
                : TimetableCache.load(zip, options, snapshots).timetable();
    }

    private static Path plain(String argument, Path already) {
        if (argument.startsWith("--") || already != null) {
            usage("did not understand '" + argument + "'");
        }
        return Path.of(argument);
    }

    private static String value(String[] args, int index) {
        if (index >= args.length) {
            usage(args[index - 1] + " needs a value");
        }
        return args[index];
    }

    private static void usage(String problem) {
        System.err.println(problem);
        System.err.println("Usage: SimCli demand generate <feed.zip> --out <file> [--journeys 100000] [--seed 1]"
                + " [--area opal] [--within 25] [--focus 1] [--people 1]");
        System.err.println("       SimCli demand check <file> [--zip <feed.zip>]");
        System.err.println("       SimCli run <feed.zip> --demand <file> --out <folder> [--area all] [--walk 500]"
                + " [--change-penalty 600] [--share 1] [--school-buses]");
        System.err.println("       SimCli run <feed.zip> --bau <folder> --out <folder> [--threshold 600]"
                + " [--give-up 3600|none]");
        System.err.println("       SimCli run <feed.zip> --from-plans <folder> [--out <folder>]");
        System.err.println("       any run: [--capacity] [--full-at 1.0] [--left-behind 5] [--threads n] [--no-reuse]"
                + " [--name text]");
        System.exit(2);
    }
}
