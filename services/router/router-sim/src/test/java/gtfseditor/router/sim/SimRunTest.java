package gtfseditor.router.sim;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import gtfseditor.router.core.Timetable;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.zip.GZIPInputStream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Runs with their files: BAU runs, scenario runs against them, capacity from kept plans, the area. */
class SimRunTest {

    private static List<String> lines(Path file) throws IOException {
        List<String> lines = new ArrayList<>();
        try (BufferedReader in = new BufferedReader(new InputStreamReader(
                new GZIPInputStream(Files.newInputStream(file)), StandardCharsets.UTF_8))) {
            for (String line = in.readLine(); line != null; line = in.readLine()) {
                lines.add(line);
            }
        }
        return lines;
    }

    private static SimSettings settings(boolean capacity) {
        SimSettings settings = new SimSettings();
        settings.capacity = capacity;
        settings.threads = 2;
        return settings;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> part(SimRun.Done done, String name) {
        return (Map<String, Object>) done.summary().get(name);
    }

    @Test
    void aBauRunWritesItsFilesAndTheirCountsAgree(@TempDir Path folder) throws Exception {
        Random random = new Random(1);
        Timetable t = RulesTest.randomTimetable(random, 12, 3, 6);
        Demand d = RulesTest.randomDemand(random, t, 300, 2);
        SimRun.Done done = SimRun.bau(t, d, new DemandReport(), settings(true), "BAU test", folder.resolve("bau"),
                Progress.NONE);

        for (String file : List.of("summary.json", "journeys.csv.gz", "legs.csv.gz", "trip_loads.csv.gz",
                "stop_activity.csv.gz", "plans.bin.gz", "demand.csv.gz", "run.properties")) {
            assertTrue(Files.size(done.folder().resolve(file)) > 0, file);
        }
        List<String> journeys = lines(done.folder().resolve("journeys.csv.gz"));
        List<String> legs = lines(done.folder().resolve("legs.csv.gz"));
        assertEquals(ResultWriter.JOURNEYS_HEADER.strip(), journeys.get(0));
        assertEquals(part(done, "rowsWritten").get("journeys"), (long) journeys.size() - 1);
        assertEquals(part(done, "rowsWritten").get("legs"), (long) legs.size() - 1);
        assertEquals(part(done, "rowsWritten").get("tripLoads"),
                (long) lines(done.folder().resolve("trip_loads.csv.gz")).size() - 1);

        // The people in the journeys file are the people of the demand, by status as the summary says.
        int columns = ResultWriter.JOURNEYS_HEADER.split(",").length;
        long ok = 0;
        long stranded = 0;
        long all = 0;
        for (String line : journeys.subList(1, journeys.size())) {
            String[] cells = line.split(",", -1);
            assertEquals(columns, cells.length, line);
            long people = Long.parseLong(cells[3]);
            all += people;
            ok += cells[4].equals("ok") ? people : 0;
            stranded += cells[4].equals("stranded") ? people : 0;
        }
        assertEquals(d.totalPeople(), all);
        assertEquals(part(done, "people").get("ok"), ok);
        assertEquals(part(done, "people").get("stranded"), stranded);
        assertEquals("bau", done.summary().get("kind"));
        assertNull(done.summary().get("againstBau"));
        assertTrue((long) part(done, "capacityResults").get("timesLeftBehind") > 0);
        String json = Files.readString(done.folder().resolve("summary.json"));
        assertTrue(json.startsWith("{") && json.contains("\"tripsPlannedOverCapacity\""), json);
    }

    @Test
    void capacityFromKeptPlansEqualsCapacityFromScratch(@TempDir Path folder) throws Exception {
        Random random = new Random(2);
        Timetable t = RulesTest.randomTimetable(random, 12, 3, 6);
        Demand d = RulesTest.randomDemand(random, t, 300, 2);
        SimRun.Done scratch = SimRun.bau(t, d, new DemandReport(), settings(true), "from scratch",
                folder.resolve("scratch"), Progress.NONE);
        SimRun.Done off = SimRun.bau(t, d, new DemandReport(), settings(false), "capacity off",
                folder.resolve("off"), Progress.NONE);
        SimRun.Done later = SimRun.withCapacity(t, off.folder(), settings(false), "capacity added",
                folder.resolve("off").resolve("capacity"), Progress.NONE);

        assertNotEquals(lines(scratch.folder().resolve("journeys.csv.gz")),
                lines(off.folder().resolve("journeys.csv.gz")), "capacity changes something in this run");
        for (String file : List.of("journeys.csv.gz", "legs.csv.gz", "trip_loads.csv.gz", "stop_activity.csv.gz")) {
            assertEquals(lines(scratch.folder().resolve(file)), lines(later.folder().resolve(file)), file);
        }
        assertEquals(true, later.summary().get("capacity"));
        assertEquals(part(scratch, "people"), part(later, "people"));
        assertFalse(Files.exists(later.folder().resolve("plans.bin.gz")), "the plans are not copied");

        // The kept plans are for one timetable only.
        Timetable other = RulesTest.randomTimetable(new Random(3), 12, 3, 6);
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class, () -> SimRun.withCapacity(other,
                off.folder(), settings(false), "wrong", folder.resolve("wrong"), Progress.NONE));
        assertTrue(e.getMessage().contains("different timetable"), e.getMessage());
    }

