package gtfseditor.router.sim;

import gtfseditor.router.core.Leg;
import java.util.List;

/** Receives each journey as it is settled. Called from one thread. */
public interface Sink {

    /**
     * One row of the demand, or part of one: a full vehicle can split a row that stands for
     * several people, and each part is then settled on its own.
     *
     * @param row          the row of the demand set
     * @param people       how many people this part stands for
     * @param status       {@link Plans#OK}, {@link Plans#NO_JOURNEY}, {@link Plans#GAVE_UP} or
     *                     {@link Plans#STRANDED}
     * @param legs         what they travelled: the planned journey; or, for someone left behind,
     *                     what they rode before, then the journey planned from where they stood,
     *                     which may begin with a walk to another stop of the same parent; empty
     *                     for someone who did not travel
     * @param leftBehind   times a full vehicle left them at a stop
     * @param strandedStop where a stranded passenger ended up, or -1
     * @param strandedTime when, or -1
     */
    void settled(int row, int people, byte status, List<Leg> legs, int leftBehind, int strandedStop,
            int strandedTime);
}
