package gtfseditor.router.gtfs;

import gtfseditor.router.core.Mode;
import gtfseditor.router.core.Timetable;
import java.io.IOException;
import java.nio.file.Path;
import java.time.DateTimeException;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * Reads a GTFS zip into a {@link Timetable} for one service day. Works on the editor's export and
 * on an ordinary feed. See section 6.2 of docs/router-plan.md.
 *
 * <p>The stop times are read into flat number arrays, never into an object per row.
 */
public final class GtfsLoader {

    private final ZipFile zip;
    private final LoadOptions options;
    private final List<String> notes = new ArrayList<>();

    // routes.txt, every row
    private final Map<String, Integer> routeOf = new HashMap<>();
    private final List<String> routeIds = new ArrayList<>();
    private final List<String> routeNames = new ArrayList<>();
    private final IntList routeTypes = new IntList(256);

    // trips.txt, the rows that run on the service day
    private final Map<String, Integer> tripOf = new HashMap<>();
    private final List<String> tripIds = new ArrayList<>();
    private final List<String> tripHeadsigns = new ArrayList<>();
    private final List<String> tripBlocks = new ArrayList<>();
    private final IntList tripRoutes = new IntList(1 << 12);

    // stops.txt, every row, whatever its location type
    private final Map<String, Integer> stopRowOf = new HashMap<>();
    private final List<String> stopRowIds = new ArrayList<>();
    private final List<String> stopRowNames = new ArrayList<>();
    private final List<String> stopRowParents = new ArrayList<>();
    private double[] stopRowLat = new double[1 << 12];
    private double[] stopRowLon = new double[1 << 12];

    // stop_times.txt, the rows of the trips above, in file order
    private final IntList stTrip = new IntList(1 << 16);
    private final IntList stSequence = new IntList(1 << 16);
    private final IntList stStop = new IntList(1 << 16);
    private final IntList stArrive = new IntList(1 << 16);
    private final IntList stDepart = new IntList(1 << 16);
    private final IntList stFlags = new IntList(1 << 16);

    /** Stop-time rows grouped by trip and put in stop order: trip t owns rows[rowStart[t] .. rowStart[t+1]). */
    private int[] rowStart;
    private int[] rows;

    private GtfsLoader(ZipFile zip, LoadOptions options) {
        this.zip = zip;
        this.options = options;
    }

    /**
     * Loads one service day.
     *
     * @throws GtfsException if the feed cannot be used
     * @throws IOException   if the zip cannot be read
     */
    public static Timetable load(Path zipPath, LoadOptions options) throws IOException {
        try (ZipFile zip = new ZipFile(zipPath.toFile())) {
            return new GtfsLoader(zip, options).run();
        }
    }

    private Timetable run() throws IOException {
        readRoutes();
        int date = readServicesAndTrips();
        readStops();
        readStopTimes();
        groupRowsByTrip();
        boolean[] usable = cleanTimes();
        List<int[]> patterns = buildPatterns(usable);
        if (patterns.isEmpty()) {
            throw new GtfsException("no trip on " + date + " has two or more timed stops");
        }
        return assemble(date, patterns);
    }

    private CsvReader open(String name) throws IOException {
        ZipEntry entry = zip.getEntry(name);
        return entry == null ? null : new CsvReader(zip.getInputStream(entry), name);
    }

    private CsvReader need(String name) throws IOException {
        CsvReader reader = open(name);
        if (reader == null) {
            throw new GtfsException("the feed has no " + name);
        }
        return reader;
    }

    private void readRoutes() throws IOException {
        try (CsvReader r = need("routes.txt")) {
            int cId = r.require("route_id");
            int cShort = r.column("route_short_name");
            int cLong = r.column("route_long_name");
            int cType = r.require("route_type");
            while (r.next()) {
                String id = r.text(cId);
                if (routeOf.putIfAbsent(id, routeIds.size()) != null) {
                    throw new GtfsException(r.where() + ": route " + id + " is listed twice");
                }
                routeIds.add(id);
                routeNames.add(r.isEmpty(cShort) ? r.text(cLong) : r.text(cShort));
                routeTypes.add(r.number(cType, 3));
            }
        }
    }

