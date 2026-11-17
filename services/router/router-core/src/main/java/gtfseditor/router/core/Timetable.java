package gtfseditor.router.core;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * One service day of a timetable, held as flat arrays. See section 5 of docs/router-plan.md.
 *
 * <p>Stops, routes, patterns and trips are numbered from 0. A pattern is a set of trips that call
 * at the same stops in the same order with the same pick-up and set-down rules, and in which no
 * trip overtakes another. Trips are numbered pattern by pattern, in time order within a pattern.
 *
 * <p>A timetable never changes after it is built, so it can be shared between threads. The arrays
 * are public so the search can read them directly; nothing may write to them.
 */
public final class Timetable {

    /** Bit in {@link #patternStopFlags}: passengers may board here. */
    public static final int BOARD = 1;
    /** Bit in {@link #patternStopFlags}: passengers may leave here. */
    public static final int ALIGHT = 2;

    /** Bit in {@link #tripCapacityFlags}: the vehicle type's capacity is a placeholder figure. */
    public static final int CAPACITY_PLACEHOLDER = 1;
    /** Bit in {@link #tripCapacityFlags}: the feed named no vehicle, so the mode's default was used. */
    public static final int CAPACITY_DEFAULTED = 2;
    /** Bit in {@link #tripCapacityFlags}: the editor assumed the vehicle type. */
    public static final int CAPACITY_TYPE_ASSUMED = 4;

    /** The feed's own version text, or empty. */
    public final String feedVersion;
    /** The service day as a number, for example 20261117. */
    public final int serviceDate;
    public final TransferSettings transferSettings;
    /** The factor the capacities were multiplied by when loading. */
    public final double capacityFactor;
    /** Things the loader left out or assumed, in plain words. */
    public final List<String> notes;

    public final String[] stationIds;
    public final String[] stationNames;

    public final String[] stopIds;
    public final String[] stopNames;
    public final double[] stopLat;
    public final double[] stopLon;
    /** The station a stop belongs to, or -1. */
    public final int[] stopStation;

    public final String[] routeIds;
    public final String[] routeNames;
    public final int[] routeTypes;
    private final Mode[] routeModes;

    /** Where each pattern's stops start in {@link #patternStops}; one extra entry at the end. */
    public final int[] patternStopOffset;
    /** The number of each pattern's first trip; one extra entry at the end. */
    public final int[] patternTripOffset;
    /** Where each pattern's times start in {@link #arrive} and {@link #depart}; one extra entry. */
    public final int[] patternTimeOffset;
    public final int[] patternStops;
    /** {@link #BOARD} and {@link #ALIGHT} bits, parallel to {@link #patternStops}. */
    public final byte[] patternStopFlags;
    /** The kind of vehicle each pattern's trips use, as a {@link Mode} position. One kind per pattern. */
    public final byte[] patternMode;

    /** Arrival times in seconds from the start of the service day. See {@link #timeIndex}. */
    public final int[] arrive;
    /** Departure times, parallel to {@link #arrive}. */
    public final int[] depart;
    /**
     * The departure times again, laid out for finding the first trip to catch at a stop: a
     * pattern's trips at its first stop, then its trips at its second stop, and so on. The time for
     * a trip at a position is at {@code patternTimeOffset + position * tripCount + tripInOrder}.
     * Looking along one stop's trips then reads neighbouring memory.
     */
    public final int[] departByPosition;
    /** {@link #stopPatterns} and {@link #stopPatternPositions} as pairs: pattern, position, pattern, ... */
    public final int[] stopVisits;
    /**
     * For each pair in {@link #stopVisits}, when the pattern's last trip leaves that position, or
     * -1 if nobody can board there: the stop is the pattern's last, or it only sets down. A
     * passenger ready to board later than this has nothing to catch.
     */
    public final int[] stopVisitLastDepart;
    /**
     * What the search needs to start along a pattern, four numbers each so that they arrive in one
     * fetch from memory: where its stops start, where its times start, its first trip, and its
     * number of trips. A fifth set at the end closes the last pattern.
     */
    public final int[] patternHead;
    /** {@link #patternStops} and {@link #patternStopFlags} in one number each: stop * 4 + flags. */
    public final int[] patternCalls;
    /** {@link #transferTargets} and {@link #transferSecs} as pairs: target, seconds, target, ... */
    public final int[] transferLinks;