    @Test
    void aScenarioRunTakesItsPeopleAndSharedSettingsFromItsBauRun(@TempDir Path folder) throws Exception {
        String everyTen = "07:05 07:15 07:25 07:35 07:45 07:55 08:05 08:15 08:25 08:35";
        Timetable published = new Net().stop("O", 0, 0).stop("O2", 200, 0).stop("D", 10000, 0)
                .stop("X", 0, 9000).stop("Y", 9000, 9000)
                .line("Slow", 50, "O D", "0 20", everyTen).line("Cross", 50, "X Y", "0 20", everyTen).build();
        Demand d = Net.demand(published, Net.row("a", "08:00", "O", "D"), Net.row("b", "08:01", "O", "D", 4),
                Net.row("c", "08:02", "X", "Y"), Net.row("d", "07:00", "O", "D"));
        SimSettings bauSettings = settings(false);
        bauSettings.walkMetres = 300;
        bauSettings.shareOneIn = 1;
        // Only the journeys in the southern half of the map.
        bauSettings.area = new Area("box", -33.1, published.stopLat[published.stopIndex("X")] - 0.01, 150, 152);
        DemandReport report = new DemandReport();
        SimRun.Done bau = SimRun.bau(published, d, report, bauSettings, "BAU south", folder.resolve("bau"),
                Progress.NONE);
        assertEquals(3, part(bau, "demand").get("rows"));
        assertEquals(1L, part(bau, "demand").get("leftOutWhollyOutsideArea"));
        assertEquals(1, report.leftOutOutside());

        // The slow line is cut back; a quick line starts from the stop 200 m away.
        Timetable changed = new Net().stop("O", 0, 0).stop("O2", 200, 0).stop("D", 10000, 0)
                .stop("X", 0, 9000).stop("Y", 9000, 9000)
                .line("Slow", 50, "O D", "0 20", "07:05 08:35").line("Quick", 50, "O2 D", "0 6", everyTen)
                .line("Cross", 50, "X Y", "0 20", everyTen).build();
        SimSettings own = settings(false);
        own.walkMetres = 2000;   // ignored: the BAU run's 300 m is used
        own.area = null;         // ignored likewise
        SimRun.Done scenario = SimRun.scenario(changed, bau.folder(), own, "Scenario", folder.resolve("scenario"),
                Progress.NONE);
        assertEquals("scenario", scenario.summary().get("kind"));
        assertEquals(300.0, part(scenario, "settings").get("walkMetres"));
        assertEquals(bauSettings.area.text(), part(scenario, "settings").get("area"));
        assertEquals(3, part(scenario, "demand").get("rows"));
        assertEquals(6L, part(scenario, "demand").get("people"));
        assertEquals(1L, part(scenario, "demand").get("leftOutWhollyOutsideArea"));
        Map<String, Object> against = part(scenario, "againstBau");
        assertEquals(6L, against.get("compared"));
        assertEquals(5L, against.get("sooner"), "the two at 08:00 and 08:01 take the quick line");
        assertEquals(0L, against.get("later"));
        assertEquals(1L, against.get("within1Minute"), "the one at 07:00 takes the 07:05 slow bus, which still runs");
        assertEquals(5L, part(scenario, "stops").get("changedAtOrigin"));
        assertEquals(5L, part(scenario, "stops").get("becauseAnotherWasBetter"));
        assertFalse(Files.exists(scenario.folder().resolve("demand.csv.gz")), "the demand stays with the BAU run");

        // Capacity can be added to the scenario run from its kept plans too.
        SimRun.Done crowded = SimRun.withCapacity(changed, scenario.folder(), settings(false), "Scenario, capacity",
                scenario.folder().resolve("capacity"), Progress.NONE);
        assertEquals(against, part(crowded, "againstBau"));

        // A scenario run is made against a BAU run, not against another scenario run.
        assertThrows(IllegalArgumentException.class, () -> SimRun.scenario(changed, scenario.folder(), own, "no",
                folder.resolve("no"), Progress.NONE));
        assertThrows(IllegalArgumentException.class, () -> SimRun.scenario(changed, folder.resolve("nothing"), own,
                "no", folder.resolve("no"), Progress.NONE));
    }