    private record Calendar(String service, boolean[] days, int start, int end) {}

    private record CalendarDate(String service, int date, int type) {}

    /** Picks the service day, works out which services run on it, and reads their trips. */
    private int readServicesAndTrips() throws IOException {
        List<Calendar> calendars = new ArrayList<>();
        List<CalendarDate> exceptions = new ArrayList<>();
        try (CsvReader r = open("calendar.txt")) {
            if (r != null) {
                String[] names = {"monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"};
                int cId = r.require("service_id");
                int cStart = r.require("start_date");
                int cEnd = r.require("end_date");
                int[] cDays = new int[7];
                for (int d = 0; d < 7; d++) {
                    cDays[d] = r.require(names[d]);
                }
                while (r.next()) {
                    boolean[] days = new boolean[7];
                    for (int d = 0; d < 7; d++) {
                        days[d] = r.number(cDays[d], 0) == 1;
                    }
                    calendars.add(new Calendar(r.text(cId), days, r.number(cStart, 0), r.number(cEnd, 0)));
                }
            }
        }
        try (CsvReader r = open("calendar_dates.txt")) {
            if (r != null) {
                int cId = r.require("service_id");
                int cDate = r.require("date");
                int cType = r.require("exception_type");
                while (r.next()) {
                    exceptions.add(new CalendarDate(r.text(cId), r.number(cDate, 0), r.number(cType, 0)));
                }
            }
        }
        if (calendars.isEmpty() && exceptions.isEmpty()) {
            throw new GtfsException("the feed has neither calendar.txt nor calendar_dates.txt");
        }

        int date = options.serviceDate();
        if (date == 0) {
            Set<Integer> dates = new TreeSet<>();
            boolean ranges = false;
            for (Calendar c : calendars) {
                ranges |= c.start != c.end;
                dates.add(c.start);
            }
            for (CalendarDate e : exceptions) {
                dates.add(e.date);
            }
            if (ranges || dates.size() != 1) {
                throw new GtfsException("the feed covers more than one day, so a service date must be given");
            }
            date = dates.iterator().next();
        }
        int weekday;
        try {
            weekday = LocalDate.of(date / 10000, date / 100 % 100, date % 100).getDayOfWeek().getValue() - 1;
        } catch (DateTimeException e) {
            throw new GtfsException(date + " is not a date; write it as year, month, day, for example 20261117");
        }
        Set<String> running = new HashSet<>();
        for (Calendar c : calendars) {
            if (c.start <= date && date <= c.end && c.days[weekday]) {
                running.add(c.service);
            }
        }
        for (CalendarDate e : exceptions) {
            if (e.date == date && e.type == 1) {
                running.add(e.service);
            } else if (e.date == date && e.type == 2) {
                running.remove(e.service);
            }
        }

        Map<String, String> headsigns = new HashMap<>();
        try (CsvReader r = need("trips.txt")) {
            int cRoute = r.require("route_id");
            int cService = r.require("service_id");
            int cTrip = r.require("trip_id");
            int cHeadsign = r.column("trip_headsign");
            int cBlock = r.column("block_id");
            while (r.next()) {
                if (!running.contains(r.text(cService))) {
                    continue;
                }
                String id = r.text(cTrip);
                Integer route = routeOf.get(r.text(cRoute));
                if (route == null) {
                    throw new GtfsException(r.where() + ": trip " + id + " is on a route that is not in routes.txt");
                }
                if (tripOf.putIfAbsent(id, tripIds.size()) != null) {
                    throw new GtfsException(r.where() + ": trip " + id + " is listed twice");
                }
                tripIds.add(id);
                tripRoutes.add(route);
                tripHeadsigns.add(headsigns.computeIfAbsent(r.text(cHeadsign), text -> text));
                tripBlocks.add(r.isEmpty(cBlock) ? null : r.text(cBlock));
            }
        }
        if (tripIds.isEmpty()) {
            throw new GtfsException("no trips run on " + date);
        }
        return date;
    }