    public final String[] tripIds;
    public final String[] tripHeadsigns;
    public final int[] tripRoute;
    public final int[] tripPattern;
    /** Passengers a trip can carry, already multiplied by {@link #capacityFactor}. */
    public final int[] tripCapacity;
    public final byte[] tripCapacityFlags;
    /** The trip passengers may stay aboard for when this one ends, or -1. */
    public final int[] tripStayAboard;

    /** Where each stop's entries start in {@link #stopPatterns}; one extra entry at the end. */
    public final int[] stopPatternOffset;
    /** The patterns that call at each stop. A pattern that calls twice is listed twice. */
    public final int[] stopPatterns;
    /** The position of the stop within the pattern, parallel to {@link #stopPatterns}. */
    public final int[] stopPatternPositions;

    /** Where each stop's walking links start in {@link #transferTargets}; one extra entry. */
    public final int[] transferOffset;
    public final int[] transferTargets;
    public final int[] transferSecs;
    /** Straight-line distance of each link, in metres. */
    public final int[] transferMetres;

    private volatile Map<String, Integer> stopIndex;
    private volatile Map<String, Integer> tripIndex;
    private volatile Map<String, Integer> stationIndex;

    /** The parts of a timetable that cannot be worked out from the others. */
    public static final class Builder {
        public String feedVersion = "";
        public int serviceDate;
        public TransferSettings transferSettings = TransferSettings.defaults();
        public double capacityFactor = 1.0;
        public List<String> notes = List.of();
        public String[] stationIds = {};
        public String[] stationNames = {};
        public String[] stopIds;
        public String[] stopNames;
        public double[] stopLat;
        public double[] stopLon;
        public int[] stopStation;
        public String[] routeIds;
        public String[] routeNames;
        public int[] routeTypes;
        public int[] patternStopOffset;
        public int[] patternTripOffset;
        public int[] patternStops;
        public byte[] patternStopFlags;
        public int[] arrive;
        public int[] depart;
        public String[] tripIds;
        public String[] tripHeadsigns;
        public int[] tripRoute;
        public int[] tripCapacity;
        public byte[] tripCapacityFlags;
        public int[] tripStayAboard;
        public int[] transferOffset;
        public int[] transferTargets;
        public int[] transferSecs;
        public int[] transferMetres;

        /**
         * Checks the parts against each other and builds the timetable.
         *
         * @throws IllegalArgumentException if the parts do not fit together
         */
        public Timetable build() {
            return new Timetable(this);
        }
    }

