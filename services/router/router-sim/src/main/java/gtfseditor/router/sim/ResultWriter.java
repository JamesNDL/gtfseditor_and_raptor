package gtfseditor.router.sim;

import gtfseditor.router.core.Leg;
import gtfseditor.router.core.Timetable;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.io.Writer;
import java.util.BitSet;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Writes each settled journey to the journeys and legs files and adds it to the run's totals. See
 * section 4.3 of docs/simulator-plan.md. Times are seconds from the start of the service day.
 */
final class ResultWriter implements Sink {

    static final String JOURNEYS_HEADER = "journey_id,part,user_id,people,status,start,depart,arrive,journey_secs,"
            + "rides,boardings,walk_secs,wait_secs,left_behind,rerouted,stops,reference_arrive,later_secs,"
            + "margin_secs,origin_changed,origin_stop_used,origin_walk_metres,destination_changed,"
            + "destination_stop_used,destination_walk_metres,change_reason,own_arrive,own_cost,near_arrive,"
            + "near_cost,no_journey_reason,stranded_stop,stranded_time\n";
    static final String LEGS_HEADER = "journey_id,part,leg,kind,trip_id,route_id,from_stop,to_stop,depart,arrive,"
            + "metres,stay_aboard,people\n";

    /** Sooner or later than the reference by less than this counts as the same. */
    static final int SAME_WITHIN_SECS = 60;

    /** The run's totals. Everything counts people, not rows, unless it says rows. */
    static final class Totals {
        final long[] rows = new long[4];
        final long[] people = new long[4];
        final long[] why = new long[4];
        final long[] minutes = new long[48 * 60 + 1]; // people by journey time, for the median
        long journeySecs;
        long waitSecs;
        long walkSecs;
        long rides;
        long boardings;
        long leftBehindOnce;
        long rerouted;
        long compared;
        long sooner;
        long later;
        long same;
        long soonerSecs;
        long laterSecs;
        long newlyServed;
        long lostService;
        long changedOrigin;
        long changedDestination;
        long changedBecauseGone;
        long changedBecauseBetter;
        long positionRows;
        long legRows;
        long journeyRows;

        /** The journey time, in minutes, that this share of travellers are at or under. */
        double percentile(double share) {
            long wanted = (long) Math.ceil(people[Plans.OK] * share);
            long seen = 0;
            for (int minute = 0; minute < minutes.length; minute++) {
                seen += minutes[minute];
                if (seen >= wanted && seen > 0) {
                    return minute;
                }
            }
            return 0;
        }
    }

    private final Timetable t;
    private final Demand demand;
    private final Plans plans;
    private final Plans reference;
    private final PlaceIndex places;
    private final Writer journeys;
    private final Writer legs;
    private final BitSet seen;
    private final Map<Integer, Integer> parts = new HashMap<>();
    private final StringBuilder line = new StringBuilder(512);
    final Totals totals = new Totals();

    /**
     * @param plans     this run's plans; they must be complete before the first journey is settled
     * @param reference the BAU run's, or null
     */
    ResultWriter(Timetable t, Demand demand, Plans plans, Plans reference, PlaceIndex places, Writer journeys,
            Writer legs) throws IOException {
        this.t = t;
        this.demand = demand;
        this.plans = plans;
        this.reference = reference;
        this.places = places;
        this.journeys = journeys;
        this.legs = legs;
        this.seen = new BitSet(demand.size());
        journeys.write(JOURNEYS_HEADER);
        legs.write(LEGS_HEADER);
    }

