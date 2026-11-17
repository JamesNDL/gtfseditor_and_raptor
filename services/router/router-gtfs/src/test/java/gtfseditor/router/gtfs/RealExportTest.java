package gtfseditor.router.gtfs;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import gtfseditor.router.core.Timetable;
import gtfseditor.router.core.TimetableStats;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

/**
 * Loads the editor's export of the published NSW weekday (17 Nov 2026) and checks it against the
 * counts in the editor's database. Skipped unless the environment variable {@code ROUTER_REAL_ZIP}
 * names the zip, because the file is large and not in the repository.
 */
class RealExportTest {

    @Test
    void thePublishedWeekdayLoadsWithTheDatabasesCounts() throws Exception {
        String named = System.getenv("ROUTER_REAL_ZIP");
        assumeTrue(named != null && !named.isBlank(), "ROUTER_REAL_ZIP is not set");
        Path zip = Path.of(named);
        assumeTrue(Files.isRegularFile(zip), "no file " + zip);

        long started = System.nanoTime();
        Timetable t = GtfsLoader.load(zip, LoadOptions.defaults());
        double seconds = (System.nanoTime() - started) / 1e9;
        TimetableStats s = TimetableStats.of(t);

        assertEquals(20261117, t.serviceDate);
        assertEquals(59_014, s.trips());
        assertEquals(2_001_666, s.stopTimes());
        assertEquals(89_444, s.stops());
        assertEquals(113_400, s.lastArrival());
        assertEquals(0, s.defaultedCapacity(), "every exported trip has a vehicle");
        assertTrue(s.estimatedBytes() < 100L * 1024 * 1024, "timetable over 100 MB: " + s.estimatedBytes());
        assertTrue(seconds < 60, "took " + seconds + " s");

        // Every trip's times are where its id says, compared with the raw file for a few trips.
        int trip = t.tripIndex("0271-002-101-002:1000");
        assertEquals("2155269", t.stopIds[t.patternStops[t.patternStopOffset[t.tripPattern[trip]]]]);
        assertEquals(4 * 3600 + 5 * 60, t.depart[t.tripTimeIndex(trip, 0)]);
        assertEquals(4 * 3600 + 7 * 60, t.arrive[t.tripTimeIndex(trip, 1)]);
        assertEquals(4 * 3600 + 7 * 60 + 30, t.depart[t.tripTimeIndex(trip, 1)]);
        // The first stop of that trip is pick-up only in the feed.
        assertEquals(Timetable.BOARD, t.patternStopFlags[t.patternStopOffset[t.tripPattern[trip]]]);
        assertEquals(1100, t.tripCapacity[trip]);
    }
}