    private Timetable(Builder b) {
        feedVersion = b.feedVersion;
        serviceDate = b.serviceDate;
        transferSettings = b.transferSettings;
        capacityFactor = b.capacityFactor;
        notes = List.copyOf(b.notes);
        stationIds = b.stationIds;
        stationNames = b.stationNames;
        stopIds = b.stopIds;
        stopNames = b.stopNames;
        stopLat = b.stopLat;
        stopLon = b.stopLon;
        stopStation = b.stopStation;
        routeIds = b.routeIds;
        routeNames = b.routeNames;
        routeTypes = b.routeTypes;
        patternStopOffset = b.patternStopOffset;
        patternTripOffset = b.patternTripOffset;
        patternStops = b.patternStops;
        patternStopFlags = b.patternStopFlags;
        arrive = b.arrive;
        depart = b.depart;
        tripIds = b.tripIds;
        tripHeadsigns = b.tripHeadsigns;
        tripRoute = b.tripRoute;
        tripCapacity = b.tripCapacity;
        tripCapacityFlags = b.tripCapacityFlags;
        tripStayAboard = b.tripStayAboard;
        transferOffset = b.transferOffset;
        transferTargets = b.transferTargets;
        transferSecs = b.transferSecs;
        transferMetres = b.transferMetres;

        int stops = stopIds.length;
        check(stationNames.length == stationIds.length, "station names");
        check(stopNames.length == stops && stopLat.length == stops && stopLon.length == stops
                && stopStation.length == stops, "stop arrays differ in length");
        for (int station : stopStation) {
            check(station >= -1 && station < stationIds.length, "a stop names a station that does not exist");
        }
        int routes = routeIds.length;
        check(routeNames.length == routes && routeTypes.length == routes, "route arrays differ in length");
        routeModes = new Mode[routes];
        for (int r = 0; r < routes; r++) {
            routeModes[r] = Mode.ofRouteType(routeTypes[r]);
        }

        int patterns = patternStopOffset.length - 1;
        check(patterns >= 0 && patternTripOffset.length == patterns + 1, "pattern offsets differ in length");
        check(patternStopOffset[0] == 0 && patternTripOffset[0] == 0, "pattern offsets do not start at 0");
        check(patternStopOffset[patterns] == patternStops.length
                && patternStopFlags.length == patternStops.length, "pattern stops do not match their offsets");
        int trips = patternTripOffset[patterns];
        check(tripIds.length == trips && tripHeadsigns.length == trips && tripRoute.length == trips
                && tripCapacity.length == trips && tripCapacityFlags.length == trips
                && tripStayAboard.length == trips, "trip arrays do not match the pattern offsets");
        for (int stop : patternStops) {
            check(stop >= 0 && stop < stops, "a pattern calls at a stop that does not exist");
        }

        patternTimeOffset = new int[patterns + 1];
        patternMode = new byte[patterns];
        tripPattern = new int[trips];
        for (int t = 0; t < trips; t++) {
            check(tripRoute[t] >= 0 && tripRoute[t] < routes, "a trip names a route that does not exist");
        }
        for (int p = 0; p < patterns; p++) {
            int length = patternStopOffset[p + 1] - patternStopOffset[p];
            int count = patternTripOffset[p + 1] - patternTripOffset[p];
            check(length >= 2 && count >= 1, "a pattern has fewer than two stops or no trips");
            long next = patternTimeOffset[p] + (long) length * count;
            check(next <= arrive.length, "there are fewer stop times than the patterns need");
            patternTimeOffset[p + 1] = (int) next;
            patternMode[p] = (byte) routeModes[tripRoute[patternTripOffset[p]]].ordinal();
            for (int t = patternTripOffset[p]; t < patternTripOffset[p + 1]; t++) {
                tripPattern[t] = p;
                check(routeModes[tripRoute[t]].ordinal() == patternMode[p], "a pattern mixes kinds of vehicle");
            }
            checkTimes(p, length, count);
        }
        check(arrive.length == patternTimeOffset[patterns] && depart.length == arrive.length,
                "there are more stop times than the patterns need");
        for (int t = 0; t < trips; t++) {
            check(tripRoute[t] >= 0 && tripRoute[t] < routes, "a trip names a route that does not exist");
            check(tripStayAboard[t] >= -1 && tripStayAboard[t] < trips, "a stay-aboard link is out of range");
        }

        check(transferOffset.length == stops + 1 && transferOffset[0] == 0
                && transferOffset[stops] == transferTargets.length
                && transferSecs.length == transferTargets.length
                && transferMetres.length == transferTargets.length, "transfers do not match their offsets");
        for (int s = 0; s < stops; s++) {
            check(transferOffset[s] <= transferOffset[s + 1], "transfer offsets go backwards");
        }
        for (int i = 0; i < transferTargets.length; i++) {
            check(transferTargets[i] >= 0 && transferTargets[i] < stops && transferSecs[i] >= 0,
                    "a transfer is out of range");
        }

        patternHead = new int[patterns * 4 + 4];
        for (int p = 0; p <= patterns; p++) {
            patternHead[p * 4] = patternStopOffset[p];
            patternHead[p * 4 + 1] = patternTimeOffset[p];
            patternHead[p * 4 + 2] = patternTripOffset[p];
            patternHead[p * 4 + 3] = p < patterns ? patternTripOffset[p + 1] - patternTripOffset[p] : 0;
        }
        check(stops < 1 << 29, "more stops than the search can number");
        patternCalls = new int[patternStops.length];
        for (int i = 0; i < patternStops.length; i++) {
            patternCalls[i] = patternStops[i] * 4 + (patternStopFlags[i] & 3);
        }
        transferLinks = new int[transferTargets.length * 2];
        for (int i = 0; i < transferTargets.length; i++) {
            transferLinks[i * 2] = transferTargets[i];
            transferLinks[i * 2 + 1] = transferSecs[i];
        }
        departByPosition = new int[depart.length];
        for (int p = 0; p < patterns; p++) {
            int length = patternStopOffset[p + 1] - patternStopOffset[p];
            int count = patternTripOffset[p + 1] - patternTripOffset[p];
            int base = patternTimeOffset[p];
            for (int trip = 0; trip < count; trip++) {
                for (int i = 0; i < length; i++) {
                    departByPosition[base + i * count + trip] = depart[base + trip * length + i];
                }
            }
        }

        // The patterns at each stop, by counting and then filling.
        stopPatternOffset = new int[stops + 1];
        for (int stop : patternStops) {
            stopPatternOffset[stop + 1]++;
        }
        for (int s = 0; s < stops; s++) {
            stopPatternOffset[s + 1] += stopPatternOffset[s];
        }
        stopPatterns = new int[patternStops.length];
        stopPatternPositions = new int[patternStops.length];
        int[] next = stopPatternOffset.clone();
        for (int p = 0; p < patterns; p++) {
            for (int i = patternStopOffset[p]; i < patternStopOffset[p + 1]; i++) {
                int slot = next[patternStops[i]]++;
                stopPatterns[slot] = p;
                stopPatternPositions[slot] = i - patternStopOffset[p];
            }
        }
        stopVisits = new int[patternStops.length * 2];
        for (int i = 0; i < patternStops.length; i++) {
            stopVisits[i * 2] = stopPatterns[i];
            stopVisits[i * 2 + 1] = stopPatternPositions[i];
        }
        stopVisitLastDepart = new int[patternStops.length];
        for (int i = 0; i < patternStops.length; i++) {
            int p = stopPatterns[i];
            int position = stopPatternPositions[i];
            int count = patternTripOffset[p + 1] - patternTripOffset[p];
            boolean boards = position < patternStopOffset[p + 1] - patternStopOffset[p] - 1
                    && (patternStopFlags[patternStopOffset[p] + position] & BOARD) != 0;
            stopVisitLastDepart[i] = boards
                    ? departByPosition[patternTimeOffset[p] + position * count + count - 1] : -1;
        }
    }

