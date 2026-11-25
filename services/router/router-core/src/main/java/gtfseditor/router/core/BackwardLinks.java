package gtfseditor.router.core;

/**
 * The timetable's links turned round, for looking from where a passenger ends up back to where
 * they came from: the walking links grouped by the stop they lead to, and for each trip the trips
 * whose vehicle runs on into it. Built once per {@link Router}; never changed after.
 *
 * @param linkInOffset   where each stop's incoming links start; one extra entry at the end
 * @param linkInFrom     the stop each incoming link starts from
 * @param linkInSecs     the link's walking time
 * @param linkInMetres   the link's distance in metres
 * @param runsFromOffset where each trip's entries start in {@code runsFrom}; one extra entry
 * @param runsFrom       the trips whose vehicle runs on into each trip
 * @param patternRunsOn  per pattern: whether any vehicle runs on into one of its trips
 */
record BackwardLinks(
        int[] linkInOffset,
        int[] linkInFrom,
        int[] linkInSecs,
        int[] linkInMetres,
        int[] runsFromOffset,
        int[] runsFrom,
        boolean[] patternRunsOn) {

    static BackwardLinks of(Timetable t) {
        int stops = t.stopCount();
        int[] linkInOffset = new int[stops + 1];
        for (int target : t.transferTargets) {
            linkInOffset[target + 1]++;
        }
        for (int s = 0; s < stops; s++) {
            linkInOffset[s + 1] += linkInOffset[s];
        }
        int[] linkInFrom = new int[t.transferCount()];
        int[] linkInSecs = new int[t.transferCount()];
        int[] linkInMetres = new int[t.transferCount()];
        int[] next = linkInOffset.clone();
        for (int from = 0; from < stops; from++) {
            for (int j = t.transferOffset[from]; j < t.transferOffset[from + 1]; j++) {
                int slot = next[t.transferTargets[j]]++;
                linkInFrom[slot] = from;
                linkInSecs[slot] = t.transferSecs[j];
                linkInMetres[slot] = t.transferMetres[j];
            }
        }

        int trips = t.tripCount();
        int[] runsFromOffset = new int[trips + 1];
        for (int later : t.tripStayAboard) {
            if (later >= 0) {
                runsFromOffset[later + 1]++;
            }
        }
        for (int trip = 0; trip < trips; trip++) {
            runsFromOffset[trip + 1] += runsFromOffset[trip];
        }
        int[] runsFrom = new int[runsFromOffset[trips]];
        int[] nextTrip = runsFromOffset.clone();
        boolean[] patternRunsOn = new boolean[t.patternCount()];
        for (int trip = 0; trip < trips; trip++) {
            int later = t.tripStayAboard[trip];
            if (later >= 0) {
                runsFrom[nextTrip[later]++] = trip;
                patternRunsOn[t.tripPattern[later]] = true;
            }
        }
        return new BackwardLinks(linkInOffset, linkInFrom, linkInSecs, linkInMetres, runsFromOffset, runsFrom,
                patternRunsOn);
    }
}
