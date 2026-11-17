package gtfseditor.router.sim;

import gtfseditor.router.core.Capacity;
import gtfseditor.router.core.Journey;
import gtfseditor.router.core.Leg;
import gtfseditor.router.core.Preferences;
import gtfseditor.router.core.Result;
import gtfseditor.router.core.Router;
import gtfseditor.router.core.Timetable;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;

/**
 * Stage 2: puts the planned journeys on the vehicles. See section 4.2 of docs/simulator-plan.md.
 *
 * <p>With capacity off this only counts: everyone rides what they planned ({@link #count}).
 *
 * <p>With capacity on ({@link #run}) it is one pass through the day in time order:
 *
 * <ol>
 *   <li>Every boarding is an event at the time the vehicle leaves that stop. Events are taken in
 *       order of time; at one stop and vehicle, whoever reached the stop first is first.
 *   <li>A passenger boards if there is room as the vehicle leaves that stop. Everyone aboard at
 *       that moment boarded at or before it, and those leaving at this stop are not counted.
 *   <li>A passenger who boards makes the rest of that ride, and their next boarding becomes an
 *       event. One on a vehicle that runs on as another trip stays aboard whatever its load.
 *   <li>A passenger left behind plans again from that stop at that time with that boarding
 *       refused, not knowing how full anything is. Everyone left behind in the same second is
 *       planned again together, on all threads, one search for each group with the same question.
 *   <li>A passenger left behind more often than the limit, or with no way left, is stranded.
 * </ol>
 *
 * <p>A row standing for several people boards as individuals: if 10 want to board and 4 fit, 4
 * ride on and 6 are left behind and plan again together.
 *
 * <p>The same plans give the same result every time, whatever the number of threads.
 */
final class Replay {

    /** People travelling together from here on: a row of the demand, or part of one. */
    private static final class Party {
        int row;
        int people;
        List<Leg> legs;   // what they have travelled and what they plan to
        int next;         // the ride they are waiting to board: a place in legs
        int time;         // when that ride leaves
        int at;           // that ride's boarding, as a place in the timetable's stop times
        int ready;        // when they reached the stop they are waiting at
        boolean rode;     // whether they have been on a vehicle yet
        int leftBehind;
        int[] refused = NO_REFUSALS; // boardings refused them: trip, position, trip, position, ...
        long order;       // settles ties, so that the same run always goes the same way
    }

    private static final int[] NO_REFUSALS = {};

    private final Router router;
    private final Timetable t;
    private final Demand demand;
    private final PlaceIndex places;
    private final Plans plans;
    private final SimSettings settings;
    private final Preferences preferences;
    private final Sink sink;
    final Counts counts;

    /** Times a party was left behind, counting each person; searches made for them; people stranded. */
    long leftBehindPeople;
    long replanSearches;
    double seconds;

    private final PriorityQueue<Party> waiting = new PriorityQueue<>((a, b) -> {
        if (a.time != b.time) {
            return Integer.compare(a.time, b.time);
        }
        if (a.at != b.at) {
            return Integer.compare(a.at, b.at);
        }
        if (a.ready != b.ready) {
            return Integer.compare(a.ready, b.ready);
        }
        return Long.compare(a.order, b.order);
    });
    private final List<Party> left = new ArrayList<>();
    private long nextOrder;

    Replay(Router router, Demand demand, PlaceIndex places, Plans plans, SimSettings settings, Sink sink) {
        this.router = router;
        this.t = router.timetable();
        this.demand = demand;
        this.places = places;
        this.plans = plans;
        this.settings = settings;
        this.preferences = Planner.preferences(settings);
        this.sink = sink;
        this.counts = new Counts(t);
    }

    /** The passengers each trip would carry if everyone rode what they planned. */
    static int[] plannedLoads(Timetable t, Demand demand, Plans plans) {
        int[] load = new int[t.stopTimeCount()];
        for (int row = 0; row < demand.size(); row++) {
            if (plans.status[row] != Plans.OK) {
                continue;
            }
            for (Leg leg : plans.journey[row].legs()) {
                if (leg.kind() == Leg.Kind.RIDE) {
                    int first = t.tripTimeIndex(leg.trip(), 0);
                    for (int position = leg.boardPosition(); position < leg.alightPosition(); position++) {
                        load[first + position] += demand.people[row];
                    }
                }
            }
        }
        return load;
    }

