package net.discfiction.jingleplayer;

import java.io.IOException;
import java.nio.charset.Charset;
import java.nio.file.Files;
import java.nio.file.Path;
import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

public class ScheduleReader {

	private Path path;

	public ScheduleReader(Path path) {
		this.path = path;
	}

	public List<Date> read() throws IOException, ParseException {
		List<String> allStrings = Files.readAllLines(path, Charset.defaultCharset());
		List<Date> allTimestamps = new ArrayList<Date>(allStrings.size());
		SimpleDateFormat sdf = new SimpleDateFormat("HH:mm:ss dd.MM.yyyy", Locale.GERMAN);
		System.out.println("Adding the following timestamps to list: ");
		for (String stringTS : allStrings) {
			Date date = sdf.parse(stringTS);
			System.out.println(" * " + date);
			allTimestamps.add(date);
		}
		return allTimestamps;
	}

}