    private void readStops() throws IOException {
        try (CsvReader r = need("stops.txt")) {
            int cId = r.require("stop_id");
            int cName = r.column("stop_name");
            int cLat = r.column("stop_lat");
            int cLon = r.column("stop_lon");
            int cParent = r.column("parent_station");
            while (r.next()) {
                String id = r.text(cId);
                int row = stopRowIds.size();
                if (stopRowOf.putIfAbsent(id, row) != null) {
                    throw new GtfsException(r.where() + ": stop " + id + " is listed twice");
                }
                if (row == stopRowLat.length) {
                    stopRowLat = Arrays.copyOf(stopRowLat, row * 2);
                    stopRowLon = Arrays.copyOf(stopRowLon, row * 2);
                }
                stopRowIds.add(id);
                stopRowNames.add(r.text(cName));
                stopRowParents.add(r.isEmpty(cParent) ? null : r.text(cParent));
                // Walkway points inside a station may have no position; only stops trips call at need one.
                stopRowLat[row] = r.isEmpty(cLat) ? Double.NaN : r.decimal(cLat);
                stopRowLon[row] = r.isEmpty(cLon) ? Double.NaN : r.decimal(cLon);
            }
        }
    }

    private void readStopTimes() throws IOException {
        try (CsvReader r = need("stop_times.txt")) {
            int cTrip = r.require("trip_id");
            int cArrive = r.column("arrival_time");
            int cDepart = r.column("departure_time");
            int cStop = r.require("stop_id");
            int cSequence = r.require("stop_sequence");
            int cPickup = r.column("pickup_type");
            int cDropOff = r.column("drop_off_type");
            String lastId = null;
            int lastTrip = -1;
            while (r.next()) {
                // Rows of one trip usually sit together, so the trip is looked up once per run of rows.
                if (lastId == null || !r.matches(cTrip, lastId)) {
                    lastId = r.text(cTrip);
                    lastTrip = tripOf.getOrDefault(lastId, -1);
                }
                if (lastTrip < 0) {
                    continue; // the trip does not run on this day
                }
                Integer stop = stopRowOf.get(r.text(cStop));
                if (stop == null) {
                    throw new GtfsException(r.where() + ": stop " + r.text(cStop) + " is not in stops.txt");
                }
                int flags = (r.number(cPickup, 0) == 1 ? 0 : Timetable.BOARD)
                        | (r.number(cDropOff, 0) == 1 ? 0 : Timetable.ALIGHT);
                stTrip.add(lastTrip);
                stSequence.add(r.number(cSequence, 0));
                stStop.add(stop);
                stArrive.add(r.seconds(cArrive));
                stDepart.add(r.seconds(cDepart));
                stFlags.add(flags);
            }
        }
    }

    /** A counting sort by trip, then each trip's few rows are put in stop order. */
    private void groupRowsByTrip() {
        int trips = tripIds.size();
        int count = stTrip.size;
        rowStart = new int[trips + 1];
        for (int i = 0; i < count; i++) {
            rowStart[stTrip.get(i) + 1]++;
        }
        for (int t = 0; t < trips; t++) {
            rowStart[t + 1] += rowStart[t];
        }
        rows = new int[count];
        int[] next = rowStart.clone();
        for (int i = 0; i < count; i++) {
            rows[next[stTrip.get(i)]++] = i;
        }
        int[] sequence = stSequence.values;
        for (int t = 0; t < trips; t++) {
            for (int i = rowStart[t] + 1; i < rowStart[t + 1]; i++) {
                int row = rows[i];
                int j = i;
                while (j > rowStart[t] && sequence[rows[j - 1]] > sequence[row]) {
                    rows[j] = rows[j - 1];
                    j--;
                }
                rows[j] = row;
            }
        }
    }

