package gtfseditor.router.core;

import java.util.List;

/**
 * The answer to one query.
 *
 * @param journeys        the fastest first; then those that arrive later but use fewer rides; then,
 *                        if it is the one to recommend, one that walks less
 * @param recommended     which of the journeys to suggest, counting from 0, or -1 if there are none:
 *                        the one with the lowest cost under the {@link Preferences}
 * @param rounds          rounds of the search that ran
 * @param patternsScanned patterns looked along, over all rounds
 * @param computeNanos    time the search took
 */
public record Result(
        Status status, List<Journey> journeys, int recommended, int rounds, int patternsScanned, long computeNanos) {

    /**
     * {@code STRANDED}: there is a journey, but full vehicles or refused boardings leave no way to
     * make it.
     */
    public enum Status { OK, NO_JOURNEY, STRANDED }

    public Result {
        journeys = List.copyOf(journeys);
    }

    /** The journey to suggest, or null if there is none. */
    public Journey best() {
        return recommended < 0 ? null : journeys.get(recommended);
    }
}