    /** Capacity off: everyone rides what they planned. Journeys are settled in row order. */
    void count(Progress progress) throws InterruptedException {
        long started = System.nanoTime();
        for (int row = 0; row < demand.size(); row++) {
            if (plans.status[row] != Plans.OK) {
                sink.settled(row, demand.people[row], plans.status[row], List.of(), 0, -1, -1);
                continue;
            }
            List<Leg> legs = plans.journey[row].legs();
            int people = demand.people[row];
            int ready = demand.start[row];
            boolean rode = false;
            for (int i = 0; i < legs.size(); i++) {
                Leg leg = legs.get(i);
                if (leg.kind() != Leg.Kind.RIDE) {
                    ready = leg.arrive();
                } else if (leg.stayAboard()) {
                    counts.stayAboard(legs.get(i - 1), leg, people);
                    ready = leg.arrive();
                } else {
                    counts.waited(leg.fromStop(), ready, leg.depart(), people);
                    counts.ride(leg, people, rode);
                    rode = true;
                    ready = leg.arrive();
                }
            }
            sink.settled(row, people, Plans.OK, legs, 0, -1, -1);
            if ((row & 0xffff) == 0) {
                stopIfAsked();
                progress.at("replay", row, demand.size());
            }
        }
        progress.at("replay", demand.size(), demand.size());
        seconds = (System.nanoTime() - started) / 1e9;
    }

    /** Capacity on. Journeys are settled as each passenger's last boarding is decided. */
    void run(ExecutorService workers, Progress progress) throws InterruptedException {
        long started = System.nanoTime();
        // Rows join in order of their first boarding, so that only those travelling are held.
        long[] joining = new long[demand.size()];
        int joiners = 0;
        long settled = 0;
        for (int row = 0; row < demand.size(); row++) {
            if (plans.status[row] != Plans.OK) {
                sink.settled(row, demand.people[row], plans.status[row], List.of(), 0, -1, -1);
                settled++;
                continue;
            }
            Journey journey = plans.journey[row];
            int ride = firstRide(journey.legs(), 0);
            if (ride < 0) {
                sink.settled(row, demand.people[row], Plans.OK, journey.legs(), 0, -1, -1); // walks all the way
                settled++;
                continue;
            }
            joining[joiners++] = ((long) journey.legs().get(ride).depart() << 32) | row;
        }
        Arrays.sort(joining, 0, joiners);

        int joined = 0;
        long reported = 0;
        while (joined < joiners || !waiting.isEmpty()) {
            stopIfAsked();
            int now = Integer.MAX_VALUE;
            if (!waiting.isEmpty()) {
                now = waiting.peek().time;
            }
            if (joined < joiners) {
                now = Math.min(now, (int) (joining[joined] >>> 32));
            }
            while (joined < joiners && (int) (joining[joined] >>> 32) == now) {
                join((int) joining[joined++]);
            }
            // Everything that happens in this second, and whatever that sets off in the same second.
            while (true) {
                while (!waiting.isEmpty() && waiting.peek().time == now) {
                    board(waiting.poll(), now);
                }
                if (left.isEmpty()) {
                    break;
                }
                planAgain(now, workers);
            }
            if (joined - reported >= 50_000) {
                reported = joined;
                progress.at("replay", settled + joined, demand.size());
            }
        }
        progress.at("replay", demand.size(), demand.size());
        seconds = (System.nanoTime() - started) / 1e9;
    }

    /** A run is stopped by interrupting its thread. */
    private static void stopIfAsked() throws InterruptedException {
        if (Thread.currentThread().isInterrupted()) {
            throw new InterruptedException("the run was stopped");
        }
    }

    private static int firstRide(List<Leg> legs, int from) {
        for (int i = from; i < legs.size(); i++) {
            if (legs.get(i).kind() == Leg.Kind.RIDE) {
                return i;
            }
        }
        return -1;
    }

    private void join(int row) {
        Party party = new Party();
        party.row = row;
        party.people = demand.people[row];
        party.legs = plans.journey[row].legs();
        party.order = nextOrder++;
        int ride = firstRide(party.legs, 0);
        // They tapped on at the stop at their start time; one who walks to a stop gets there as the plan says.
        aim(party, ride, ride == 0 ? demand.start[row] : party.legs.get(ride - 1).arrive());
    }

    /** Sets a party waiting for a ride. */
    private void aim(Party party, int ride, int ready) {
        Leg leg = party.legs.get(ride);
        party.next = ride;
        party.time = leg.depart();
        party.at = t.tripTimeIndex(leg.trip(), leg.boardPosition());
        party.ready = ready;
        waiting.add(party);
    }