    /**
     * Fills in times the feed leaves out and decides which trips can be used. A trip is left out
     * if it has fewer than two stops, no time at its first or last stop, or times that go backwards.
     */
    private boolean[] cleanTimes() {
        int trips = tripIds.size();
        int[] arrive = stArrive.values;
        int[] depart = stDepart.values;
        boolean[] usable = new boolean[trips];
        int tooShort = 0;
        int untimed = 0;
        int backwards = 0;
        int filled = 0;
        for (int t = 0; t < trips; t++) {
            int start = rowStart[t];
            int end = rowStart[t + 1];
            if (end - start < 2) {
                tooShort++;
                continue;
            }
            for (int i = start; i < end; i++) {
                int row = rows[i];
                if (arrive[row] < 0) {
                    arrive[row] = depart[row];
                }
                if (depart[row] < 0) {
                    depart[row] = arrive[row];
                }
            }
            if (arrive[rows[start]] < 0 || arrive[rows[end - 1]] < 0) {
                untimed++;
                continue;
            }
            // Stops with no time at all are spread evenly between the timed stops either side.
            for (int i = start + 1; i < end - 1; i++) {
                if (arrive[rows[i]] >= 0) {
                    continue;
                }
                int j = i;
                while (arrive[rows[j]] < 0) {
                    j++;
                }
                long before = depart[rows[i - 1]];
                long after = arrive[rows[j]];
                int steps = j - i + 1;
                for (int k = i; k < j; k++) {
                    int time = (int) (before + (after - before) * (k - i + 1) / steps);
                    arrive[rows[k]] = time;
                    depart[rows[k]] = time;
                    filled++;
                }
                i = j;
            }
            boolean forwards = true;
            int previous = Integer.MIN_VALUE;
            for (int i = start; i < end && forwards; i++) {
                int row = rows[i];
                forwards = arrive[row] >= previous && depart[row] >= arrive[row];
                previous = depart[row];
            }
            if (!forwards) {
                backwards++;
                continue;
            }
            usable[t] = true;
        }
        if (tooShort > 0) {
            notes.add(count(tooShort) + " trips have fewer than two stop times and were left out");
        }
        if (untimed > 0) {
            notes.add(count(untimed) + " trips have no time at their first or last stop and were left out");
        }
        if (backwards > 0) {
            notes.add(count(backwards) + " trips have times that go backwards and were left out");
        }
        if (filled > 0) {
            notes.add(count(filled) + " stop times had no time and were spread evenly between their neighbours");
        }
        return usable;
    }

    /** A trip's kind of vehicle, stops and pick-up and set-down flags, compared as a whole. */
    private final class Sequence {
        private final int trip;
        private final int hash;

        Sequence(int trip) {
            this.trip = trip;
            int h = 17 + mode(trip);
            for (int i = rowStart[trip]; i < rowStart[trip + 1]; i++) {
                h = 31 * (31 * h + stStop.get(rows[i])) + stFlags.get(rows[i]);
            }
            hash = h;
        }

        @Override
        public int hashCode() {
            return hash;
        }

        @Override
        public boolean equals(Object other) {
            if (!(other instanceof Sequence that) || that.hash != hash || mode(that.trip) != mode(trip)) {
                return false;
            }
            int length = rowStart[trip + 1] - rowStart[trip];
            if (rowStart[that.trip + 1] - rowStart[that.trip] != length) {
                return false;
            }
            for (int i = 0; i < length; i++) {
                int mine = rows[rowStart[trip] + i];
                int theirs = rows[rowStart[that.trip] + i];
                if (stStop.get(mine) != stStop.get(theirs) || stFlags.get(mine) != stFlags.get(theirs)) {
                    return false;
                }
            }
            return true;
        }
    }

    private int mode(int trip) {
        return Mode.ofRouteType(routeTypes.get(tripRoutes.get(trip))).ordinal();
    }

