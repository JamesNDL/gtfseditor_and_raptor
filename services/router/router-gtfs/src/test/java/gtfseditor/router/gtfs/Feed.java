package gtfseditor.router.gtfs;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/** A hand-made GTFS feed for tests: name the files, give their lines, and zip them. */
final class Feed {

    private final Map<String, String> files = new LinkedHashMap<>();

    /** Sets or replaces a file. The first line is the header. */
    Feed file(String name, String... lines) {
        files.put(name, String.join("\n", lines) + "\n");
        return this;
    }

    Feed without(String name) {
        files.remove(name);
        return this;
    }

    Path zip(Path folder) throws IOException {
        Path zip = Files.createTempFile(folder, "feed", ".zip");
        try (OutputStream out = Files.newOutputStream(zip); ZipOutputStream entries = new ZipOutputStream(out)) {
            for (Map.Entry<String, String> file : files.entrySet()) {
                entries.putNextEntry(new ZipEntry(file.getKey()));
                entries.write(file.getValue().getBytes(StandardCharsets.UTF_8));
                entries.closeEntry();
            }
        }
        return zip;
    }

    /** One service, {@code DAY}, running only on Tuesday 17 November 2026, as the editor exports. */
    Feed oneDay() {
        return file("calendar.txt",
                "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date",
                "DAY,0,1,0,0,0,0,0,20261117,20261117");
    }
}
