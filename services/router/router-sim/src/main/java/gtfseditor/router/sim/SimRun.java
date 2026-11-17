package gtfseditor.router.sim;

import gtfseditor.router.core.Router;
import gtfseditor.router.core.Timetable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;

/**
 * A run with its files. See sections 5.1 and 6.4 of docs/simulator-plan.md.
 *
 * <p>A run's folder holds:
 *
 * <table>
 *   <caption>Files of a run</caption>
 *   <tr><td>{@code summary.json}</td><td>totals, settings, pressure on capacity, time taken</td></tr>
 *   <tr><td>{@code journeys.csv.gz}</td><td>one line per journey</td></tr>
 *   <tr><td>{@code legs.csv.gz}</td><td>one line per walk, change or ride</td></tr>
 *   <tr><td>{@code trip_loads.csv.gz}</td><td>each trip at each stop where anything happened</td></tr>
 *   <tr><td>{@code stop_activity.csv.gz}</td><td>each stop by quarter hour</td></tr>
 *   <tr><td>{@code plans.bin.gz}</td><td>the plans of stage 1, kept</td></tr>
 *   <tr><td>{@code demand.csv.gz}</td><td>a BAU run only: the journeys it ran, each with its positions</td></tr>
 *   <tr><td>{@code run.properties}</td><td>what the run was, for the runs made from it</td></tr>
 * </table>
 *
 * <p>There are three ways to make one:
 *
 * <ul>
 *   <li>{@link #bau}: on the published timetable. Everyone keeps their own stops.
 *   <li>{@link #scenario}: on a changed timetable, against a BAU run, whose demand, area, walking
 *       distance and other shared settings it takes.
 *   <li>{@link #withCapacity}: the kept plans of either, put on the vehicles again with capacity on.
 * </ul>
 */
public final class SimRun {

    static final String PLANS = "plans.bin.gz";
    static final String DEMAND = "demand.csv.gz";
    static final String PROPERTIES = "run.properties";

    /** The files of a run that are its results, for whoever collects them. A BAU run also has its demand. */
    public static final List<String> RESULT_FILES = List.of("summary.json", "journeys.csv.gz", "legs.csv.gz",
            "trip_loads.csv.gz", "stop_activity.csv.gz", DEMAND);

    /** Whether a folder holds a finished run. The properties file is the last thing a run writes. */
    public static boolean isRun(Path folder) {
        return Files.isRegularFile(folder.resolve(PROPERTIES)) && Files.isRegularFile(folder.resolve("summary.json"));
    }

    /** What stage 1 does not model, shown with every result (section 4.4). */
    static final List<String> LIMITS = List.of(
            "Vehicles are never late: crowds do not slow them.",
            "Everyone with the same two stops and start takes the same journey, so busy lines look busier.",
            "Nobody plans around crowding; a passenger finds a vehicle full by being left behind.",
            "A person's journeys are independent of each other.",
            "One service day: a journey that needs tomorrow's first vehicle finds nothing.",
            "Walking is a straight line times the timetable's detour factor.");

    /** A finished run: where its files are and its summary, as written to {@code summary.json}. */
    public record Done(Path folder, Map<String, Object> summary) {}

    private SimRun() {}

    /**
     * A run on the published timetable.
     *
     * @param demand as read from a file; positions are looked up here, and the area and share applied
     * @param report the report of reading that file, which gains the rows refused or left out here
     */
    public static Done bau(Timetable timetable, Demand demand, DemandReport report, SimSettings settings, String name,
            Path folder, Progress progress) throws IOException, InterruptedException {
        settings.check();
        Demand located = demand.located(timetable, report);
        Area area = settings.area;
        if (area != null) {
            Demand all = located;
            located = all.keeping(row -> {
                boolean from = area.holds(all.placeLat[all.origin[row]], all.placeLon[all.origin[row]]);
                boolean to = area.holds(all.placeLat[all.destination[row]], all.placeLon[all.destination[row]]);
                if (!from || !to) {
                    report.leftOut(from || to);
                }
                return from && to;
            });
        }
        Demand run = located.share(settings.shareOneIn);
        Files.createDirectories(folder);
        DemandWriter.write(run, folder.resolve(DEMAND));

        Properties properties = new Properties();
        properties.setProperty("kind", "bau");
        properties.setProperty("demand", folder.resolve(DEMAND).toAbsolutePath().toString());
        properties.setProperty("rowsRead", Long.toString(report.rowsRead()));
        properties.setProperty("rowsRefused", Long.toString(report.rowsRefused()));
        properties.setProperty("leftOutOutside", Long.toString(report.leftOutOutside()));
        properties.setProperty("leftOutOneEnd", Long.toString(report.leftOutOneEnd()));
        try (Simulation simulation = new Simulation(new Router(timetable, settings.maxRides, settings.changeSecs),
                run, settings)) {
            Plans plans = simulation.plan(null, progress);
            return finish(timetable, run, settings, simulation, plans, null, true, name, folder, properties, progress);
        }
    }