    /**
     * Groups trips with the same kind of vehicle, stops and flags, then splits each group so that within a pattern
     * every trip is at or after the one before it at every stop. Each pattern is returned as its
     * trips in time order.
     */
    private List<int[]> buildPatterns(boolean[] usable) {
        Map<Sequence, IntList> groups = new LinkedHashMap<>();
        for (int t = 0; t < usable.length; t++) {
            if (usable[t]) {
                groups.computeIfAbsent(new Sequence(t), k -> new IntList(4)).add(t);
            }
        }
        List<int[]> patterns = new ArrayList<>();
        for (IntList group : groups.values()) {
            Integer[] inOrder = new Integer[group.size];
            for (int i = 0; i < group.size; i++) {
                inOrder[i] = group.get(i);
            }
            Arrays.sort(inOrder, this::compareTimes);
            List<IntList> parts = new ArrayList<>();
            for (int trip : inOrder) {
                IntList home = null;
                for (IntList part : parts) {
                    if (follows(part.last(), trip)) {
                        home = part;
                        break;
                    }
                }
                if (home == null) {
                    home = new IntList(4);
                    parts.add(home);
                }
                home.add(trip);
            }
            for (IntList part : parts) {
                patterns.add(part.toArray());
            }
        }
        return patterns;
    }

    /** Orders two trips of one group by their times, stop by stop; file order settles a tie. */
    private int compareTimes(int a, int b) {
        int length = rowStart[a + 1] - rowStart[a];
        for (int i = 0; i < length; i++) {
            int rowA = rows[rowStart[a] + i];
            int rowB = rows[rowStart[b] + i];
            int order = Integer.compare(stDepart.get(rowA), stDepart.get(rowB));
            if (order == 0) {
                order = Integer.compare(stArrive.get(rowA), stArrive.get(rowB));
            }
            if (order != 0) {
                return order;
            }
        }
        return Integer.compare(a, b);
    }

    /** Whether the later trip is at or after the earlier one at every stop. */
    private boolean follows(int earlier, int later) {
        int length = rowStart[earlier + 1] - rowStart[earlier];
        for (int i = 0; i < length; i++) {
            int rowA = rows[rowStart[earlier] + i];
            int rowB = rows[rowStart[later] + i];
            if (stArrive.get(rowB) < stArrive.get(rowA) || stDepart.get(rowB) < stDepart.get(rowA)) {
                return false;
            }
        }
        return true;
    }

