package gtfseditor.router.sim;

import java.util.List;
import java.util.Map;

/** Writes maps, lists, texts, numbers and booleans as JSON, and as indented text for reading. */
final class Json {

    private Json() {}

    static String write(Object value) {
        StringBuilder out = new StringBuilder(4096);
        write(out, value, 0);
        return out.append('\n').toString();
    }

    private static void write(StringBuilder out, Object value, int depth) {
        switch (value) {
            case null -> out.append("null");
            case Map<?, ?> map -> {
                if (map.isEmpty()) {
                    out.append("{}");
                    return;
                }
                out.append('{');
                boolean first = true;
                for (Map.Entry<?, ?> entry : map.entrySet()) {
                    out.append(first ? "\n" : ",\n").append("  ".repeat(depth + 1));
                    text(out, entry.getKey().toString());
                    out.append(": ");
                    write(out, entry.getValue(), depth + 1);
                    first = false;
                }
                out.append('\n').append("  ".repeat(depth)).append('}');
            }
            case List<?> list -> {
                if (list.isEmpty()) {
                    out.append("[]");
                    return;
                }
                out.append('[');
                boolean first = true;
                for (Object item : list) {
                    out.append(first ? "\n" : ",\n").append("  ".repeat(depth + 1));
                    write(out, item, depth + 1);
                    first = false;
                }
                out.append('\n').append("  ".repeat(depth)).append(']');
            }
            case Double number -> out.append(number.isNaN() || number.isInfinite() ? "null"
                    : number == Math.rint(number) && Math.abs(number) < 1e15 ? Long.toString(number.longValue())
                    : Double.toString(Math.round(number * 1000) / 1000.0));
            case Number number -> out.append(number);
            case Boolean flag -> out.append(flag);
            default -> text(out, value.toString());
        }
    }

    private static void text(StringBuilder out, String text) {
        out.append('"');
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c == '"' || c == '\\') {
                out.append('\\').append(c);
            } else if (c < ' ') {
                out.append(String.format("\\u%04x", (int) c));
            } else {
                out.append(c);
            }
        }
        out.append('"');
    }

    /** The same values as indented lines of {@code name  value}, for a person to read. */
    static String readable(Map<String, Object> value) {
        StringBuilder out = new StringBuilder(2048);
        readable(out, value, 0);
        return out.toString();
    }

    private static void readable(StringBuilder out, Map<?, ?> map, int depth) {
        for (Map.Entry<?, ?> entry : map.entrySet()) {
            String name = "  ".repeat(depth) + entry.getKey();
            switch (entry.getValue()) {
                case Map<?, ?> inner -> {
                    out.append(name).append('\n');
                    readable(out, inner, depth + 1);
                }
                case List<?> list -> {
                    out.append(name).append(list.isEmpty() ? "  none\n" : "\n");
                    for (Object item : list) {
                        out.append("  ".repeat(depth + 1));
                        if (item instanceof Map<?, ?> row) {
                            boolean first = true;
                            for (Map.Entry<?, ?> cell : row.entrySet()) {
                                out.append(first ? "" : ", ").append(cell.getKey()).append(' ').append(shown(cell.getValue()));
                                first = false;
                            }
                        } else {
                            out.append(shown(item));
                        }
                        out.append('\n');
                    }
                }
                case null, default -> out.append(String.format("%-34s %s%n", name, shown(entry.getValue())));
            }
        }
    }

    private static String shown(Object value) {
        return switch (value) {
            case Double number -> number == Math.rint(number) ? String.format("%,d", number.longValue())
                    : String.format("%,.2f", number);
            case Long number -> String.format("%,d", number);
            case Integer number -> String.format("%,d", number);
            case null -> "";
            default -> value.toString();
        };
    }
}
