package gtfseditor.router.sim;

import gtfseditor.router.core.Timetable;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;
import java.util.function.IntPredicate;

/**
 * A set of journeys to simulate: who, from where, to where, setting off when. See section 3 of
 * docs/simulator-plan.md. Held as arrays, one entry per journey, because a day is 1.7 million rows.
 *
 * <p>Each end of a journey is a <em>place</em>: a stop id together with a position. Rows that name
 * the same stop and position share one place, so the work done per place (finding its stops in a
 * timetable) is done once.
 *
 * <p>A demand set never changes; the methods that filter return a new one.
 */
public final class Demand {

    /** Every different user id, in the order first seen. */
    public final String[] users;
    /** Who makes each journey: a position in {@link #users}. */
    public final int[] user;
    /** Each row's id when it is a whole number: the caller's, or the row's number in the file. */
    public final long[] journeyNumber;
    /** Each row's id when it is not a whole number, and null where it is; null if every id is a number. */
    public final String[] journeyText;
    /** When each person tapped on at the origin, in seconds from the start of the service day. */
    public final int[] start;
    /** How many people each row stands for. */
    public final int[] people;
    /** Where each journey starts and ends: positions in the place arrays. */
    public final int[] origin;
    public final int[] destination;

    /** A place's stop or station id; empty for a place that is only a position. */
    public final String[] placeStop;
    /** A place's position, or NaN until {@link #located} has looked the stop up. */
    public final double[] placeLat;
    public final double[] placeLon;

    Demand(String[] users, int[] user, long[] journeyNumber, String[] journeyText, int[] start, int[] people,
            int[] origin, int[] destination, String[] placeStop, double[] placeLat, double[] placeLon) {
        this.users = users;
        this.user = user;
        this.journeyNumber = journeyNumber;
        this.journeyText = journeyText;
        this.start = start;
        this.people = people;
        this.origin = origin;
        this.destination = destination;
        this.placeStop = placeStop;
        this.placeLat = placeLat;
        this.placeLon = placeLon;
    }

    /** Number of rows. */
    public int size() {
        return start.length;
    }

    public int placeCount() {
        return placeStop.length;
    }

    public String journeyId(int row) {
        return journeyText != null && journeyText[row] != null ? journeyText[row] : Long.toString(journeyNumber[row]);
    }

    public String userId(int row) {
        return users[user[row]];
    }

    public long totalPeople() {
        long total = 0;
        for (int count : people) {
            total += count;
        }
        return total;
    }

    /** How many different users have a row. */
    public int userCount() {
        boolean[] seen = new boolean[users.length];
        int count = 0;
        for (int u : user) {
            if (!seen[u]) {
                seen[u] = true;
                count++;
            }
        }
        return count;
    }

    /** The rows for which {@code keep} says yes, in the same order. Places are kept as they are. */
    public Demand keeping(IntPredicate keep) {
        int[] rows = new int[size()];
        int kept = 0;
        for (int row = 0; row < size(); row++) {
            if (keep.test(row)) {
                rows[kept++] = row;
            }
        }
        if (kept == size()) {
            return this;
        }
        int[] newUser = new int[kept];
        long[] newNumber = new long[kept];
        String[] newText = journeyText == null ? null : new String[kept];
        int[] newStart = new int[kept];
        int[] newPeople = new int[kept];
        int[] newOrigin = new int[kept];
        int[] newDestination = new int[kept];
        for (int i = 0; i < kept; i++) {
            int row = rows[i];
            newUser[i] = user[row];
            newNumber[i] = journeyNumber[row];
            if (newText != null) {
                newText[i] = journeyText[row];
            }
            newStart[i] = start[row];
            newPeople[i] = people[row];
            newOrigin[i] = origin[row];
            newDestination[i] = destination[row];
        }
        return new Demand(users, newUser, newNumber, newText, newStart, newPeople, newOrigin, newDestination,
                placeStop, placeLat, placeLon);
    }

    /**
     * Gives every place a position. A place that came without one takes its stop's, or for a
     * station id the middle of the station's stops, from this timetable: the published one, so
     * that the position stays true when a scenario later takes the stop away. A row with an end
     * whose stop id the timetable does not have and which gave no position is refused.
     */
    public Demand located(Timetable timetable, DemandReport report) {
        int places = placeCount();
        double[] lat = placeLat.clone();
        double[] lon = placeLon.clone();
        double[] stationLat = null;
        double[] stationLon = null;
        boolean[] unknown = new boolean[places];
        for (int place = 0; place < places; place++) {
            if (!Double.isNaN(lat[place])) {
                continue;
            }
            int stop = timetable.stopIndex(placeStop[place]);
            if (stop >= 0) {
                lat[place] = timetable.stopLat[stop];
                lon[place] = timetable.stopLon[stop];
                continue;
            }
            int station = timetable.stationIndex(placeStop[place]);
            if (station < 0) {
                unknown[place] = true;
                continue;
            }
            if (stationLat == null) {
                stationLat = new double[timetable.stationCount()];
                stationLon = new double[timetable.stationCount()];
                int[] count = new int[timetable.stationCount()];
                for (int s = 0; s < timetable.stopCount(); s++) {
                    int of = timetable.stopStation[s];
                    if (of >= 0) {
                        stationLat[of] += timetable.stopLat[s];
                        stationLon[of] += timetable.stopLon[s];
                        count[of]++;
                    }
                }
                for (int s = 0; s < count.length; s++) {
                    stationLat[s] = count[s] == 0 ? Double.NaN : stationLat[s] / count[s];
                    stationLon[s] = count[s] == 0 ? Double.NaN : stationLon[s] / count[s];
                }
            }
            lat[place] = stationLat[station];
            lon[place] = stationLon[station];
            unknown[place] = Double.isNaN(lat[place]);
        }
        Demand withPositions = new Demand(users, user, journeyNumber, journeyText, start, people, origin,
                destination, placeStop, lat, lon);
        return withPositions.keeping(row -> {
            if (unknown[origin[row]] || unknown[destination[row]]) {
                String id = placeStop[unknown[origin[row]] ? origin[row] : destination[row]];
                report.refuse("a stop id the timetable does not have, and no position given",
                        "journey " + journeyId(row) + ": stop " + id);
                return false;
            }
            return true;
        });
    }