    /**
     * A run on a changed timetable, measured against a BAU run.
     *
     * @param bauFolder the BAU run's folder
     * @param own       the settings a scenario run chooses for itself: the threshold for changing
     *                  stop, the give-up limit, capacity, threads. The rest are the BAU run's.
     */
    public static Done scenario(Timetable timetable, Path bauFolder, SimSettings own, String name, Path folder,
            Progress progress) throws IOException, InterruptedException {
        Properties bau = properties(bauFolder);
        if (!"bau".equals(bau.getProperty("kind"))) {
            throw new IllegalArgumentException(bauFolder + " is not a BAU run; a scenario run is made against one");
        }
        SimSettings settings = own.copy();
        settings.readShared(bau);
        settings.check();
        Demand demand = DemandReader.read(Path.of(bau.getProperty("demand"))).demand();
        Plans reference = PlanStore.read(bauFolder.resolve(PLANS), null);

        Files.createDirectories(folder);
        Properties properties = new Properties();
        properties.setProperty("kind", "scenario");
        properties.setProperty("bau", bauFolder.toAbsolutePath().toString());
        properties.setProperty("demand", bau.getProperty("demand"));
        for (String counted : List.of("rowsRead", "rowsRefused", "leftOutOutside", "leftOutOneEnd")) {
            properties.setProperty(counted, bau.getProperty(counted, "0"));
        }
        try (Simulation simulation = new Simulation(new Router(timetable, settings.maxRides, settings.changeSecs),
                demand, settings)) {
            Plans plans = simulation.plan(reference, progress);
            return finish(timetable, demand, settings, simulation, plans, reference, true, name, folder, properties,
                    progress);
        }
    }

    /**
     * Puts the kept plans of a run on the vehicles again with capacity on, without planning again.
     *
     * @param runFolder the run whose plans to use; the timetable must be the one it was planned on
     * @param capacity  {@code fullAt}, {@code maxLeftBehind} and {@code threads} are taken from here
     * @throws IllegalArgumentException if the timetable is not the one the plans were made on
     */
    public static Done withCapacity(Timetable timetable, Path runFolder, SimSettings capacity, String name,
            Path folder, Progress progress) throws IOException, InterruptedException {
        Properties source = properties(runFolder);
        boolean scenario = "scenario".equals(source.getProperty("kind"));
        SimSettings settings = capacity.copy();
        settings.readShared(source);
        settings.readOwn(source);
        settings.capacity = true;
        settings.check();
        Path plansFolder = Path.of(source.getProperty("plans", runFolder.toAbsolutePath().toString()));
        Plans plans = PlanStore.read(plansFolder.resolve(PLANS), PlanStore.fingerprint(timetable));
        Plans reference = scenario ? PlanStore.read(Path.of(source.getProperty("bau")).resolve(PLANS), null) : null;
        Demand demand = DemandReader.read(Path.of(source.getProperty("demand"))).demand();

        Files.createDirectories(folder);
        Properties properties = new Properties();
        properties.setProperty("kind", source.getProperty("kind"));
        properties.setProperty("plans", plansFolder.toString());
        properties.setProperty("demand", source.getProperty("demand"));
        if (scenario) {
            properties.setProperty("bau", source.getProperty("bau"));
        }
        for (String counted : List.of("rowsRead", "rowsRefused", "leftOutOutside", "leftOutOneEnd")) {
            properties.setProperty(counted, source.getProperty(counted, "0"));
        }
        try (Simulation simulation = new Simulation(new Router(timetable, settings.maxRides, settings.changeSecs),
                demand, settings)) {
            return finish(timetable, demand, settings, simulation, plans, reference, false, name, folder, properties,
                    progress);
        }
    }