    /** Times must run forwards along each trip, and no trip may overtake the one before it. */
    private void checkTimes(int pattern, int length, int count) {
        int base = patternTimeOffset[pattern];
        for (int t = 0; t < count; t++) {
            int row = base + t * length;
            for (int i = 0; i < length; i++) {
                int at = row + i;
                check(arrive[at] <= depart[at], "a trip leaves a stop before it arrives");
                check(i == 0 || depart[at - 1] <= arrive[at], "a trip's times go backwards");
                check(t == 0 || (arrive[at - length] <= arrive[at] && depart[at - length] <= depart[at]),
                        "a trip overtakes another in its pattern");
            }
        }
    }

    private static void check(boolean holds, String problem) {
        if (!holds) {
            throw new IllegalArgumentException("the timetable is inconsistent: " + problem);
        }
    }

    public int stationCount() {
        return stationIds.length;
    }

    public int stopCount() {
        return stopIds.length;
    }

    public int routeCount() {
        return routeIds.length;
    }

    public int patternCount() {
        return patternStopOffset.length - 1;
    }

    public int tripCount() {
        return tripIds.length;
    }

    public int stopTimeCount() {
        return arrive.length;
    }

    public int transferCount() {
        return transferTargets.length;
    }

    /** Number of stops a pattern calls at. */
    public int patternLength(int pattern) {
        return patternStopOffset[pattern + 1] - patternStopOffset[pattern];
    }