    /** Every {@code oneIn}-th row, each standing for {@code oneIn} times as many people. */
    public Demand share(int oneIn) {
        if (oneIn < 1) {
            throw new IllegalArgumentException("a share of the demand is 1 in 1 or more");
        }
        if (oneIn == 1) {
            return this;
        }
        Demand some = keeping(row -> row % oneIn == 0);
        int[] more = new int[some.size()];
        for (int row = 0; row < more.length; row++) {
            more[row] = Math.multiplyExact(some.people[row], oneIn);
        }
        return new Demand(some.users, some.user, some.journeyNumber, some.journeyText, some.start, more,
                some.origin, some.destination, placeStop, placeLat, placeLon);
    }

    /** Collects rows one at a time. */
    public static final class Builder {

        private final Map<String, Integer> userIndex = new HashMap<>();
        private final Map<String, Integer> placeIndex = new HashMap<>();
        private String[] users = new String[64];
        private String[] placeStop = new String[64];
        private double[] placeLat = new double[64];
        private double[] placeLon = new double[64];
        private int[] user = new int[256];
        private long[] journeyNumber = new long[256];
        private String[] journeyText;
        private int[] start = new int[256];
        private int[] people = new int[256];
        private int[] origin = new int[256];
        private int[] destination = new int[256];
        private int rows;

        /**
         * @param journeyId the row's id, or null for its number counting from 1
         * @param originLat NaN if the file gave no position; the stop's own is found later
         */
        public void add(String userId, String journeyId, int startSecs, String originStop, double originLat,
                double originLon, String destinationStop, double destinationLat, double destinationLon, int count) {
            if (rows == start.length) {
                int larger = rows * 2;
                user = Arrays.copyOf(user, larger);
                journeyNumber = Arrays.copyOf(journeyNumber, larger);
                journeyText = journeyText == null ? null : Arrays.copyOf(journeyText, larger);
                start = Arrays.copyOf(start, larger);
                people = Arrays.copyOf(people, larger);
                origin = Arrays.copyOf(origin, larger);
                destination = Arrays.copyOf(destination, larger);
            }
            Integer known = userIndex.get(userId);
            if (known == null) {
                known = userIndex.size();
                if (known == users.length) {
                    users = Arrays.copyOf(users, known * 2);
                }
                users[known] = userId;
                userIndex.put(userId, known);
            }
            user[rows] = known;
            if (journeyId == null) {
                journeyNumber[rows] = rows + 1L;
            } else if (isPlainNumber(journeyId)) {
                journeyNumber[rows] = Long.parseLong(journeyId);
            } else {
                if (journeyText == null) {
                    journeyText = new String[start.length];
                }
                journeyText[rows] = journeyId;
            }
            start[rows] = startSecs;
            people[rows] = count;
            origin[rows] = place(originStop, originLat, originLon);
            destination[rows] = place(destinationStop, destinationLat, destinationLon);
            rows++;
        }

        private static boolean isPlainNumber(String text) {
            if (text.isEmpty() || text.length() > 18 || (text.length() > 1 && text.charAt(0) == '0')) {
                return false;
            }
            for (int i = 0; i < text.length(); i++) {
                if (text.charAt(i) < '0' || text.charAt(i) > '9') {
                    return false;
                }
            }
            return true;
        }

        private int place(String stop, double lat, double lon) {
            String key = Double.isNaN(lat) ? stop : stop + '\u0000' + lat + ',' + lon;
            Integer known = placeIndex.get(key);
            if (known == null) {
                known = placeIndex.size();
                if (known == placeStop.length) {
                    placeStop = Arrays.copyOf(placeStop, known * 2);
                    placeLat = Arrays.copyOf(placeLat, known * 2);
                    placeLon = Arrays.copyOf(placeLon, known * 2);
                }
                placeStop[known] = stop;
                placeLat[known] = lat;
                placeLon[known] = lon;
                placeIndex.put(key, known);
            }
            return known;
        }

        public int rows() {
            return rows;
        }

        public Demand build() {
            int places = placeIndex.size();
            return new Demand(Arrays.copyOf(users, userIndex.size()), Arrays.copyOf(user, rows),
                    Arrays.copyOf(journeyNumber, rows), journeyText == null ? null : Arrays.copyOf(journeyText, rows),
                    Arrays.copyOf(start, rows), Arrays.copyOf(people, rows), Arrays.copyOf(origin, rows),
                    Arrays.copyOf(destination, rows), Arrays.copyOf(placeStop, places),
                    Arrays.copyOf(placeLat, places), Arrays.copyOf(placeLon, places));
        }
    }
}
