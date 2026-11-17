package gtfseditor.router.sim;

import gtfseditor.router.core.Journey;

/**
 * What stage 1 decided for every row of a demand set: the journey each person plans to take, and
 * the figures behind the choice. See sections 4.2 and 4.6 of docs/simulator-plan.md.
 *
 * <p>The plans of a BAU run are also the <em>reference</em> for the scenario runs made against it:
 * its {@link #status}, {@link #arrive} and {@link #margin} say what each person did on the
 * published timetable and how strongly they prefer their own stop.
 */
public final class Plans {

    /** Statuses of a row, and of a journey once it is settled. */
    public static final byte OK = 0;
    public static final byte NO_JOURNEY = 1;
    public static final byte GAVE_UP = 2;
    /** Only a settled journey can be stranded: stage 1 does not know how full vehicles are. */
    public static final byte STRANDED = 3;

    /** Why a person uses a stop that is not their own. */
    public static final byte KEPT = 0;
    /** Their own stop is not in the timetable, has no service, or nothing from it gets there. */
    public static final byte GONE = 1;
    /** Another stop is better by more than their margin and the threshold. */
    public static final byte BETTER = 2;
    /** The row is a position and not a stop, so there is no own stop to keep. */
    public static final byte POSITION = 3;

    /** Why a row has no journey. */
    public static final byte SAME_PLACE = 1;
    public static final byte NO_STOP = 2;
    public static final byte NOTHING_RUNS = 3;

    public final byte[] status;
    /** Whether the journey chosen is the one that may use any stop near, not the own-stops one. */
    public final boolean[] near;
    public final byte[] reason;
    public final byte[] why;
    /** The journey each person plans to take, or null. Rows that fit the same search share one. */
    public final Journey[] journey;
    /** When the planned journey arrives, or -1. Kept apart so that a reference needs no journeys. */
    public final int[] arrive;
    /** How much better a nearby stop was on the published timetable, in seconds of cost; 0 or more. */
    public final int[] margin;
    /** Arrival and cost of the own-stops journey and of the best that may use any stop near; -1 if none. */
    public final int[] ownArrive;
    public final int[] ownCost;
    public final int[] nearArrive;
    public final int[] nearCost;

    /** Searches run, and searches saved by reusing a plan. Zero for plans read from a file. */
    public long searches;
    public long reused;
    public double planSecs;

    Plans(int rows) {
        status = new byte[rows];
        near = new boolean[rows];
        reason = new byte[rows];
        why = new byte[rows];
        journey = new Journey[rows];
        arrive = new int[rows];
        margin = new int[rows];
        ownArrive = new int[rows];
        ownCost = new int[rows];
        nearArrive = new int[rows];
        nearCost = new int[rows];
    }

    public int size() {
        return status.length;
    }

    static String statusName(byte status) {
        return switch (status) {
            case OK -> "ok";
            case NO_JOURNEY -> "noJourney";
            case GAVE_UP -> "gaveUp";
            case STRANDED -> "stranded";
            default -> throw new IllegalArgumentException("no status " + status);
        };
    }

    static String reasonName(byte reason) {
        return switch (reason) {
            case KEPT -> "";
            case GONE -> "gone";
            case BETTER -> "better";
            case POSITION -> "position";
            default -> throw new IllegalArgumentException("no reason " + reason);
        };
    }

    static String whyName(byte why) {
        return switch (why) {
            case 0 -> "";
            case SAME_PLACE -> "starts and ends at the same place";
            case NO_STOP -> "no stop to use at one end";
            case NOTHING_RUNS -> "nothing gets there after this time";
            default -> throw new IllegalArgumentException("no reason " + why);
        };
    }
}
