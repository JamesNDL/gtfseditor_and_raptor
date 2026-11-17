package gtfseditor.router.gtfs;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import gtfseditor.router.core.Geo;
import gtfseditor.router.core.Timetable;
import gtfseditor.router.core.TransferSettings;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class TransfersTest {

    @TempDir
    Path folder;

    /**
     * One trip calls at every stop, so all are in use.
     *
     * <ul>
     *   <li>P1 and P2 are platforms of one station, 33 m apart, joined through a walkway point:
     *       40 s then 50 s, either way. A one-way gate also leads from P2 straight to P1 in 20 s.
     *   <li>Q1 and Q2 share a station that has no pathways, 10 m apart.
     *   <li>N has F 200 m to its south and G 300 m to its north; F and G are 500 m apart.
     *   <li>FAR is more than 10 km from everything.
     * </ul>
     */
    private static Feed feed() {
        return new Feed().oneDay()
                .file("routes.txt", "route_id,route_short_name,route_type", "R,1,3")
                .file("trips.txt", "route_id,service_id,trip_id", "R,DAY,T")
                .file("stops.txt",
                        "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station",
                        "ST,Station,-33.0000,151.0,1,",
                        "P1,Platform 1,-33.0000,151.0,0,ST",
                        "P2,Platform 2,-33.0003,151.0,0,ST",
                        "WALK,Concourse,,,3,ST",
                        "SQ,Square,-33.1000,151.0,1,",
                        "Q1,Stand A,-33.10000,151.0,0,SQ",
                        "Q2,Stand B,-33.10009,151.0,0,SQ",
                        "Q3,Stand far away,-33.15000,151.0,0,SQ",
                        "N,Middle,-33.2000,151.0,0,",
                        "F,South,-33.2018,151.0,0,",
                        "G,North,-33.1973,151.0,0,",
                        "FAR,Far,-33.4000,151.0,0,")
                .file("stop_times.txt",
                        "trip_id,arrival_time,departure_time,stop_id,stop_sequence",
                        "T,08:00:00,08:00:00,P1,1",
                        "T,08:01:00,08:01:00,P2,2",
                        "T,08:02:00,08:02:00,Q1,3",
                        "T,08:03:00,08:03:00,Q2,4",
                        "T,08:04:00,08:04:00,G,5",
                        "T,08:05:00,08:05:00,N,6",
                        "T,08:06:00,08:06:00,F,7",
                        "T,08:07:00,08:07:00,FAR,8",
                        "T,08:08:00,08:08:00,Q3,9")
                .file("pathways.txt",
                        "pathway_id,from_stop_id,to_stop_id,pathway_mode,is_bidirectional,traversal_time",
                        "w1,P1,WALK,1,1,40",
                        "w2,WALK,P2,1,1,50",
                        "gate,P2,P1,7,0,20",
                        "lost,P1,NOT_A_STOP,1,1,5");
    }

    private Timetable load(Feed feed, TransferSettings settings) throws Exception {
        return GtfsLoader.load(feed.zip(folder), LoadOptions.defaults().withTransfers(settings));
    }

    /** Seconds to walk from one stop to another, or -1 if there is no link. */
    private static int walk(Timetable t, String from, String to) {
        int a = t.stopIndex(from);
        int b = t.stopIndex(to);
        for (int i = t.transferOffset[a]; i < t.transferOffset[a + 1]; i++) {
            if (t.transferTargets[i] == b) {
                return t.transferSecs[i];
            }
        }
        return -1;
    }

    private static int links(Timetable t, String from) {
        int a = t.stopIndex(from);
        return t.transferOffset[a + 1] - t.transferOffset[a];
    }

    @Test
    void pathwaysAreFollowedThroughWalkwayPoints() throws Exception {
        Timetable t = load(feed(), TransferSettings.defaults());
        assertEquals(90, walk(t, "P1", "P2"));
        assertEquals(20, walk(t, "P2", "P1"), "the one-way gate is quicker, and only that way");
        assertEquals(1, links(t, "P1"));
        assertTrue(t.notes.stream().anyMatch(note -> note.contains("1 pathways name a stop")), t.notes.toString());
    }

    @Test
    void stopsOfOneStationWithoutPathwaysGetTheMinimum() throws Exception {
        Timetable t = load(feed(), TransferSettings.defaults());
        // 10 m would be 11 s of walking plus 30 s; the station minimum is 60 s.
        assertEquals(60, walk(t, "Q1", "Q2"));
        assertEquals(60, walk(t, "Q2", "Q1"));
        // Q3 claims the same station from 5 km away: a mistake in the feed, so no link.
        assertEquals(-1, walk(t, "Q1", "Q3"));
        assertTrue(t.notes.stream().anyMatch(note -> note.contains("2 pairs of stops share a station")),
                t.notes.toString());
    }

    @Test
    void nearbyStopsAreLinkedByDistance() throws Exception {
        Timetable t = load(feed(), TransferSettings.defaults());
        // 200 m x 1.3 / 1.03 m/s = 253 s, plus 30 s.
        assertEquals(283, walk(t, "N", "F"));
        assertEquals(283, walk(t, "F", "N"));
        // 300 m x 1.3 / 1.03 = 379 s, plus 30 s.
        assertEquals(409, walk(t, "N", "G"), 1);
        assertEquals(-1, walk(t, "F", "G"), "500 m is outside the radius");
        assertEquals(0, links(t, "FAR"));
        assertEquals(-1, walk(t, "Q2", "N"));

        int n = t.stopIndex("N");
        assertEquals(t.stopIndex("F"), t.transferTargets[t.transferOffset[n]], "the quickest link is listed first");
        assertEquals(200, t.transferMetres[t.transferOffset[n]], 1);
    }

    @Test
    void theRadiusAndTheLimitPerStopAreSettings() throws Exception {
        Timetable wide = load(feed(), TransferSettings.defaults().withRadiusMetres(600));
        assertTrue(walk(wide, "F", "G") > 0);

        Timetable capped = load(feed(), TransferSettings.defaults().withMaxPerStop(1));
        assertEquals(283, walk(capped, "N", "F"));
        assertEquals(-1, walk(capped, "N", "G"));
        assertEquals(90, walk(capped, "P1", "P2"));
        assertTrue(capped.notes.stream().anyMatch(note -> note.contains("limit of 1 per stop")),
                capped.notes.toString());

        Timetable none = load(feed(), TransferSettings.defaults().withRadiusMetres(0));
        assertEquals(0, links(none, "N"));
        assertEquals(90, walk(none, "P1", "P2"));
        assertEquals(60, walk(none, "Q1", "Q2"));
    }

    @Test
    void theFeedsOwnTransfersWin() throws Exception {
        Feed feed = feed().file("transfers.txt",
                "from_stop_id,to_stop_id,transfer_type,min_transfer_time",
                "N,FAR,2,600",   // a stated time, however far
                "N,F,3,",        // not possible
                "P1,P2,2,45",    // beats the pathway
                "G,N,0,",        // recommended: keeps the walking time
                "ST,SQ,2,300",   // stations, not stops: left out
                "N,N,2,120");    // the same stop: nothing to do
        Timetable t = load(feed, TransferSettings.defaults().withMaxPerStop(1));
        assertEquals(600, walk(t, "N", "FAR"));
        assertEquals(-1, walk(t, "N", "F"));
        assertEquals(283, walk(t, "F", "N"), "only the stated direction is removed");
        assertEquals(45, walk(t, "P1", "P2"));
        assertEquals(20, walk(t, "P2", "P1"));
        assertEquals(409, walk(t, "G", "N"), 1);
        // N is at its limit of 1 with the stated link, so the generated link to G is dropped.
        assertEquals(1, links(t, "N"));
        assertTrue(t.notes.stream().anyMatch(note -> note.contains("transfers.txt: 4 rows used, 1 left out")),
                t.notes.toString());
    }

    @Test
    void distancesAreMeasuredOnTheGlobe() {
        assertEquals(111_195, Geo.metresBetween(-33, 151, -34, 151), 5);
        assertEquals(93_250, Geo.metresBetween(-33, 151, -33, 152), 100);
        assertEquals(0, Geo.metresBetween(-33, 151, -33, 151));
    }
}
