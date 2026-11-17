package gtfseditor.router.gtfs;

/** The feed cannot be loaded: a file is missing, a value cannot be read, or nothing runs. */
public final class GtfsException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    public GtfsException(String message) {
        super(message);
    }
}
