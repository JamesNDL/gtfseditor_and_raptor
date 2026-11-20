package gtfseditor.router.gtfs;

import gtfseditor.router.core.Timetable;
import gtfseditor.router.core.TimetableStats;
import java.io.PrintStream;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryPoolMXBean;
import java.lang.management.MemoryType;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Loads a GTFS zip from the command line and prints what was loaded, how long it took and how
 * much memory it used.
 *
 * <pre>
 * LoadCli &lt;feed.zip&gt; [--date 20261117] [--snapshots &lt;folder&gt;] [--radius &lt;metres&gt;] [--water &lt;file&gt;]
 * </pre>
 */
public final class LoadCli {

    private LoadCli() {}

    public static void main(String[] args) throws Exception {
        Path zip = null;
        Path snapshots = null;
        LoadOptions options = LoadOptions.defaults();
        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--date" -> options = options.withServiceDate(Integer.parseInt(value(args, ++i)));
                case "--snapshots" -> snapshots = Path.of(value(args, ++i));
                case "--water" -> options = options.withWater(WaterFile.read(Path.of(value(args, ++i))));
                case "--radius" -> options = options.withTransfers(
                        options.transfers().withRadiusMetres(Double.parseDouble(value(args, ++i))));
                default -> {
                    if (args[i].startsWith("--") || zip != null) {
                        usage("did not understand '" + args[i] + "'");
                    }
                    zip = Path.of(args[i]);
                }
            }
        }
        if (zip == null) {
            usage("no zip was named");
        }
        if (!Files.isRegularFile(zip)) {
            usage("there is no file " + zip.toAbsolutePath());
        }

        long started = System.nanoTime();
        Timetable timetable;
        String how;
        try {
            if (snapshots == null) {
                timetable = GtfsLoader.load(zip, options);
                how = "built from the zip";
            } else {
                TimetableCache.Loaded loaded = TimetableCache.load(zip, options, snapshots);
                timetable = loaded.timetable();
                how = loaded.fromSnapshot()
                        ? "read from the snapshot " + loaded.snapshot()
                        : "built from the zip and saved to " + loaded.snapshot();
            }
        } catch (GtfsException e) {
            System.err.println("Could not load " + zip + ": " + e.getMessage());
            System.exit(1);
            return;
        }
        double seconds = (System.nanoTime() - started) / 1e9;

        long peak = 0;
        for (MemoryPoolMXBean pool : ManagementFactory.getMemoryPoolMXBeans()) {
            if (pool.getType() == MemoryType.HEAP) {
                peak += pool.getPeakUsage().getUsed();
            }
        }
        System.gc();
        Runtime runtime = Runtime.getRuntime();
        long held = runtime.totalMemory() - runtime.freeMemory();

        print(System.out, timetable, how, seconds, peak, held);
    }

    static void print(PrintStream out, Timetable t, String how, double seconds, long peakBytes, long heldBytes) {
        TimetableStats s = TimetableStats.of(t);
        int date = t.serviceDate;
        out.printf("Timetable for %04d-%02d-%02d%s%n", date / 10000, date / 100 % 100, date % 100,
                t.feedVersion.isEmpty() ? "" : " (" + t.feedVersion + ")");
        out.printf("  %s in %.1f s%n", how, seconds);
        out.println();
        line(out, "stops", s.stops());
        line(out, "stations", s.stations());
        line(out, "routes", s.routes());
        line(out, "patterns", s.patterns());
        line(out, "pattern stops", s.patternStops());
        line(out, "trips", s.trips());
        line(out, "stop times", s.stopTimes());
        line(out, "walking links", s.transfers());
        line(out, "most links at a stop", s.mostTransfersAtAStop());
        line(out, "longest pattern", s.longestPattern());
        line(out, "stay-aboard links", s.stayAboardLinks());
        out.printf("  %-28s %s to %s%n", "service runs", clock(s.firstDeparture()), clock(s.lastArrival()));
        out.println();
        line(out, "trips, placeholder capacity", s.placeholderCapacity());
        line(out, "trips, default capacity", s.defaultedCapacity());
        out.println();
        out.printf("  %-28s %,d MB (estimate)%n", "timetable", megabytes(s.estimatedBytes()));
        out.printf("  %-28s %,d MB%n", "heap in use after loading", megabytes(heldBytes));
        out.printf("  %-28s %,d MB at most%n", "heap in use while loading", megabytes(peakBytes));
        out.println();
        out.println("Transfer settings: " + t.transferSettings);
        if (!t.notes.isEmpty()) {
            out.println("Notes:");
            for (String note : t.notes) {
                out.println("  - " + note);
            }
        }
    }

    private static void line(PrintStream out, String label, int value) {
        out.printf("  %-28s %,d%n", label, value);
    }

    private static long megabytes(long bytes) {
        return Math.round(bytes / (1024.0 * 1024.0));
    }

    private static String clock(int seconds) {
        return String.format("%02d:%02d:%02d", seconds / 3600, seconds / 60 % 60, seconds % 60);
    }

    private static String value(String[] args, int index) {
        if (index >= args.length) {
            usage(args[index - 1] + " needs a value");
        }
        return args[index];
    }

    private static void usage(String problem) {
        System.err.println(problem);
        System.err.println("Usage: LoadCli <feed.zip> [--date 20261117] [--snapshots <folder>] [--radius <metres>]"
                + " [--water <file>]");
        System.exit(2);
    }
}
