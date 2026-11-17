package gtfseditor.router.server;

/** A request that cannot be answered, with the HTTP status to send and words for the caller. */
final class ApiException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    private final int status;

    ApiException(int status, String message) {
        super(message);
        this.status = status;
    }

    int status() {
        return status;
    }

    /** The request itself is wrong. */
    static ApiException bad(String message) {
        return new ApiException(400, message);
    }
}
