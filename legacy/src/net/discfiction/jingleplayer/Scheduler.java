package net.discfiction.jingleplayer;

import java.io.IOException;
import java.net.URISyntaxException;
import java.net.URL;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;

import javax.sound.sampled.AudioInputStream;
import javax.sound.sampled.AudioSystem;
import javax.sound.sampled.Clip;
import javax.sound.sampled.LineUnavailableException;
import javax.sound.sampled.UnsupportedAudioFileException;

public class Scheduler implements Runnable {

	private final static int GAME_LENGTH = 50;
	private final static int LAST_X_MIN = 5;
	private List<Date> starttimes;
	private List<Date> preendtimes = new ArrayList<Date>();
	private List<Date> endtimes = new ArrayList<Date>();

	@SuppressWarnings("deprecation")
	public Scheduler(List<Date> timestamps) {
		this.starttimes = timestamps;
		for (Date date : timestamps) {
			Date preendtime = (Date) date.clone();
			Date endtime = (Date) date.clone();
			preendtime.setMinutes(preendtime.getMinutes() + GAME_LENGTH - LAST_X_MIN);
			endtime.setMinutes(endtime.getMinutes() + GAME_LENGTH);
			System.out.println();
			System.out.println("Game start at: " + date);
			System.out.println("Last " + LAST_X_MIN + " minutes at: " + preendtime);
			System.out.println("Game end at: " + endtime);
			preendtimes.add(preendtime);
			endtimes.add(endtime);
		}
	}

	@Override
	public void run() {
		while (true) {
			try {
				Thread.sleep(1000);
				long currentSeconds = System.currentTimeMillis() / 1000;
				long nextJingleTime = Long.MAX_VALUE;

				for (Date starttime : starttimes) {
					long starttimeInSeconds = starttime.getTime() / 1000;
					if (currentSeconds < starttimeInSeconds) {
						nextJingleTime = Math.min(nextJingleTime, starttimeInSeconds);
					}
					if (currentSeconds == starttimeInSeconds) {
						playJingle("J_timeisrunning.wav");
					}
				}

				for (Date preendtime : preendtimes) {
					long preendtimeInSeconds = preendtime.getTime() / 1000;
					if (currentSeconds < preendtimeInSeconds) {
						nextJingleTime = Math.min(nextJingleTime, preendtimeInSeconds);
					}
					if (currentSeconds == preendtimeInSeconds) {
						playJingle("J_lastxminutes.wav");
					}
				}

				for (Date endtime : endtimes) {
					long endtimeInSeconds = endtime.getTime() / 1000;
					if (currentSeconds < endtimeInSeconds) {
						nextJingleTime = Math.min(nextJingleTime, endtimeInSeconds);
					}
					if (currentSeconds == endtimeInSeconds) {
						playJingle("J_timeisover.wav");
					}
				}
        long secondsTill = nextJingleTime - currentSeconds;
        long minutesTill = secondsTill / 60;
        long secondsPartial = secondsTill % 60;
				System.out.println("Current time: " + currentSeconds + ". Next jingle in: " + minutesTill + " minutes " + secondsPartial + " seconds (" + new Date(nextJingleTime * 1000)+")");
			} catch (Exception e) {
				System.err.println(e);
			}

		}
	}

	private void playJingle(String jingle) throws URISyntaxException, UnsupportedAudioFileException, IOException, LineUnavailableException {
		ClassLoader cl = this.getClass().getClassLoader();
		URL resource = cl.getResource(jingle);
		System.out.println(new Date(System.currentTimeMillis()) + ": Playing " + jingle);
		AudioInputStream audioIn = AudioSystem.getAudioInputStream(resource);
		Clip clip = AudioSystem.getClip();
		clip.open(audioIn);
		clip.start();
	}

}