    /**
     * What a finished run recorded about itself: {@code kind} ({@code bau} or {@code scenario}),
     * {@code name}, and for the runs it depends on the folders {@code bau} and {@code plans}.
     *
     * @throws IllegalArgumentException if the folder does not hold a finished run
     */
    public static Properties properties(Path folder) throws IOException {
        Path file = folder.resolve(PROPERTIES);
        if (!Files.isRegularFile(file)) {
            throw new IllegalArgumentException(folder + " is not the folder of a finished run: it has no " + PROPERTIES);
        }
        Properties properties = new Properties();
        try (InputStream in = Files.newInputStream(file)) {
            properties.load(in);
        }
        return properties;
    }

    /** Stage 2 and the files. */
    private static Done finish(Timetable t, Demand demand, SimSettings settings, Simulation simulation, Plans plans,
            Plans reference, boolean planned, String name, Path folder, Properties properties, Progress progress)
            throws IOException, InterruptedException {
        long started = System.nanoTime();
        long fingerprint = PlanStore.fingerprint(t);
        if (planned) {
            PlanStore.write(folder.resolve(PLANS), plans, fingerprint);
        }
        Simulation.Outcome outcome;
        ResultWriter.Totals totals;
        try (Writer journeys = DemandWriter.open(folder.resolve("journeys.csv.gz"));
                Writer legs = DemandWriter.open(folder.resolve("legs.csv.gz"))) {
            ResultWriter writer = new ResultWriter(t, demand, plans, reference, simulation.places(), journeys, legs);
            outcome = simulation.travel(plans, writer, progress);
            totals = writer.totals;
        }
        progress.at("write", 0, 2);
        long tripRows;
        long stopRows;
        try (Writer out = DemandWriter.open(folder.resolve("trip_loads.csv.gz"))) {
            tripRows = outcome.counts().writeTripLoads(out);
        }
        progress.at("write", 1, 2);
        try (Writer out = DemandWriter.open(folder.resolve("stop_activity.csv.gz"))) {
            stopRows = outcome.counts().writeStopActivity(out);
        }
        progress.at("write", 2, 2);
        double writeSecs = (System.nanoTime() - started) / 1e9 - outcome.seconds();

        Map<String, Object> summary = summary(t, demand, settings, plans, reference, planned, name, properties,
                outcome, totals, fingerprint);
        @SuppressWarnings("unchecked")
        Map<String, Object> work = (Map<String, Object>) summary.get("work");
        work.put("writeSecs", writeSecs);
        @SuppressWarnings("unchecked")
        Map<String, Object> files = (Map<String, Object>) summary.get("rowsWritten");
        files.put("tripLoads", tripRows);
        files.put("stopActivity", stopRows);
        Files.writeString(folder.resolve("summary.json"), Json.write(summary), StandardCharsets.UTF_8);

        properties.setProperty("name", name);
        properties.setProperty("fingerprint", Long.toHexString(fingerprint));
        settings.writeShared(properties);
        settings.writeOwn(properties);
        try (OutputStream out = Files.newOutputStream(folder.resolve(PROPERTIES))) {
            properties.store(out, "A simulator run. Read by the runs made from it; see summary.json for the results.");
        }
        return new Done(folder, summary);
    }

