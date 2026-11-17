package gtfseditor.router.sim;

/** Times of day as seconds from the start of the service day, and as text. */
final class Clock {

    private Clock() {}

    static String text(int seconds) {
        return String.format("%02d:%02d:%02d", seconds / 3600, seconds / 60 % 60, seconds % 60);
    }

    /**
     * Reads {@code HH:MM}, {@code HH:MM:SS} or a count of seconds. After midnight the hours keep
     * counting: {@code 24:30}.
     *
     * @return the seconds, or -1 if the text is none of those
     */
    static int parse(String text) {
        String trimmed = text.strip();
        if (trimmed.isEmpty() || trimmed.length() > 9) {
            return -1;
        }
        int[] parts = new int[3];
        int count = 0;
        int digits = 0;
        for (int i = 0; i < trimmed.length(); i++) {
            char c = trimmed.charAt(i);
            if (c == ':') {
                if (digits == 0 || count == 2) {
                    return -1;
                }
                count++;
                digits = 0;
            } else if (c >= '0' && c <= '9') {
                parts[count] = parts[count] * 10 + (c - '0');
                digits++;
            } else {
                return -1;
            }
        }
        if (digits == 0) {
            return -1;
        }
        if (count == 0) {
            return parts[0];
        }
        if (parts[1] >= 60 || parts[2] >= 60) {
            return -1;
        }
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
}