    private Timetable assemble(int date, List<int[]> patterns) throws IOException {
        Timetable.Builder b = new Timetable.Builder();
        b.serviceDate = date;
        b.transferSettings = options.transfers();
        b.capacityFactor = options.capacityFactor();
        b.feedVersion = readFeedVersion();

        // Sizes.
        int patternCount = patterns.size();
        b.patternStopOffset = new int[patternCount + 1];
        b.patternTripOffset = new int[patternCount + 1];
        long times = 0;
        for (int p = 0; p < patternCount; p++) {
            int[] members = patterns.get(p);
            int length = rowStart[members[0] + 1] - rowStart[members[0]];
            b.patternStopOffset[p + 1] = b.patternStopOffset[p] + length;
            b.patternTripOffset[p + 1] = b.patternTripOffset[p] + members.length;
            times += (long) length * members.length;
        }
        if (times > Integer.MAX_VALUE) {
            throw new GtfsException("the day has more stop times than the router can hold");
        }
        int tripCount = b.patternTripOffset[patternCount];

        // Stops that the kept trips use are numbered by where they are on the map; routes in file order.
        int[] stopOfRow = new int[stopRowIds.size()];
        int[] routeOfRow = new int[routeIds.size()];
        Arrays.fill(stopOfRow, -1);
        Arrays.fill(routeOfRow, -1);
        for (int[] members : patterns) {
            for (int i = rowStart[members[0]]; i < rowStart[members[0] + 1]; i++) {
                stopOfRow[stStop.get(rows[i])] = 0;
            }
            for (int trip : members) {
                routeOfRow[tripRoutes.get(trip)] = 0;
            }
        }
        int stopCount = numberByPlace(stopOfRow);
        int routeCount = number(routeOfRow);
        fillStops(b, stopOfRow, stopCount);
        b.routeIds = new String[routeCount];
        b.routeNames = new String[routeCount];
        b.routeTypes = new int[routeCount];
        for (int row = 0; row < routeOfRow.length; row++) {
            if (routeOfRow[row] >= 0) {
                b.routeIds[routeOfRow[row]] = routeIds.get(row);
                b.routeNames[routeOfRow[row]] = routeNames.get(row);
                b.routeTypes[routeOfRow[row]] = routeTypes.get(row);
            }
        }

        // Patterns, trips and times.
        b.patternStops = new int[b.patternStopOffset[patternCount]];
        b.patternStopFlags = new byte[b.patternStops.length];
        b.arrive = new int[(int) times];
        b.depart = new int[(int) times];
        b.tripIds = new String[tripCount];
        b.tripHeadsigns = new String[tripCount];
        b.tripRoute = new int[tripCount];
        int[] finalTrip = new int[tripIds.size()];
        Arrays.fill(finalTrip, -1);
        int[] patternOfTrip = new int[tripCount];
        String[] blocks = new String[tripCount];
        int trip = 0;
        int time = 0;
        for (int p = 0; p < patternCount; p++) {
            int[] members = patterns.get(p);
            int first = members[0];
            int length = rowStart[first + 1] - rowStart[first];
            for (int i = 0; i < length; i++) {
                int row = rows[rowStart[first] + i];
                b.patternStops[b.patternStopOffset[p] + i] = stopOfRow[stStop.get(row)];
                b.patternStopFlags[b.patternStopOffset[p] + i] = (byte) stFlags.get(row);
            }
            for (int member : members) {
                finalTrip[member] = trip;
                patternOfTrip[trip] = p;
                b.tripIds[trip] = tripIds.get(member);
                b.tripHeadsigns[trip] = tripHeadsigns.get(member);
                b.tripRoute[trip] = routeOfRow[tripRoutes.get(member)];
                blocks[trip] = tripBlocks.get(member);
                for (int i = 0; i < length; i++) {
                    int row = rows[rowStart[member] + i];
                    b.arrive[time] = stArrive.get(row);
                    b.depart[time] = stDepart.get(row);
                    time++;
                }
                trip++;
            }
        }
        int leftOut = tripIds.size() - tripCount;
        if (leftOut > 0) {
            notes.add(count(tripCount) + " of the day's " + count(tripIds.size()) + " trips were kept");
        }

        readCapacities(b, finalTrip);
        linkStayAboard(b, blocks, patternOfTrip);
        buildTransfers(b, stopOfRow);
        b.notes = notes;
        return b.build();
    }

    /** Replaces each 0 with the next number, leaving -1 alone, and returns how many were numbered. */
    private static int number(int[] marks) {
        int next = 0;
        for (int i = 0; i < marks.length; i++) {
            if (marks[i] >= 0) {
                marks[i] = next++;
            }
        }
        return next;
    }

    /**
     * Numbers the marked stops so that stops close together on the map get numbers close together:
     * each stop's position is turned into one number by interleaving the bits of how far east and
     * how far north it is, and the stops are numbered in that order. The search hops between
     * neighbouring stops constantly, and neighbours in memory are far quicker to reach.
     */
    private int numberByPlace(int[] marks) {
        double south = Double.MAX_VALUE;
        double north = -Double.MAX_VALUE;
        double west = Double.MAX_VALUE;
        double east = -Double.MAX_VALUE;
        int count = 0;
        for (int row = 0; row < marks.length; row++) {
            if (marks[row] >= 0 && !Double.isNaN(stopRowLat[row]) && !Double.isNaN(stopRowLon[row])) {
                south = Math.min(south, stopRowLat[row]);
                north = Math.max(north, stopRowLat[row]);
                west = Math.min(west, stopRowLon[row]);
                east = Math.max(east, stopRowLon[row]);
            }
            count += marks[row] >= 0 ? 1 : 0;
        }
        long[] keys = new long[count];
        int at = 0;
        for (int row = 0; row < marks.length; row++) {
            if (marks[row] < 0) {
                continue;
            }
            long place = 0;
            if (!Double.isNaN(stopRowLat[row]) && !Double.isNaN(stopRowLon[row])) {
                long x = (long) ((stopRowLon[row] - west) / Math.max(1e-9, east - west) * 0xffff);
                long y = (long) ((stopRowLat[row] - south) / Math.max(1e-9, north - south) * 0xffff);
                for (int bit = 0; bit < 16; bit++) {
                    place |= ((x >> bit) & 1) << (2 * bit) | ((y >> bit) & 1) << (2 * bit + 1);
                }
            }
            keys[at++] = (place << 32) | row;
        }
        Arrays.sort(keys);
        for (int i = 0; i < count; i++) {
            marks[(int) keys[i]] = i;
        }
        return count;
    }

