package gtfseditor.router.sim;

import gtfseditor.router.core.Capacity;
import gtfseditor.router.core.Leg;
import gtfseditor.router.core.Timetable;
import java.io.IOException;
import java.io.Writer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Who was where: for every trip at every stop the passengers who boarded, left, were aboard on
 * leaving and were left behind; and for every stop, who was waiting when. See section 4.3 of
 * docs/simulator-plan.md.
 *
 * <p>The per-trip figures are arrays in step with the timetable's stop times. A passenger who
 * stays aboard a vehicle that runs on as another trip is counted as leaving the first trip at its
 * last stop and boarding the second at its first, so that boardings equal alightings on every
 * trip; the figures by stop leave those out, because nobody got on or off there.
 *
 * <p>Not safe to share between threads; the replay runs on one.
 */
public final class Counts {

    private static final int QUARTER = 900;

    private final Timetable t;
    /** Passengers aboard each trip as it leaves each stop. */
    public final int[] load;
    public final int[] boardings;
    public final int[] alightings;
    /** Of the boardings, those by passengers who had just left another vehicle. */
    public final int[] changes;
    /** Passengers who wanted to board and were refused because the vehicle was full. */
    public final int[] leftBehind;
    private final int[] carriedIn;  // per trip: aboard at its first stop from the trip before
    private final int[] carriedOut; // per trip: still aboard after its last stop

    // Waiting at stops, as one number per event: stop, then time, then whether the passengers
    // arrive (1) or go (0), then how many. Sorted, these read as each stop's day in order, with
    // goings before arrivals at the same second.
    private long[] waiting = new long[1 << 12];
    private int waitingCount;

    Counts(Timetable timetable) {
        this.t = timetable;
        int calls = t.stopTimeCount();
        load = new int[calls];
        boardings = new int[calls];
        alightings = new int[calls];
        changes = new int[calls];
        leftBehind = new int[calls];
        carriedIn = new int[t.tripCount()];
        carriedOut = new int[t.tripCount()];
    }

    /** Puts passengers on a ride: aboard from the stop they board at to the one before they leave. */
    void ride(Leg leg, int people, boolean changed) {
        int first = t.tripTimeIndex(leg.trip(), 0);
        boardings[first + leg.boardPosition()] += people;
        alightings[first + leg.alightPosition()] += people;
        if (changed) {
            changes[first + leg.boardPosition()] += people;
        }
        for (int position = leg.boardPosition(); position < leg.alightPosition(); position++) {
            load[first + position] += people;
        }
    }

    /** Keeps passengers aboard a vehicle as it runs on from one trip into the next. */
    void stayAboard(Leg before, Leg leg, int people) {
        ride(leg, people, false);
        carriedOut[before.trip()] += people;
        carriedIn[leg.trip()] += people;
    }

    void leftBehind(int trip, int position, int people) {
        leftBehind[t.tripTimeIndex(trip, position)] += people;
    }

    /** Notes that passengers stood at a stop from one time to another. */
    void waited(int stop, int from, int until, int people) {
        if (until <= from) {
            return;
        }
        for (int left = people; left > 0; left -= 0xffff) {
            int some = Math.min(left, 0xffff);
            if (waitingCount + 2 > waiting.length) {
                waiting = Arrays.copyOf(waiting, waiting.length * 2);
            }
            waiting[waitingCount++] = event(stop, from, true, some);
            waiting[waitingCount++] = event(stop, until, false, some);
        }
    }

    private static long event(int stop, int time, boolean arriving, int people) {
        return ((long) stop << 36) | ((long) Math.min(time, (1 << 19) - 1) << 17) | (arriving ? 1L << 16 : 0) | people;
    }

    /** One trip that is over its limit somewhere. */
    public record Over(int trip, int peakLoad, int limit, int firstStop, int firstTime, int departures) {}

    /**
     * What the loads say about pressure on capacity.
     *
     * @param trips      trips over their limit as they leave at least one stop
     * @param departures departures from a stop over the limit
     * @param worst      the trips furthest over, worst first
     */
    public record Pressure(int trips, int departures, List<Over> worst) {}