    @Test
    void theAreaKeepsOnlyJourneysWithBothEndsInsideAndTheCountsAddUp(@TempDir Path folder) throws Exception {
        Random random = new Random(4);
        Timetable t = RulesTest.randomTimetable(random, 12, 30, 60);
        Demand d = RulesTest.randomDemand(random, t, 400, 1);
        SimSettings settings = settings(false);
        // The western three columns of the grid of stops.
        settings.area = new Area("box", -34, -32, 150, t.stopLon[t.stopIndex("s2")] + 0.0008);
        DemandReport report = new DemandReport();
        SimRun.Done done = SimRun.bau(t, d, report, settings, "west", folder.resolve("west"), Progress.NONE);
        int rows = (Integer) part(done, "demand").get("rows");
        assertTrue(rows > 10 && rows < 390, "rows " + rows);
        assertEquals(400, rows + report.leftOutOutside() + report.leftOutOneEnd());
        assertTrue(report.leftOutOneEnd() > 0 && report.leftOutOutside() > 0);
        Demand kept = DemandReader.read(done.folder().resolve("demand.csv.gz")).demand();
        assertEquals(rows, kept.size());
        for (int place = 0; place < kept.placeCount(); place++) {
            boolean used = false;
            for (int row = 0; row < kept.size(); row++) {
                used |= kept.origin[row] == place || kept.destination[row] == place;
            }
            assertTrue(!used || settings.area.holds(kept.placeLat[place], kept.placeLon[place]));
        }
    }

    @Test
    void aShareOfTheDemandIsRunAsMorePeoplePerRow(@TempDir Path folder) throws Exception {
        Random random = new Random(5);
        Timetable t = RulesTest.randomTimetable(random, 12, 30, 60);
        Demand d = RulesTest.randomDemand(random, t, 400, 1);
        SimSettings settings = settings(false);
        settings.shareOneIn = 5;
        SimRun.Done done = SimRun.bau(t, d, new DemandReport(), settings, "fifth", folder.resolve("fifth"),
                Progress.NONE);
        assertEquals(80, part(done, "demand").get("rows"));
        assertEquals(400L, part(done, "demand").get("people"));
    }

    @Test
    void keptPlansReadBackAsTheyWere(@TempDir Path folder) throws Exception {
        Random random = new Random(6);
        Timetable t = RulesTest.randomTimetable(random, 12, 3, 6);
        Demand d = RulesTest.randomDemand(random, t, 200, 1);
        Net.Ran ran = Net.run(t, d, settings(false), null);
        Path file = folder.resolve("plans.bin.gz");
        PlanStore.write(file, ran.plans(), PlanStore.fingerprint(t));
        Plans back = PlanStore.read(file, PlanStore.fingerprint(t));
        Plans figures = PlanStore.read(file, null);
        for (int row = 0; row < d.size(); row++) {
            assertEquals(ran.plans().journey[row], back.journey[row]);
            assertEquals(ran.plans().status[row], back.status[row]);
            assertEquals(ran.plans().margin[row], figures.margin[row]);
            assertEquals(ran.plans().arrive[row], figures.arrive[row]);
            assertNull(figures.journey[row]);
        }
        assertEquals(PlanStore.fingerprint(t), PlanStore.fingerprint(RulesTest.randomTimetable(new Random(6), 12, 3, 6)));
        assertThrows(IllegalArgumentException.class, () -> PlanStore.read(file, PlanStore.fingerprint(t) + 1));
    }
}