    private void fillStops(Timetable.Builder b, int[] stopOfRow, int stopCount) {
        b.stopIds = new String[stopCount];
        b.stopNames = new String[stopCount];
        b.stopLat = new double[stopCount];
        b.stopLon = new double[stopCount];
        b.stopStation = new int[stopCount];
        Map<String, Integer> stationOf = new LinkedHashMap<>();
        List<String> stationNames = new ArrayList<>();
        int[] rowOfStop = new int[stopCount];
        for (int row = 0; row < stopOfRow.length; row++) {
            if (stopOfRow[row] >= 0) {
                rowOfStop[stopOfRow[row]] = row;
            }
        }
        for (int stop = 0; stop < stopCount; stop++) {
            int row = rowOfStop[stop];
            if (Double.isNaN(stopRowLat[row]) || Double.isNaN(stopRowLon[row])) {
                throw new GtfsException("stop " + stopRowIds.get(row) + " is used by a trip but has no position");
            }
            b.stopIds[stop] = stopRowIds.get(row);
            b.stopNames[stop] = stopRowNames.get(row);
            b.stopLat[stop] = stopRowLat[row];
            b.stopLon[stop] = stopRowLon[row];
            String parent = stopRowParents.get(row);
            if (parent == null) {
                b.stopStation[stop] = -1;
                continue;
            }
            Integer station = stationOf.get(parent);
            if (station == null) {
                station = stationOf.size();
                stationOf.put(parent, station);
                Integer parentRow = stopRowOf.get(parent);
                stationNames.add(parentRow == null ? "" : stopRowNames.get(parentRow));
            }
            b.stopStation[stop] = station;
        }
        b.stationIds = stationOf.keySet().toArray(String[]::new);
        b.stationNames = stationNames.toArray(String[]::new);
        notes.add(count(stopRowIds.size() - stopCount - stationOf.size())
                + " rows of stops.txt are neither a stop a trip calls at nor such a stop's station, and were left out");
    }

    private String readFeedVersion() throws IOException {
        try (CsvReader r = open("feed_info.txt")) {
            if (r != null && r.next()) {
                return r.text(r.column("feed_version"));
            }
        }
        return "";
    }

    /**
     * Gives every trip a capacity: seated plus standing of its vehicle type from the editor's two
     * files, or its mode's default if the feed names no vehicle.
     */
    private void readCapacities(Timetable.Builder b, int[] finalTrip) throws IOException {
        int tripCount = b.tripIds.length;
        b.tripCapacity = new int[tripCount];
        b.tripCapacityFlags = new byte[tripCount];
        double factor = options.capacityFactor();
        for (int t = 0; t < tripCount; t++) {
            Mode mode = Mode.ofRouteType(b.routeTypes[b.tripRoute[t]]);
            b.tripCapacity[t] = scaled(options.defaultCapacity().get(mode), factor);
            b.tripCapacityFlags[t] = (byte) Timetable.CAPACITY_DEFAULTED;
        }
        Map<String, int[]> types = new HashMap<>(); // id -> capacity, placeholder
        try (CsvReader r = open("editor_vehicle_types.txt")) {
            if (r == null) {
                notes.add("the feed has no vehicle files, so every capacity is its mode's default");
                return;
            }
            int cId = r.require("vehicle_type_id");
            int cSeated = r.require("seated");
            int cStanding = r.require("standing");
            int cPlaceholder = r.column("capacity_is_placeholder");
            while (r.next()) {
                types.put(r.text(cId), new int[] {
                        r.number(cSeated, 0) + r.number(cStanding, 0), r.number(cPlaceholder, 0)});
            }
        }
        try (CsvReader r = open("editor_trip_vehicles.txt")) {
            if (r == null) {
                return;
            }
            int cTrip = r.require("trip_id");
            int cType = r.require("vehicle_type_id");
            int cAssumed = r.column("vehicle_type_assumed");
            while (r.next()) {
                int row = tripOf.getOrDefault(r.text(cTrip), -1);
                int trip = row < 0 ? -1 : finalTrip[row];
                int[] type = types.get(r.text(cType));
                if (trip < 0 || type == null || type[0] <= 0) {
                    continue;
                }
                b.tripCapacity[trip] = scaled(type[0], factor);
                b.tripCapacityFlags[trip] = (byte) ((type[1] == 1 ? Timetable.CAPACITY_PLACEHOLDER : 0)
                        | (r.number(cAssumed, 0) == 1 ? Timetable.CAPACITY_TYPE_ASSUMED : 0));
            }
        }
    }