    /** Finds the trips whose load is above their limit, when a trip counts as full at a share of its capacity. */
    static Pressure pressure(Timetable t, int[] load, double fullAt, int keep) {
        List<Over> over = new ArrayList<>();
        int departures = 0;
        for (int trip = 0; trip < t.tripCount(); trip++) {
            int limit = Capacity.limit(t, trip, fullAt);
            int first = t.tripTimeIndex(trip, 0);
            int length = t.patternLength(t.tripPattern[trip]);
            int peak = 0;
            int firstOver = -1;
            int count = 0;
            for (int position = 0; position < length; position++) {
                int aboard = load[first + position];
                if (aboard > limit) {
                    count++;
                    firstOver = firstOver < 0 ? position : firstOver;
                }
                peak = Math.max(peak, aboard);
            }
            if (count > 0) {
                departures += count;
                over.add(new Over(trip, peak, limit, t.patternStops[t.patternStopOffset[t.tripPattern[trip]] + firstOver],
                        t.depart[first + firstOver], count));
            }
        }
        over.sort((a, b) -> a.peakLoad() - a.limit() != b.peakLoad() - b.limit()
                ? Integer.compare(b.peakLoad() - b.limit(), a.peakLoad() - a.limit())
                : Integer.compare(a.trip(), b.trip()));
        return new Pressure(over.size(), departures, List.copyOf(over.subList(0, Math.min(keep, over.size()))));
    }

    /** One line's day. */
    public record Line(int route, long boardings, double peakFactor, int tripsOver) {}

    /** The lines with the fullest vehicle, fullest first. */
    List<Line> fullestLines(int keep) {
        long[] boarded = new long[t.routeCount()];
        double[] peak = new double[t.routeCount()];
        int[] tripsOver = new int[t.routeCount()];
        for (int trip = 0; trip < t.tripCount(); trip++) {
            int first = t.tripTimeIndex(trip, 0);
            int length = t.patternLength(t.tripPattern[trip]);
            int route = t.tripRoute[trip];
            int most = 0;
            for (int position = 0; position < length; position++) {
                boarded[route] += boardings[first + position];
                most = Math.max(most, load[first + position]);
            }
            boarded[route] -= carriedIn[trip];
            if (t.tripCapacity[trip] > 0) {
                peak[route] = Math.max(peak[route], (double) most / t.tripCapacity[trip]);
                tripsOver[route] += most >= t.tripCapacity[trip] ? 1 : 0;
            }
        }
        List<Line> lines = new ArrayList<>();
        for (int route = 0; route < t.routeCount(); route++) {
            if (boarded[route] > 0) {
                lines.add(new Line(route, boarded[route], peak[route], tripsOver[route]));
            }
        }
        lines.sort((a, b) -> a.peakFactor() != b.peakFactor() ? Double.compare(b.peakFactor(), a.peakFactor())
                : a.boardings() != b.boardings() ? Long.compare(b.boardings(), a.boardings())
                : Integer.compare(a.route(), b.route()));
        return List.copyOf(lines.subList(0, Math.min(keep, lines.size())));
    }

    /** A stop and how many passengers were left behind there. */
    public record Left(int stop, long people) {}

    /** The stops that left most passengers behind, most first. */
    List<Left> stopsLeavingMost(int keep) {
        long[] left = new long[t.stopCount()];
        for (int pattern = 0; pattern < t.patternCount(); pattern++) {
            int length = t.patternLength(pattern);
            for (int trip = 0; trip < t.patternTripCount(pattern); trip++) {
                int first = t.timeIndex(pattern, trip, 0);
                for (int position = 0; position < length; position++) {
                    left[t.patternStops[t.patternStopOffset[pattern] + position]] += leftBehind[first + position];
                }
            }
        }
        List<Left> stops = new ArrayList<>();
        for (int stop = 0; stop < left.length; stop++) {
            if (left[stop] > 0) {
                stops.add(new Left(stop, left[stop]));
            }
        }
        stops.sort((a, b) -> a.people() != b.people() ? Long.compare(b.people(), a.people())
                : Integer.compare(a.stop(), b.stop()));
        return List.copyOf(stops.subList(0, Math.min(keep, stops.size())));
    }

    public long totalBoardings() {
        long total = 0;
        for (int count : boardings) {
            total += count;
        }
        for (int count : carriedIn) {
            total -= count;
        }
        return total;
    }

    public long totalLeftBehind() {
        long total = 0;
        for (int count : leftBehind) {
            total += count;
        }
        return total;
    }

