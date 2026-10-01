# Disc Fiction Jingle Player

Automatic tournament announcements for ultimate frisbee: game start, halftime, halftime over,
5 minutes left and time cap. It runs from the schedule, per field, in the browser. It works on
Windows and macOS with no install and no internet.

## For organisers: quick start

1. Copy **`dist/JinglePlayer.html`** to the laptop and double-click it. Chrome or Edge work best; Safari works too.
2. Laptop volume **100%**. Start Spotify and set **Spotify's own volume slider to about 75%**.
3. Click **Start & play test sound**. You should hear the announcer.
4. Leave the window open and the laptop plugged in. That's it.

The **Live** tab shows the next announcement, every field's current game, and what's coming up.

### When things change on the day

| Situation | What to do |
|---|---|
| A field is running late | Live tab, that field's card: **+5** (moves its unfinished games) |
| Everything is running late | Live tab, *Running late?*: **+5 min** |
| Teams are ready early / late | **▶ Start next game now**: the start jingle plays right away and the game's clock starts now |
| A team reached 8 points and took half early | **Skip** the halftime announcement in *Coming up* |
| Move or reshuffle games | **Schedule** tab: drag games on the timeline (sideways = time, up/down = field) or edit the table |
| Oops | **Undo** (also Ctrl/Cmd+Z) |

With *"Dragging or retiming a game also moves the later games on its field"* ticked, moving one
game pushes the rest of that field's day along with it.

### Setting up a new tournament

* **Schedule → Paste from ultie.org**: open the event's *Games → Scheduled* page, select the list,
  copy, and paste it in. Teams, fields, dates and times are recognised, and you choose the game type
  (length + halftime minute) for group and play-off games.
* Or add games by hand with **+ Add game**, or use **+ Day** to add another day.
* **Settings**: announcer voice (*Grandpa* or *Clear*), which jingles to use, halftime break length,
  field names (up to 4), and game types.
* Everything saves automatically in the browser. **Save file** / **Load file** moves a schedule to
  another laptop or keeps a backup.

### Good to know

* Browsers only play sound after a click, which is why the start button is there. After a reload, press it again.
* Announcements are scheduled on the audio clock up to 70 s ahead, so a busy or background
  window doesn't delay them. If the laptop was asleep, announcements missed by more than 1 minute
  are skipped and shown as *missed*.
* When every field hits the same moment, it says "all fields" once. Otherwise fields are announced
  one after another, never on top of each other.
* Turn off sleep / screen saver on the laptop if you can (the app also asks the browser to keep the screen on).
* **Rehearsal:** add `?at=2026-10-03T10:49` to the address to run the app as if it were that time
  (`&nogate` skips the start screen).

## Project layout

```
dist/JinglePlayer.html   single-file build (what organisers use)
app/                     source: index.html, app.js, styles.css, default-schedule.js
app/audio/               generated jingles (mp3 per clip + jingles.js bundle)
app/img, app/fonts       Disc Fiction artwork and fonts (from the "Ultimate in a Minute" explainer)
tools/generate_jingles.py  makes all announcement audio (free Microsoft Edge TTS + synthesized stings)
tools/build.py           bundles app/ into dist/JinglePlayer.html
legacy/                  the original 2015 Java JinglePlayer
```

During development you can open `app/index.html` directly. No server is needed.

### Changing the announcements

Edit `LINES` in `tools/generate_jingles.py`, then:

```
pip install -r tools/requirements.txt
python tools/generate_jingles.py
python tools/build.py
```

The voices are Microsoft Edge neural TTS (free, no account needed). *Grandpa* is
`en-GB-ThomasNeural`, slowed down, with a synthesized tremor. *Clear* is `en-US-GuyNeural`.
Each clip is a sting (fanfare, chime, air horn or whistle) followed by the voice line, compressed
and normalised loud (around -13 LUFS) to cut through background music.

### Changing the default schedule

`app/default-schedule.js` holds the built-in tournament (JÖM U20 & ÖM-M 2026, Herbertgarten) and
the game types from the ultie.org regulations. After editing, run `python tools/build.py`. Browsers
that already have a saved schedule keep theirs until you use *Reset to tournament default* at the
bottom of the Schedule tab.