    /** Number of trips in a pattern. */
    public int patternTripCount(int pattern) {
        return patternTripOffset[pattern + 1] - patternTripOffset[pattern];
    }

    /**
     * Where to find a time in {@link #arrive} and {@link #depart}.
     *
     * @param pattern     the pattern
     * @param tripInOrder the trip's place within the pattern, 0 for the earliest
     * @param position    the stop's place within the pattern
     */
    public int timeIndex(int pattern, int tripInOrder, int position) {
        return patternTimeOffset[pattern] + tripInOrder * patternLength(pattern) + position;
    }

    /** Where to find a time for a trip given by its number. */
    public int tripTimeIndex(int trip, int position) {
        int pattern = tripPattern[trip];
        return timeIndex(pattern, trip - patternTripOffset[pattern], position);
    }

    public Mode routeMode(int route) {
        return routeModes[route];
    }

    public Mode tripMode(int trip) {
        return routeModes[tripRoute[trip]];
    }

    /** The number of the stop with this GTFS id, or -1. */
    public int stopIndex(String stopId) {
        Map<String, Integer> index = stopIndex;
        if (index == null) {
            index = indexOf(stopIds);
            stopIndex = index;
        }
        return index.getOrDefault(stopId, -1);
    }

    /** The number of the trip with this GTFS id, or -1. */
    public int tripIndex(String tripId) {
        Map<String, Integer> index = tripIndex;
        if (index == null) {
            index = indexOf(tripIds);
            tripIndex = index;
        }
        return index.getOrDefault(tripId, -1);
    }

    /** The number of the station with this GTFS id, or -1. */
    public int stationIndex(String stationId) {
        Map<String, Integer> index = stationIndex;
        if (index == null) {
            index = indexOf(stationIds);
            stationIndex = index;
        }
        return index.getOrDefault(stationId, -1);
    }

    private static Map<String, Integer> indexOf(String[] ids) {
        Map<String, Integer> index = HashMap.newHashMap(ids.length);
        for (int i = 0; i < ids.length; i++) {
            index.put(ids[i], i);
        }
        return index;
    }

    /**
     * Roughly how much memory the timetable takes, in bytes. Text shared between trips (headsigns)
     * is counted once per trip, so this errs on the high side.
     */
    public long estimatedBytes() {
        long bytes = 0;
        for (int[] array : new int[][] {stopStation, routeTypes, patternStopOffset, patternTripOffset,
                patternTimeOffset, patternStops, arrive, depart, departByPosition, stopVisits, stopVisitLastDepart,
                patternHead,
                patternCalls, transferLinks, tripRoute, tripPattern, tripCapacity,
                tripStayAboard, stopPatternOffset, stopPatterns, stopPatternPositions, transferOffset,
                transferTargets, transferSecs, transferMetres}) {
            bytes += 16 + 4L * array.length;
        }
        bytes += 2 * (16 + 8L * stopLat.length);
        bytes += 2 * (16L + patternStopFlags.length) + tripCapacityFlags.length;
        for (String[] texts : new String[][] {stationIds, stationNames, stopIds, stopNames, routeIds,
                routeNames, tripIds}) {
            bytes += textBytes(texts);
        }
        bytes += 16 + 4L * tripHeadsigns.length;
        return bytes;
    }

    private static long textBytes(String[] texts) {
        long bytes = 16 + 4L * texts.length;
        for (String text : texts) {
            bytes += 40 + ((text.length() + 7) & ~7);
        }
        return bytes;
    }
}