    @Override
    public void settled(int row, int people, byte status, List<Leg> travelled, int leftBehind, int strandedStop,
            int strandedTime) {
        int part = 0;
        if (seen.get(row)) {
            part = parts.merge(row, 1, Integer::sum);
        } else {
            seen.set(row);
        }
        int start = demand.start[row];
        int rides = 0;
        int boardings = 0;
        int walking = 0;
        int riding = 0;
        Leg firstRide = null;
        Leg lastRide = null;
        for (Leg leg : travelled) {
            if (leg.kind() == Leg.Kind.RIDE) {
                rides++;
                boardings += leg.stayAboard() ? 0 : 1;
                riding += leg.arrive() - leg.depart();
                firstRide = firstRide == null ? leg : firstRide;
                lastRide = leg;
            } else {
                walking += leg.arrive() - leg.depart();
            }
        }
        boolean ok = status == Plans.OK;
        boolean moved = !travelled.isEmpty();
        int depart = moved ? travelled.get(0).depart() : -1;
        int arrive = ok ? travelled.get(travelled.size() - 1).arrive() : -1;
        int waiting = ok ? arrive - start - walking - riding : -1;
        int origin = demand.origin[row];
        int destination = demand.destination[row];

        // Which stop they used at each end, and whether it is their own.
        Leg firstLeg = moved ? travelled.get(0) : null;
        Leg lastLeg = ok ? travelled.get(travelled.size() - 1) : null;
        boolean originChanged = ok && places.hasOwn(origin)
                && (firstRide == null || !places.isOwn(origin, firstRide.fromStop()));
        boolean destinationChanged = ok && places.hasOwn(destination)
                && (lastRide == null || !places.isOwn(destination, lastRide.toStop()));
        int originWalk = firstLeg != null && firstLeg.kind() == Leg.Kind.WALK ? firstLeg.metres() : 0;
        int destinationWalk = lastLeg != null && lastLeg.kind() == Leg.Kind.WALK && travelled.size() > 1
                ? lastLeg.metres() : 0;
        boolean hasReference = reference != null && reference.status[row] == Plans.OK;
        int later = ok && hasReference ? arrive - reference.arrive[row] : 0;

        totals.rows[status]++;
        totals.people[status] += people;
        totals.journeyRows++;
        if (status == Plans.NO_JOURNEY) {
            totals.why[plans.why[row]] += people;
        }
        if (reference != null) {
            if (ok && reference.status[row] == Plans.NO_JOURNEY) {
                totals.newlyServed += people;
            }
            if (status == Plans.NO_JOURNEY && hasReference) {
                totals.lostService += people;
            }
        }
        if (ok) {
            int secs = arrive - start;
            totals.minutes[Math.min(totals.minutes.length - 1, Math.max(0, secs / 60))] += people;
            totals.journeySecs += (long) secs * people;
            totals.waitSecs += (long) waiting * people;
            totals.walkSecs += (long) walking * people;
            totals.rides += (long) rides * people;
            totals.boardings += (long) boardings * people;
            totals.changedOrigin += originChanged ? people : 0;
            totals.changedDestination += destinationChanged ? people : 0;
            if (originChanged || destinationChanged) {
                totals.changedBecauseGone += plans.reason[row] == Plans.GONE ? people : 0;
                totals.changedBecauseBetter += plans.reason[row] == Plans.BETTER ? people : 0;
            }
            totals.positionRows += plans.reason[row] == Plans.POSITION ? people : 0;
            if (hasReference) {
                totals.compared += people;
                if (later <= -SAME_WITHIN_SECS) {
                    totals.sooner += people;
                    totals.soonerSecs -= (long) later * people;
                } else if (later >= SAME_WITHIN_SECS) {
                    totals.later += people;
                    totals.laterSecs += (long) later * people;
                } else {
                    totals.same += people;
                }
            }
        }
        if (leftBehind > 0) {
            totals.leftBehindOnce += people;
            totals.rerouted += ok ? people : 0;
        }

        String id = demand.journeyId(row);
        line.setLength(0);
        DemandWriter.quoted(line, id).append(',').append(part).append(',');
        DemandWriter.quoted(line, demand.userId(row)).append(',').append(people).append(',')
                .append(Plans.statusName(status)).append(',').append(start).append(',');
        number(depart).append(',');
        number(arrive).append(',');
        number(ok ? arrive - start : -1).append(',');
        line.append(rides).append(',').append(boardings).append(',').append(walking).append(',');
        number(waiting).append(',');
        line.append(leftBehind).append(',').append(leftBehind > 0 && ok ? 1 : 0).append(',')
                .append(plans.arrive[row] < 0 ? "" : plans.near[row] ? "near" : "own")
                .append(',');
        number(hasReference ? reference.arrive[row] : -1).append(',');
        line.append(ok && hasReference ? Integer.toString(later) : "").append(',').append(plans.margin[row])
                .append(',').append(originChanged ? 1 : 0).append(',');
        DemandWriter.quoted(line, firstRide == null || !ok ? "" : t.stopIds[firstRide.fromStop()]).append(',')
                .append(originWalk).append(',').append(destinationChanged ? 1 : 0).append(',');
        DemandWriter.quoted(line, lastRide == null || !ok ? "" : t.stopIds[lastRide.toStop()]).append(',')
                .append(destinationWalk).append(',').append(Plans.reasonName(plans.reason[row])).append(',');
        number(plans.ownArrive[row]).append(',');
        number(plans.ownCost[row]).append(',');
        number(plans.nearArrive[row]).append(',');
        number(plans.nearCost[row]).append(',');
        line.append(status == Plans.NO_JOURNEY ? Plans.whyName(plans.why[row]) : "").append(',');
        DemandWriter.quoted(line, strandedStop < 0 ? "" : t.stopIds[strandedStop]).append(',');
        number(strandedTime).append('\n');
        try {
            journeys.write(line.toString());
            for (int i = 0; i < travelled.size(); i++) {
                Leg leg = travelled.get(i);
                boolean ride = leg.kind() == Leg.Kind.RIDE;
                line.setLength(0);
                DemandWriter.quoted(line, id).append(',').append(part).append(',').append(i).append(',')
                        .append(ride ? "ride" : leg.kind() == Leg.Kind.WALK ? "walk" : "change").append(',');
                DemandWriter.quoted(line, ride ? t.tripIds[leg.trip()] : "").append(',');
                DemandWriter.quoted(line, ride ? t.routeIds[t.tripRoute[leg.trip()]] : "").append(',');
                DemandWriter.quoted(line, leg.fromStop() < 0 ? "" : t.stopIds[leg.fromStop()]).append(',');
                DemandWriter.quoted(line, leg.toStop() < 0 ? "" : t.stopIds[leg.toStop()]).append(',')
                        .append(leg.depart()).append(',').append(leg.arrive()).append(',').append(leg.metres())
                        .append(',').append(leg.stayAboard() ? 1 : 0).append(',').append(people).append('\n');
                legs.write(line.toString());
            }
            totals.legRows += travelled.size();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** A number, or nothing for -1. */
    private StringBuilder number(int value) {
        return value < 0 ? line : line.append(value);
    }
}
