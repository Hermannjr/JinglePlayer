package net.discfiction.jingleplayer;

import java.nio.file.Paths;
import java.util.Date;
import java.util.List;

public class JinglePlayer {

	public static void main(String[] args) throws Exception {
		if (args.length != 1) {
			System.out.println("Not enough or too many arguments supplied.");
			System.out.println("JinglePlayer {schedulefile}");
			System.exit(-1);
		}
		
		ScheduleReader reader = new ScheduleReader(Paths.get(args[0]));
		List<Date> timestamps = reader.read();

		Scheduler scheduler = new Scheduler(timestamps);
		new Thread(scheduler).start();
	}

}