    /** Every trip at every stop where anything happened. Returns the number of rows written. */
    long writeTripLoads(Writer out) throws IOException {
        out.write("trip_id,position,stop_id,arrive,depart,boardings,alightings,load,left_behind,capacity\n");
        StringBuilder line = new StringBuilder(96);
        long rows = 0;
        for (int trip = 0; trip < t.tripCount(); trip++) {
            int pattern = t.tripPattern[trip];
            int first = t.tripTimeIndex(trip, 0);
            int length = t.patternLength(pattern);
            for (int position = 0; position < length; position++) {
                int at = first + position;
                if (boardings[at] == 0 && alightings[at] == 0 && load[at] == 0 && leftBehind[at] == 0) {
                    continue;
                }
                line.setLength(0);
                DemandWriter.quoted(line, t.tripIds[trip]).append(',').append(position).append(',');
                DemandWriter.quoted(line, t.stopIds[t.patternStops[t.patternStopOffset[pattern] + position]])
                        .append(',').append(t.arrive[at]).append(',').append(t.depart[at]).append(',')
                        .append(boardings[at]).append(',').append(alightings[at]).append(',').append(load[at])
                        .append(',').append(leftBehind[at]).append(',').append(t.tripCapacity[trip]).append('\n');
                out.write(line.toString());
                rows++;
            }
        }
        return rows;
    }

    /**
     * Every stop in every quarter hour in which anything happened there: boardings, alightings,
     * changes between vehicles, passengers left behind, and the most waiting at once. Returns the
     * number of rows written.
     */
    long writeStopActivity(Writer out) throws IOException {
        out.write("stop_id,quarter_start,boardings,alightings,changes,left_behind,max_waiting\n");
        Arrays.sort(waiting, 0, waitingCount);
        int latest = 0;
        for (int time : t.depart) {
            latest = Math.max(latest, time);
        }
        int quarters = latest / QUARTER + 2;
        int[][] figures = new int[quarters][5];
        boolean[] used = new boolean[quarters];
        StringBuilder line = new StringBuilder(64);
        long rows = 0;
        int event = 0;
        for (int stop = 0; stop < t.stopCount(); stop++) {
            boolean any = false;
            for (int j = t.stopPatternOffset[stop]; j < t.stopPatternOffset[stop + 1]; j++) {
                int pattern = t.stopPatterns[j];
                int position = t.stopPatternPositions[j];
                boolean firstStop = position == 0;
                boolean lastStop = position == t.patternLength(pattern) - 1;
                for (int trip = 0; trip < t.patternTripCount(pattern); trip++) {
                    int at = t.timeIndex(pattern, trip, position);
                    int number = t.patternTripOffset[pattern] + trip;
                    int on = boardings[at] - (firstStop ? carriedIn[number] : 0);
                    int off = alightings[at] - (lastStop ? carriedOut[number] : 0);
                    if (on == 0 && off == 0 && leftBehind[at] == 0) {
                        continue;
                    }
                    any = true;
                    int leaving = Math.min(t.depart[at] / QUARTER, quarters - 1);
                    int arriving = Math.min(t.arrive[at] / QUARTER, quarters - 1);
                    figures[leaving][0] += on;
                    figures[arriving][1] += off;
                    figures[leaving][2] += changes[at];
                    figures[leaving][3] += leftBehind[at];
                    used[leaving] = true;
                    used[arriving] = true;
                }
            }
            // The most waiting at once in each quarter: those there as it starts, then each coming and going.
            int there = 0;
            int quarter = 0;
            while (event < waitingCount && (int) (waiting[event] >>> 36) == stop) {
                long e = waiting[event++];
                int time = (int) (e >>> 17) & ((1 << 19) - 1);
                int at = Math.min(time / QUARTER, quarters - 1);
                while (quarter < at) {
                    quarter++;
                    if (there > 0) {
                        figures[quarter][4] = Math.max(figures[quarter][4], there);
                        used[quarter] = true;
                    }
                }
                there += (e & (1L << 16)) != 0 ? (int) (e & 0xffff) : -(int) (e & 0xffff);
                figures[at][4] = Math.max(figures[at][4], there);
                used[at] = true;
                any = true;
            }
            if (!any) {
                continue;
            }
            for (int q = 0; q < quarters; q++) {
                if (!used[q]) {
                    continue;
                }
                int[] f = figures[q];
                if (f[0] != 0 || f[1] != 0 || f[2] != 0 || f[3] != 0 || f[4] != 0) {
                    line.setLength(0);
                    DemandWriter.quoted(line, t.stopIds[stop]).append(',').append(q * QUARTER).append(',')
                            .append(f[0]).append(',').append(f[1]).append(',').append(f[2]).append(',').append(f[3])
                            .append(',').append(f[4]).append('\n');
                    out.write(line.toString());
                    rows++;
                }
                Arrays.fill(f, 0);
                used[q] = false;
            }
        }
        return rows;
    }
}
