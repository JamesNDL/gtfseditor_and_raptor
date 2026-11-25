package gtfseditor.router.core;

import java.util.Arrays;

/**
 * The {@link BackwardSearch}'s two times per stop, which stops' times changed in each round, and
 * which stops were written at all, so that the next query clears only those.
 */
final class BackwardTimes {

    /** No time: later is better, so this is the worst. */
    static final int NONE = Integer.MIN_VALUE;

    /** Latest the passenger may get off a vehicle at each stop, any round so far. */
    final int[] alight;
    /** {@link #alight} as this round began, for the stops it improved for in the round before; else NONE. */
    final int[] ready;
    /** Latest the passenger may board at each stop, any round so far. */
    final int[] board;

    private final boolean[] touched;
    private final int[] touchedStops;
    private int touchedCount;

    private final boolean[] alightMarked; // alight improved in the current round
    private int[] alightMarkedStops;
    private int alightMarkedCount;
    private int[] alightingStops;         // alight improved in the round before
    private int alightingCount;
    private final boolean[] boardMarked;  // board improved in the current round
    private final int[] boardMarkedStops;
    private int boardMarkedCount;

    BackwardTimes(int stops) {
        alight = filled(stops);
        ready = filled(stops);
        board = filled(stops);
        touched = new boolean[stops];
        touchedStops = new int[stops];
        alightMarked = new boolean[stops];
        alightMarkedStops = new int[stops];
        alightingStops = new int[stops];
        boardMarked = new boolean[stops];
        boardMarkedStops = new int[stops];
    }

    private static int[] filled(int length) {
        int[] array = new int[length];
        Arrays.fill(array, NONE);
        return array;
    }

    /** Takes a later time to get off at a stop, if it is later than what it has and than {@code floor}. */
    void improveAlight(int stop, int time, int floor) {
        if (time > alight[stop] && time > floor) {
            alight[stop] = time;
            touch(stop);
            if (!alightMarked[stop]) {
                alightMarked[stop] = true;
                alightMarkedStops[alightMarkedCount++] = stop;
            }
        }
    }

    /** Takes a later time to board at a stop, if it is later than what it has. */
    void improveBoard(int stop, int time) {
        if (time > board[stop]) {
            board[stop] = time;
            touch(stop);
            if (!boardMarked[stop]) {
                boardMarked[stop] = true;
                boardMarkedStops[boardMarkedCount++] = stop;
            }
        }
    }

    /** Whether any stop's time to get off improved in the current round. */
    boolean alightImproved() {
        return alightMarkedCount > 0;
    }

    /**
     * Starts a round from the stops whose time to get off improved in the last one, setting their
     * {@link #ready} times, except where that time is no later than {@code floor}.
     *
     * @return how many there are, read with {@link #alighting}
     */
    int startRound(int floor) {
        int[] swap = alightingStops;
        alightingStops = alightMarkedStops;
        alightMarkedStops = swap;
        alightingCount = alightMarkedCount;
        alightMarkedCount = 0;
        for (int i = 0; i < alightingCount; i++) {
            int stop = alightingStops[i];
            alightMarked[stop] = false;
            ready[stop] = alight[stop] > floor ? alight[stop] : NONE;
        }
        return alightingCount;
    }

    int alighting(int i) {
        return alightingStops[i];
    }

    /** Ends the round's rides: the ready times are spent. */
    void endRides() {
        for (int i = 0; i < alightingCount; i++) {
            ready[alightingStops[i]] = NONE;
        }
        alightingCount = 0;
    }

    /** How many stops' boarding times improved in the current round, read with {@link #boarded}. */
    int boardedCount() {
        return boardMarkedCount;
    }

    int boarded(int i) {
        return boardMarkedStops[i];
    }

    /** Forgets which boarding times improved, for the next round. */
    void clearBoarded() {
        for (int i = 0; i < boardMarkedCount; i++) {
            boardMarked[boardMarkedStops[i]] = false;
        }
        boardMarkedCount = 0;
    }

    private void touch(int stop) {
        if (!touched[stop]) {
            touched[stop] = true;
            touchedStops[touchedCount++] = stop;
        }
    }

    /** Clears what the last query wrote, and only that: far cheaper than clearing every array. */
    void reset() {
        for (int i = 0; i < touchedCount; i++) {
            int stop = touchedStops[i];
            touched[stop] = false;
            alightMarked[stop] = false;
            boardMarked[stop] = false;
            alight[stop] = NONE;
            ready[stop] = NONE;
            board[stop] = NONE;
        }
        touchedCount = 0;
        alightMarkedCount = 0;
        alightingCount = 0;
        boardMarkedCount = 0;
    }
}