    private static Map<String, Object> summary(Timetable t, Demand demand, SimSettings s, Plans plans,
            Plans reference, boolean planned, String name, Properties properties, Simulation.Outcome outcome,
            ResultWriter.Totals totals, long fingerprint) {
        Map<String, Object> summary = new LinkedHashMap<>();
        summary.put("name", name);
        summary.put("kind", properties.getProperty("kind"));
        summary.put("capacity", s.capacity);
        if (properties.getProperty("bau") != null) {
            summary.put("bauRun", properties.getProperty("bau"));
        }
        if (!planned) {
            summary.put("plansFrom", properties.getProperty("plans"));
        }

        Map<String, Object> timetable = new LinkedHashMap<>();
        timetable.put("serviceDate", t.serviceDate);
        timetable.put("feedVersion", t.feedVersion);
        timetable.put("stops", t.stopCount());
        timetable.put("trips", t.tripCount());
        timetable.put("fingerprint", Long.toHexString(fingerprint));
        summary.put("timetable", timetable);

        Map<String, Object> settings = new LinkedHashMap<>();
        settings.put("walkMetres", s.walkMetres);
        settings.put("changePenaltySecs", s.changePenaltySecs);
        settings.put("switchThresholdSecs", s.switchThresholdSecs);
        settings.put("giveUpSecs", s.giveUpSecs);
        settings.put("schoolBuses", s.schoolBuses);
        settings.put("shareOneIn", s.shareOneIn);
        settings.put("area", s.area == null ? "all" : s.area.text());
        settings.put("fullAt", s.fullAt);
        settings.put("maxLeftBehind", s.maxLeftBehind);
        settings.put("maxRides", s.maxRides);
        settings.put("changeSecs", s.changeSecs);
        settings.put("threads", s.threads);
        settings.put("reusePlans", s.reusePlans);
        summary.put("settings", settings);

        Map<String, Object> asked = new LinkedHashMap<>();
        asked.put("rowsInFile", Long.parseLong(properties.getProperty("rowsRead", "0")));
        asked.put("rowsRefused", Long.parseLong(properties.getProperty("rowsRefused", "0")));
        asked.put("leftOutWhollyOutsideArea", Long.parseLong(properties.getProperty("leftOutOutside", "0")));
        asked.put("leftOutOneEndInsideArea", Long.parseLong(properties.getProperty("leftOutOneEnd", "0")));
        asked.put("rows", demand.size());
        asked.put("people", demand.totalPeople());
        asked.put("users", demand.userCount());
        summary.put("demand", asked);

        Map<String, Object> people = new LinkedHashMap<>();
        Map<String, Object> rows = new LinkedHashMap<>();
        for (byte status = 0; status < 4; status++) {
            people.put(Plans.statusName(status), totals.people[status]);
            rows.put(Plans.statusName(status), totals.rows[status]);
        }
        summary.put("people", people);
        summary.put("journeyRows", rows);
        Map<String, Object> why = new LinkedHashMap<>();
        for (byte reason = 1; reason < 4; reason++) {
            why.put(Plans.whyName(reason), totals.why[reason]);
        }
        summary.put("noJourneyBecause", why);

        long ok = Math.max(1, totals.people[Plans.OK]);
        Map<String, Object> travel = new LinkedHashMap<>();
        travel.put("medianMinutes", totals.percentile(0.5));
        travel.put("percentile90Minutes", totals.percentile(0.9));
        travel.put("meanMinutes", totals.journeySecs / 60.0 / ok);
        travel.put("meanWaitMinutes", totals.waitSecs / 60.0 / ok);
        travel.put("meanWalkMinutes", totals.walkSecs / 60.0 / ok);
        travel.put("meanRides", (double) totals.rides / ok);
        travel.put("meanVehiclesBoarded", (double) totals.boardings / ok);
        travel.put("boardings", outcome.counts().totalBoardings());
        summary.put("journeys", travel);

        Map<String, Object> stops = new LinkedHashMap<>();
        stops.put("changedAtOrigin", totals.changedOrigin);
        stops.put("changedAtDestination", totals.changedDestination);
        stops.put("becauseTheirStopWasGone", totals.changedBecauseGone);
        stops.put("becauseAnotherWasBetter", totals.changedBecauseBetter);
        stops.put("rowsThatArePositions", totals.positionRows);
        summary.put("stops", stops);

        if (reference != null) {
            Map<String, Object> against = new LinkedHashMap<>();
            against.put("compared", totals.compared);
            against.put("sooner", totals.sooner);
            against.put("later", totals.later);
            against.put("within1Minute", totals.same);
            against.put("meanMinutesSooner", totals.soonerSecs / 60.0 / Math.max(1, totals.sooner));
            against.put("meanMinutesLater", totals.laterSecs / 60.0 / Math.max(1, totals.later));
            against.put("gaveUp", totals.people[Plans.GAVE_UP]);
            against.put("newlyAbleToTravel", totals.newlyServed);
            against.put("noLongerAbleToTravel", totals.lostService);
            summary.put("againstBau", against);
        }

        // Pressure on capacity, from the plans alone (section 4.5).
        Map<String, Object> pressure = new LinkedHashMap<>();
        pressure.put("tripsPlannedOverCapacity", outcome.planned().trips());
        pressure.put("departuresPlannedOverCapacity", outcome.planned().departures());
        List<Object> worst = new ArrayList<>();
        for (Counts.Over over : outcome.planned().worst()) {
            Map<String, Object> trip = new LinkedHashMap<>();
            trip.put("trip", t.tripIds[over.trip()]);
            trip.put("line", t.routeNames[t.tripRoute[over.trip()]]);
            trip.put("plannedLoad", over.peakLoad());
            trip.put("limit", over.limit());
            trip.put("firstOverAt", Clock.text(over.firstTime()));
            trip.put("stop", t.stopIds[over.firstStop()]);
            worst.add(trip);
        }
        pressure.put("furthestOver", worst);
        summary.put("plannedLoads", pressure);

        if (s.capacity) {
            Map<String, Object> crowding = new LinkedHashMap<>();
            crowding.put("replayRan", outcome.replayed());
            crowding.put("timesLeftBehind", outcome.leftBehindPeople());
            crowding.put("peopleLeftBehindAtLeastOnce", totals.leftBehindOnce);
            crowding.put("shareLeftBehindPercent", 100.0 * totals.leftBehindOnce / Math.max(1, demand.totalPeople()));
            crowding.put("arrivedAnotherWay", totals.rerouted);
            crowding.put("stranded", totals.people[Plans.STRANDED]);
            List<Object> lines = new ArrayList<>();
            for (Counts.Line line : outcome.counts().fullestLines(10)) {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("line", t.routeNames[line.route()]);
                row.put("route", t.routeIds[line.route()]);
                row.put("peakPercent", 100.0 * line.peakFactor());
                row.put("tripsFull", line.tripsOver());
                row.put("boardings", line.boardings());
                lines.add(row);
            }
            crowding.put("fullestLines", lines);
            List<Object> leaving = new ArrayList<>();
            for (Counts.Left left : outcome.counts().stopsLeavingMost(10)) {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("stop", t.stopIds[left.stop()]);
                row.put("name", t.stopNames[left.stop()]);
                row.put("leftBehind", left.people());
                leaving.add(row);
            }
            crowding.put("stopsLeavingMostBehind", leaving);
            summary.put("capacityResults", crowding);
        }

        int placeholders = 0;
        for (byte flags : t.tripCapacityFlags) {
            placeholders += flags != 0 ? 1 : 0;
        }
        Map<String, Object> capacities = new LinkedHashMap<>();
        capacities.put("trips", t.tripCount());
        capacities.put("placeholderOrAssumed", placeholders);
        summary.put("capacities", capacities);

        Map<String, Object> work = new LinkedHashMap<>();
        if (planned) {
            work.put("planSecs", plans.planSecs);
            work.put("searches", plans.searches);
            work.put("searchesSavedByReuse", plans.reused);
            work.put("journeysPlannedPerSecond", demand.size() / Math.max(1e-9, plans.planSecs));
        }
        work.put(outcome.replayed() ? "replaySecs" : "countSecs", outcome.seconds());
        work.put("searchesForThoseLeftBehind", outcome.replanSearches());
        summary.put("work", work);

        Map<String, Object> written = new LinkedHashMap<>();
        written.put("journeys", totals.journeyRows);
        written.put("legs", totals.legRows);
        summary.put("rowsWritten", written);
        summary.put("limits", LIMITS);
        return summary;
    }
}
