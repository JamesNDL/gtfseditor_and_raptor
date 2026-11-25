package gtfseditor.router.gtfs;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import gtfseditor.router.core.Mode;
import gtfseditor.router.core.Timetable;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class GtfsLoaderTest {

    @TempDir
    Path folder;

    /**
     * Five stops in use (A, C, D, E and, by one trip only, nothing else), one stop nobody uses.
     * T1 and T2 run A, C, D an hour apart. T3 is an express over the same stops that leaves after
     * T1 and arrives before it. T4 runs through C without stopping. T5 and T6 are one bus that
     * runs D to E and then on to A, past midnight. T7 runs on another day. T8 is a loop from A.
     */
    private static Feed feed() {
        return new Feed().oneDay()
                .file("routes.txt",
                        "route_id,route_short_name,route_long_name,route_type",
                        "R1,T1,North Line,2",
                        "R2,,Night Bus,700",
                        "R3,X,Never Runs,700")
                .file("stops.txt",
                        "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station",
                        "S1,Alpha Station,-33.000,151.000,1,",
                        "A,\"Alpha Station, Platform 1\",-33.000,151.000,0,S1",
                        "B,\"Alpha Station, Platform 2\",-33.001,151.000,0,S1",
                        "C,Charlie,-33.020,151.000,0,",
                        "D,Delta,-33.040,151.000,0,",
                        "E,Echo,-33.060,151.000,0,",
                        "U,Unused,-33.080,151.000,0,")
                .file("trips.txt",
                        "route_id,service_id,trip_id,trip_headsign,block_id",
                        "R1,DAY,T2,Delta,",
                        "R1,DAY,T1,Delta,",
                        "R1,DAY,T3,Delta,",
                        "R1,DAY,T4,Delta,",
                        "R2,DAY,T5,Echo,B1",
                        "R2,DAY,T6,Alpha,B1",
                        "R3,OTHER,T7,Nowhere,",
                        "R1,DAY,T8,Loop,")
                .file("stop_times.txt",
                        "trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type",
                        "T2,09:00:00,09:00:00,A,1,0,0",
                        "T2,09:10:00,09:11:00,C,2,0,0",
                        "T2,09:20:00,09:20:00,D,3,0,0",
                        // T1's rows are out of order and split up, as an ordinary feed may have them.
                        "T1,08:20:00,08:20:00,D,30,0,0",
                        "T3,08:05:00,08:05:00,A,1,0,0",
                        "T3,08:09:00,08:09:00,C,2,0,0",
                        "T3,08:15:00,08:15:00,D,3,0,0",
                        "T1,08:00:00,08:00:00,A,10,0,0",
                        "T1,08:10:00,08:11:00,C,20,0,0",
                        "T4,10:00:00,10:00:00,A,1,0,0",
                        "T4,10:10:00,10:10:00,C,2,1,1",
                        "T4,10:20:00,10:20:00,D,3,0,0",
                        "T5,23:50:00,23:50:00,D,1,0,0",
                        "T5,24:30:00,24:30:00,E,2,0,0",
                        "T6,24:35:00,24:35:00,E,1,0,0",
                        "T6,25:00:00,25:00:00,A,2,0,0",
                        "T7,12:00:00,12:00:00,U,1,0,0",
                        "T7,12:10:00,12:10:00,A,2,0,0",
                        "T8,11:00:00,11:00:00,A,1,0,0",
                        "T8,11:10:00,11:10:00,C,2,0,0",
                        "T8,11:20:00,11:20:00,A,3,0,0")
                .file("feed_info.txt",
                        "feed_publisher_name,feed_version",
                        "Test,version 7")
                .file("editor_vehicle_types.txt",
                        "vehicle_type_id,name,mode,cars,seated,standing,fleet_size,capacity_is_placeholder",
                        "1,Train,train,8,800,400,,1",
                        "2,Measured train,train,4,300,150,,0")
                .file("editor_trip_vehicles.txt",
                        "trip_id,vehicle_id,vehicle_label,vehicle_source,vehicle_type_id,vehicle_type_assumed",
                        "T1,5,train 1,inferred,1,1",
                        "T2,6,train 2,feed,2,0",
                        "T7,7,bus 9,feed,1,0");
    }

    private Timetable load(Feed feed) throws Exception {
        return GtfsLoader.load(feed.zip(folder), LoadOptions.defaults());
    }

    @Test
    void keepsOnlyWhatRunsOnTheDay() throws Exception {
        Timetable t = load(feed());
        assertEquals(20261117, t.serviceDate);
        assertEquals("version 7", t.feedVersion);
        assertEquals(7, t.tripCount());
        assertEquals(19, t.stopTimeCount());
        assertEquals(-1, t.tripIndex("T7"));
        // B and U are used by no trip that runs; R3 has no trip that runs.
        assertEquals(Set.of("A", "C", "D", "E"), Set.of(t.stopIds));
        assertArrayEquals(new String[] {"R1", "R2"}, t.routeIds);
        assertArrayEquals(new String[] {"T1", "Night Bus"}, t.routeNames);
        assertEquals("Alpha Station, Platform 1", t.stopNames[t.stopIndex("A")]);
        assertEquals(-33.02, t.stopLat[t.stopIndex("C")]);
    }

    @Test
    void stopsKnowTheirStation() throws Exception {
        Timetable t = load(feed());
        assertArrayEquals(new String[] {"S1"}, t.stationIds);
        assertArrayEquals(new String[] {"Alpha Station"}, t.stationNames);
        assertEquals(0, t.stopStation[t.stopIndex("A")]);
        assertEquals(-1, t.stopStation[t.stopIndex("C")]);
    }

    @Test
    void tripsWithTheSameStopsShareAPatternInTimeOrder() throws Exception {
        Timetable t = load(feed());
        int t1 = t.tripIndex("T1");
        int t2 = t.tripIndex("T2");
        int pattern = t.tripPattern[t1];
        assertEquals(pattern, t.tripPattern[t2]);
        assertEquals(2, t.patternTripCount(pattern));
        assertEquals(t1 + 1, t2, "the 08:00 trip comes before the 09:00 one, whatever the file order");

        int a = t.stopIndex("A");
        int c = t.stopIndex("C");
        int d = t.stopIndex("D");
        int from = t.patternStopOffset[pattern];
        assertArrayEquals(new int[] {a, c, d}, Arrays.copyOfRange(t.patternStops, from, from + 3));
        assertEquals(8 * 3600, t.depart[t.timeIndex(pattern, 0, 0)]);
        assertEquals(8 * 3600 + 600, t.arrive[t.timeIndex(pattern, 0, 1)]);
        assertEquals(8 * 3600 + 660, t.depart[t.timeIndex(pattern, 0, 1)]);
        assertEquals(9 * 3600 + 1200, t.arrive[t.timeIndex(pattern, 1, 2)]);
    }

    @Test
    void anOvertakingTripGetsItsOwnPattern() throws Exception {
        Timetable t = load(feed());
        int express = t.tripPattern[t.tripIndex("T3")];
        assertNotEquals(t.tripPattern[t.tripIndex("T1")], express);
        assertEquals(1, t.patternTripCount(express));
        assertEquals(3, t.patternLength(express));
    }

    @Test
    void aRunThroughStopCannotBeBoardedOrLeft() throws Exception {
        Timetable t = load(feed());
        int pattern = t.tripPattern[t.tripIndex("T4")];
        assertNotEquals(t.tripPattern[t.tripIndex("T1")], pattern);
        int from = t.patternStopOffset[pattern];
        assertEquals(Timetable.BOARD | Timetable.ALIGHT, t.patternStopFlags[from]);
        assertEquals(0, t.patternStopFlags[from + 1]);
        assertEquals(Timetable.BOARD | Timetable.ALIGHT, t.patternStopFlags[from + 2]);
    }

    @Test
    void sixPatternsInAll() throws Exception {
        // T1+T2, T3, T4, T5, T6, T8
        assertEquals(6, load(feed()).patternCount());
    }

    @Test
    void timesRunPastMidnight() throws Exception {
        Timetable t = load(feed());
        assertEquals(24 * 3600 + 1800, t.arrive[t.tripTimeIndex(t.tripIndex("T5"), 1)]);
        assertEquals(25 * 3600, t.arrive[t.tripTimeIndex(t.tripIndex("T6"), 1)]);
    }

    @Test
    void tripsOfOneBlockAreLinkedWhereOneEndsAndTheNextStarts() throws Exception {
        Timetable t = load(feed());
        int t5 = t.tripIndex("T5");
        int t6 = t.tripIndex("T6");
        assertEquals(t6, t.tripStayAboard[t5]);
        assertEquals(-1, t.tripStayAboard[t6]);
        assertEquals(-1, t.tripStayAboard[t.tripIndex("T1")]);
    }

    @Test
    void aLoopListsItsPatternTwiceAtTheRepeatedStop() throws Exception {
        Timetable t = load(feed());
        int loop = t.tripPattern[t.tripIndex("T8")];
        int a = t.stopIndex("A");
        int first = -1;
        int second = -1;
        for (int i = t.stopPatternOffset[a]; i < t.stopPatternOffset[a + 1]; i++) {
            if (t.stopPatterns[i] == loop) {
                if (first < 0) {
                    first = t.stopPatternPositions[i];
                } else {
                    second = t.stopPatternPositions[i];
                }
            }
        }
        assertEquals(0, first);
        assertEquals(2, second);
    }

    @Test
    void capacityComesFromTheVehicleFilesOrTheModesDefault() throws Exception {
        Timetable t = load(feed());
        int t1 = t.tripIndex("T1");
        int t2 = t.tripIndex("T2");
        int t3 = t.tripIndex("T3");
        int t5 = t.tripIndex("T5");
        assertEquals(1200, t.tripCapacity[t1]);
        assertEquals(Timetable.CAPACITY_PLACEHOLDER | Timetable.CAPACITY_TYPE_ASSUMED, t.tripCapacityFlags[t1]);
        assertEquals(450, t.tripCapacity[t2]);
        assertEquals(0, t.tripCapacityFlags[t2]);
        assertEquals(1200, t.tripCapacity[t3]);
        assertEquals(Timetable.CAPACITY_DEFAULTED, t.tripCapacityFlags[t3]);
        assertEquals(65, t.tripCapacity[t5]);
        assertEquals(Mode.BUS, t.tripMode(t5));
    }

    @Test
    void theCapacityFactorScalesEveryCapacity() throws Exception {
        Timetable t = GtfsLoader.load(feed().zip(folder), LoadOptions.defaults().withCapacityFactor(0.5));
        assertEquals(600, t.tripCapacity[t.tripIndex("T1")]);
        assertEquals(33, t.tripCapacity[t.tripIndex("T5")]);
        assertEquals(0.5, t.capacityFactor);
    }

    @Test
    void anOrdinaryFeedWithoutVehicleFilesUsesDefaults() throws Exception {
        Timetable t = load(feed().without("editor_vehicle_types.txt").without("editor_trip_vehicles.txt"));
        assertEquals(1200, t.tripCapacity[t.tripIndex("T1")]);
        assertEquals(Timetable.CAPACITY_DEFAULTED, t.tripCapacityFlags[t.tripIndex("T2")]);
        assertTrue(t.notes.stream().anyMatch(note -> note.contains("no vehicle files")), t.notes.toString());
    }

    /** The editor's export says which published trip each trip came from; the router reads by name and ignores it. */
    @Test
    void theOriginTripColumnIsIgnored() throws Exception {
        Timetable t = load(feed().file("editor_trip_vehicles.txt",
                "trip_id,origin_trip_id,vehicle_id,vehicle_label,vehicle_source,vehicle_type_id,vehicle_type_assumed",
                "T1,T1,5,train 1,inferred,1,1",
                "T2,T9,6,train 2,feed,2,0",
                "T7,,7,bus 9,feed,1,0"));
        assertEquals(1200, t.tripCapacity[t.tripIndex("T1")]);
        assertEquals(Timetable.CAPACITY_PLACEHOLDER | Timetable.CAPACITY_TYPE_ASSUMED,
                t.tripCapacityFlags[t.tripIndex("T1")]);
        assertEquals(450, t.tripCapacity[t.tripIndex("T2")]);
        assertEquals(0, t.tripCapacityFlags[t.tripIndex("T2")]);
    }

    @Test
    void aFeedCoveringManyDaysNeedsADate() throws Exception {
        Feed week = feed()
                .file("calendar.txt",
                        "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date",
                        "DAY,1,1,1,1,1,0,0,20261101,20261130",
                        "OTHER,0,0,0,0,0,1,1,20261101,20261130")
                .file("calendar_dates.txt",
                        "service_id,date,exception_type",
                        "DAY,20261118,2",
                        "OTHER,20261118,1");
        Path zip = week.zip(folder);
        GtfsException e = assertThrows(GtfsException.class, () -> GtfsLoader.load(zip, LoadOptions.defaults()));
        assertTrue(e.getMessage().contains("service date"), e.getMessage());

        // A Tuesday: the weekday service.
        assertEquals(7, GtfsLoader.load(zip, LoadOptions.defaults().withServiceDate(20261117)).tripCount());
        // A Saturday: only T7, from the unused stop.
        Timetable saturday = GtfsLoader.load(zip, LoadOptions.defaults().withServiceDate(20261121));
        assertArrayEquals(new String[] {"T7"}, saturday.tripIds);
        assertEquals(Set.of("A", "U"), Set.of(saturday.stopIds));
        // A Wednesday on which the weekday service is cancelled and the weekend one runs instead.
        assertArrayEquals(new String[] {"T7"},
                GtfsLoader.load(zip, LoadOptions.defaults().withServiceDate(20261118)).tripIds);
        // Outside the calendar nothing runs.
        assertThrows(GtfsException.class,
                () -> GtfsLoader.load(zip, LoadOptions.defaults().withServiceDate(20261201)));
        assertThrows(GtfsException.class,
                () -> GtfsLoader.load(zip, LoadOptions.defaults().withServiceDate(20261340)));
    }

    @Test
    void missingTimesAreFilledAndBrokenTripsLeftOut() throws Exception {
        Feed feed = feed()
                .file("trips.txt",
                        "route_id,service_id,trip_id",
                        "R1,DAY,GAPS",
                        "R1,DAY,BACKWARDS",
                        "R1,DAY,ONE_STOP",
                        "R1,DAY,NO_END")
                .file("stop_times.txt",
                        "trip_id,arrival_time,departure_time,stop_id,stop_sequence",
                        "GAPS,,08:00:00,A,1",
                        "GAPS,,,C,2",
                        "GAPS,,,D,3",
                        "GAPS,08:30:00,,E,4",
                        "BACKWARDS,08:00:00,08:00:00,A,1",
                        "BACKWARDS,07:00:00,07:00:00,C,2",
                        "ONE_STOP,08:00:00,08:00:00,A,1",
                        "NO_END,08:00:00,08:00:00,A,1",
                        "NO_END,,,C,2")
                .without("editor_trip_vehicles.txt");
        Timetable t = load(feed);
        assertArrayEquals(new String[] {"GAPS"}, t.tripIds);
        assertArrayEquals(new int[] {28800, 29400, 30000, 30600}, t.arrive);
        assertArrayEquals(new int[] {28800, 29400, 30000, 30600}, t.depart);
        for (String said : new String[] {"fewer than two", "first or last", "go backwards", "spread evenly",
                "1 of the day's 4 trips"}) {
            assertTrue(t.notes.stream().anyMatch(note -> note.contains(said)), said + " not in " + t.notes);
        }
    }

    @Test
    void problemsInTheFeedAreNamed() throws Exception {
        Path noStops = feed().without("stops.txt").zip(folder);
        assertTrue(assertThrows(GtfsException.class, () -> GtfsLoader.load(noStops, LoadOptions.defaults()))
                .getMessage().contains("stops.txt"));

        Path unknownStop = feed().file("stop_times.txt",
                "trip_id,arrival_time,departure_time,stop_id,stop_sequence",
                "T1,08:00:00,08:00:00,A,1",
                "T1,08:10:00,08:10:00,ZZ,2").zip(folder);
        String message = assertThrows(GtfsException.class,
                () -> GtfsLoader.load(unknownStop, LoadOptions.defaults())).getMessage();
        assertTrue(message.contains("ZZ") && message.contains("row 2"), message);

        Path unknownRoute = feed().file("trips.txt",
                "route_id,service_id,trip_id",
                "R9,DAY,T1").zip(folder);
        assertThrows(GtfsException.class, () -> GtfsLoader.load(unknownRoute, LoadOptions.defaults()));
    }
}
