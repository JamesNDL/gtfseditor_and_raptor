package gtfseditor.router.core;

import java.util.List;

/**
 * Replays a journey against the timetable's own stop times and links, to confirm that every
 * boarding and alighting exists, the times join up, and it answers the query it was found for.
 * Shares no code with the search, so it can catch the search's mistakes.
 */
public final class JourneyChecker {

    private JourneyChecker() {}

    /**
     * Returns what is wrong with the journey, or null if nothing is; also that the passenger may
     * board every vehicle they get onto. Staying aboard one that runs on is not boarding.
     */
    public static String problem(Timetable t, Query q, Journey journey, Capacity capacity) {
        String problem = problem(t, q, journey);
        if (problem != null) {
            return problem;
        }
        List<Leg> legs = journey.legs();
        for (int i = 0; i < legs.size(); i++) {
            Leg leg = legs.get(i);
            if (leg.kind() != Leg.Kind.RIDE || capacity.boardable(t, leg.trip(), leg.boardPosition())) {
                continue;
            }
            Leg off = i == 0 ? null : legs.get(i - 1);
            boolean runsOn = off != null && off.kind() == Leg.Kind.RIDE
                    && t.tripStayAboard[off.trip()] == leg.trip() && leg.boardPosition() == 0
                    && off.alightPosition() == t.patternLength(t.tripPattern[off.trip()]) - 1;
            if (!runsOn) {
                return "leg " + i + " boards a trip that is full there, or that the passenger was refused";
            }
        }
        return null;
    }

    /** Returns what is wrong with the journey, or null if nothing is. */
    public static String problem(Timetable t, Query q, Journey journey) {
        List<Leg> legs = journey.legs();
        if (legs.isEmpty()) {
            return "the journey has no legs";
        }
        if (journey.depart() < q.depart() || journey.depart() != legs.get(0).depart()) {
            return "the journey leaves before the time asked for, or not when its first leg does";
        }
        if (journey.arrive() != legs.get(legs.size() - 1).arrive()) {
            return "the journey's arrival is not its last leg's";
        }
        if (journey.rides() == 0) {
            Leg only = legs.get(0);
            boolean direct = legs.size() == 1 && only.kind() == Leg.Kind.WALK && q.directWalkSecs() >= 0
                    && only.depart() == q.depart() && only.arrive() == q.depart() + q.directWalkSecs();
            return direct ? null : "a journey with no ride must be the direct walk";
        }
        if (journey.rides() > q.maxRides()) {
            return "more rides than the query allows";
        }

        int time = q.depart();
        int at = -1;                  // the stop the passenger is at, or -1 at the very start
        Leg.Kind before = null;
        int rides = 0;
        for (int i = 0; i < legs.size(); i++) {
            Leg leg = legs.get(i);
            boolean last = i == legs.size() - 1;
            if (leg.depart() < time || leg.arrive() < leg.depart()) {
                return "leg " + i + " starts before the passenger is there, or ends before it starts";
            }
            switch (leg.kind()) {
                case WALK -> {
                    if (i == 0) {
                        if (!offered(q.access(), leg.toStop(), leg.arrive() - leg.depart())) {
                            return "the first walk is not one the query offers";
                        }
                    } else if (last) {
                        if (before != Leg.Kind.RIDE || leg.fromStop() != at || leg.depart() != time
                                || !offered(q.egress(), at, leg.arrive() - leg.depart())) {
                            return "the last walk is not one the query offers";
                        }
                    } else {
                        return "a walk to or from the network in the middle of the journey";
                    }
                }
                case TRANSFER -> {
                    if (before != Leg.Kind.RIDE || last || legs.get(i + 1).kind() != Leg.Kind.RIDE) {
                        return "leg " + i + " is a walk between rides that is not between two rides";
                    }
                    if (leg.arrive() - leg.depart() > q.maxLinkSecs()) {
                        return "leg " + i + " is a longer walk between stops than the query allows";
                    }
                    if (leg.fromStop() != at || leg.depart() != time
                            || !linked(t, leg.fromStop(), leg.toStop(), leg.arrive() - leg.depart())) {
                        return "leg " + i + " walks a link the timetable does not have";
                    }
                }
                case RIDE -> {
                    String wrong = rideProblem(t, leg);
                    if (wrong != null) {
                        return "leg " + i + ": " + wrong;
                    }
                    if (at < 0 ? !offered(q.access(), leg.fromStop(), 0) : leg.fromStop() != at) {
                        return "leg " + i + " boards at a stop the passenger is not at";
                    }
                    if (before == Leg.Kind.RIDE && leg.depart() < time + q.changeSecs()) {
                        Leg off = legs.get(i - 1);
                        boolean runsOn = t.tripStayAboard[off.trip()] == leg.trip() && leg.boardPosition() == 0
                                && off.alightPosition() == t.patternLength(t.tripPattern[off.trip()]) - 1;
                        if (!runsOn) {
                            return "leg " + i + " leaves too soon after the ride before it for a change";
                        }
                    }
                    if (q.avoid().contains(t.tripMode(leg.trip()))) {
                        return "leg " + i + " rides a kind of vehicle the query avoids";
                    }
                    rides++;
                }
            }
            at = leg.toStop();
            time = leg.arrive();
            before = leg.kind();
        }
        if (before == Leg.Kind.RIDE && !offered(q.egress(), at, 0)) {
            return "the journey ends at a stop that is not the destination";
        }
        return rides == journey.rides() ? null : "the ride count is wrong";
    }

    private static String rideProblem(Timetable t, Leg leg) {
        int trip = leg.trip();
        if (trip < 0 || trip >= t.tripCount()) {
            return "no such trip";
        }
        int pattern = t.tripPattern[trip];
        int board = leg.boardPosition();
        int alight = leg.alightPosition();
        if (board < 0 || alight <= board || alight >= t.patternLength(pattern)) {
            return "the boarding and alighting positions are not in order along the trip";
        }
        int base = t.patternStopOffset[pattern];
        if (t.patternStops[base + board] != leg.fromStop() || t.patternStops[base + alight] != leg.toStop()) {
            return "the trip does not call at those stops in those positions";
        }
        if ((t.patternStopFlags[base + board] & Timetable.BOARD) == 0) {
            return "passengers cannot board at that stop";
        }
        if ((t.patternStopFlags[base + alight] & Timetable.ALIGHT) == 0) {
            return "passengers cannot leave at that stop";
        }
        if (t.depart[t.tripTimeIndex(trip, board)] != leg.depart()
                || t.arrive[t.tripTimeIndex(trip, alight)] != leg.arrive()) {
            return "the times are not the trip's";
        }
        return null;
    }

    private static boolean offered(List<Access> walks, int stop, int secs) {
        for (Access walk : walks) {
            if (walk.stop() == stop && walk.secs() == secs) {
                return true;
            }
        }
        return false;
    }

    private static boolean linked(Timetable t, int from, int to, int secs) {
        for (int j = t.transferOffset[from]; j < t.transferOffset[from + 1]; j++) {
            if (t.transferTargets[j] == to && t.transferSecs[j] == secs) {
                return true;
            }
        }
        return false;
    }
}