    private static int scaled(int capacity, double factor) {
        return (int) Math.max(1, Math.round(capacity * factor));
    }

    /**
     * Links consecutive trips of a block where the first ends at the stop the second starts from,
     * so passengers may stay aboard.
     */
    private void linkStayAboard(Timetable.Builder b, String[] blocks, int[] patternOfTrip) {
        int tripCount = blocks.length;
        b.tripStayAboard = new int[tripCount];
        Arrays.fill(b.tripStayAboard, -1);
        int[] firstTime = new int[tripCount];  // index of the trip's first time
        int[] lastTime = new int[tripCount];
        int at = 0;
        for (int t = 0; t < tripCount; t++) {
            int p = patternOfTrip[t];
            int length = b.patternStopOffset[p + 1] - b.patternStopOffset[p];
            firstTime[t] = at;
            lastTime[t] = at + length - 1;
            at += length;
        }
        Map<String, List<Integer>> byBlock = new LinkedHashMap<>();
        for (int t = 0; t < tripCount; t++) {
            if (blocks[t] != null) {
                byBlock.computeIfAbsent(blocks[t], k -> new ArrayList<>()).add(t);
            }
        }
        int inBlocks = 0;
        int linked = 0;
        for (List<Integer> block : byBlock.values()) {
            inBlocks += block.size();
            block.sort((x, y) -> {
                int order = Integer.compare(b.depart[firstTime[x]], b.depart[firstTime[y]]);
                return order != 0 ? order : Integer.compare(x, y);
            });
            for (int i = 0; i + 1 < block.size(); i++) {
                int earlier = block.get(i);
                int later = block.get(i + 1);
                int endStop = b.patternStops[b.patternStopOffset[patternOfTrip[earlier] + 1] - 1];
                int startStop = b.patternStops[b.patternStopOffset[patternOfTrip[later]]];
                if (endStop == startStop && b.depart[firstTime[later]] >= b.arrive[lastTime[earlier]]) {
                    b.tripStayAboard[earlier] = later;
                    linked++;
                }
            }
        }
        if (inBlocks > 0) {
            notes.add(count(inBlocks) + " trips share a block with another; " + count(linked)
                    + " of them run on into their next trip from the stop where they end");
        }
    }

    private void buildTransfers(Timetable.Builder b, int[] stopOfRow) throws IOException {
        TransferBuilder transfers = new TransferBuilder(options.transfers(), b.stopLat, b.stopLon);
        try (CsvReader r = open("transfers.txt")) {
            if (r != null) {
                transfers.addFeedTransfers(r, stopRowOf, stopOfRow);
            }
        }
        try (CsvReader r = open("pathways.txt")) {
            if (r != null) {
                transfers.addPathways(r, stopRowOf, stopOfRow);
            }
        }
        transfers.addStations(b.stopStation, b.stationIds.length);
        transfers.addNearby();
        TransferBuilder.Result result = transfers.finish();
        b.transferOffset = result.offset();
        b.transferTargets = result.targets();
        b.transferSecs = result.secs();
        b.transferMetres = result.metres();
        notes.addAll(result.notes());
    }

    private static String count(int number) {
        return String.format("%,d", number);
    }
}
