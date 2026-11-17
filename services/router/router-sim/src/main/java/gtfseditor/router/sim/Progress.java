package gtfseditor.router.sim;

/** Hears how far a run has got. Called from one thread at a time. */
public interface Progress {

    Progress NONE = (stage, done, total) -> { };

    /**
     * @param stage {@code plan}, {@code replay} or {@code write}
     * @param done  journeys dealt with so far in this stage
     * @param total journeys the stage has to deal with
     */
    void at(String stage, long done, long total);
}