    /** A party's vehicle is leaving: those who fit get on, and the rest are left behind. */
    private void board(Party party, int now) {
        Leg leg = party.legs.get(party.next);
        // Room as the vehicle leaves this stop. Those aboard further along boarded here or earlier,
        // so this stop's figure is normally the highest; but where the vehicle leaves two stops in
        // the same second, someone planned again in that second can come to the earlier stop after
        // the later one has been dealt with. Looking along the whole ride covers that.
        int aboard = 0;
        for (int position = leg.boardPosition(); position < leg.alightPosition(); position++) {
            aboard = Math.max(aboard, counts.load[party.at - leg.boardPosition() + position]);
        }
        int room = Capacity.limit(t, leg.trip(), settings.fullAt) - aboard;
        if (room < party.people) {
            Party behind = party;
            if (room > 0) {
                // Some fit. They go on as a party of their own.
                party = new Party();
                party.row = behind.row;
                party.people = room;
                party.legs = behind.legs;
                party.next = behind.next;
                party.at = behind.at;
                party.ready = behind.ready;
                party.rode = behind.rode;
                party.leftBehind = behind.leftBehind;
                party.refused = behind.refused;
                party.order = nextOrder++;
                behind.people -= room;
            }
            counts.leftBehind(leg.trip(), leg.boardPosition(), behind.people);
            leftBehindPeople += behind.people;
            behind.leftBehind++;
            if (behind.leftBehind > settings.maxLeftBehind) {
                strand(behind, leg.fromStop(), now);
            } else {
                behind.refused = Arrays.copyOf(behind.refused, behind.refused.length + 2);
                behind.refused[behind.refused.length - 2] = leg.trip();
                behind.refused[behind.refused.length - 1] = leg.boardPosition();
                left.add(behind);
            }
            if (room <= 0) {
                return;
            }
        }
        counts.waited(leg.fromStop(), party.ready, leg.depart(), party.people);
        counts.ride(leg, party.people, party.rode);
        party.rode = true;
        int i = party.next + 1;
        while (i < party.legs.size() && party.legs.get(i).kind() == Leg.Kind.RIDE && party.legs.get(i).stayAboard()) {
            counts.stayAboard(party.legs.get(i - 1), party.legs.get(i), party.people);
            i++;
        }
        int ride = firstRide(party.legs, i);
        if (ride < 0) {
            // Vehicles are on time, so someone aboard their last vehicle arrives.
            sink.settled(party.row, party.people, Plans.OK, party.legs, party.leftBehind, -1, -1);
        } else {
            aim(party, ride, party.legs.get(ride - 1).arrive());
        }
    }

    private void strand(Party party, int stop, int now) {
        counts.waited(stop, party.ready, now, party.people);
        sink.settled(party.row, party.people, Plans.STRANDED, List.copyOf(party.legs.subList(0, party.next)),
                party.leftBehind, stop, now);
    }

    /** Plans again for everyone left behind in this second. */
    private void planAgain(int now, ExecutorService workers) throws InterruptedException {
        // One search for each group with the same question: the same stop, the same end, the same refusals.
        Map<String, List<Party>> groups = new LinkedHashMap<>();
        for (Party party : left) {
            int stop = party.legs.get(party.next).fromStop();
            String key = stop + "|" + demand.destination[party.row] + "|" + plans.near[party.row] + "|"
                    + Arrays.toString(party.refused);
            groups.computeIfAbsent(key, k -> new ArrayList<>()).add(party);
        }
        left.clear();
        List<List<Party>> asked = new ArrayList<>(groups.values());
        List<Future<Result>> answers = new ArrayList<>();
        for (List<Party> group : asked) {
            Party first = group.get(0);
            int stop = first.legs.get(first.next).fromStop();
            Capacity refused = Capacity.OFF;
            for (int i = 0; i < first.refused.length; i += 2) {
                refused = refused.blocking(t, first.refused[i], first.refused[i + 1]);
            }
            Capacity capacity = refused;
            answers.add(workers.submit(() -> router.route(places.queryFromStop(stop,
                    demand.destination[first.row], now, plans.near[first.row]), preferences, capacity)));
        }
        replanSearches += asked.size();
        for (int g = 0; g < asked.size(); g++) {
            Result result;
            try {
                result = answers.get(g).get();
            } catch (ExecutionException e) {
                throw new IllegalStateException("planning again failed: " + e.getCause(), e.getCause());
            }
            Journey journey = result.best();
            for (Party party : asked.get(g)) {
                int stop = party.legs.get(party.next).fromStop();
                if (journey == null) {
                    strand(party, stop, now);
                    continue;
                }
                List<Leg> legs = new ArrayList<>(party.legs.subList(0, party.next));
                int ride = legs.size() + firstRide(journey.legs(), 0);
                legs.addAll(journey.legs());
                party.legs = legs;
                Leg onward = journey.legs().get(0);
                if (onward.kind() == Leg.Kind.RIDE) {
                    aim(party, ride, party.ready); // still at the stop they have been waiting at
                } else {
                    // They wait where they are, then cross to another stop of the same parent just in time.
                    counts.waited(stop, party.ready, onward.depart(), party.people);
                    aim(party, ride, onward.arrive());
                }
            }
        }
    }
}
