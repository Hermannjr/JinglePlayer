// Tournament defaults: JÖM U20 & ÖM-M 2026, Herbertgarten (from ultie.org, 1 Oct 2026).
// Game lengths / halftime markers follow the ultie.org regulations per division & stage.
window.DEFAULT_STATE = (function () {
  var presets = [
    { id: "m-group", name: "Masters · Group", dur: 35, ht: 17 },
    { id: "m-final", name: "Masters · Finals", dur: 45, ht: 23 },
    { id: "u-group", name: "U20 · Group", dur: 35, ht: 23 },
    { id: "u-final", name: "U20 · Finals", dur: 45, ht: 23 },
    { id: "u-3rd", name: "U20 · 3rd place", dur: 40, ht: 20 },
    { id: "u-1st", name: "U20 · 1st place", dur: 45, ht: 23 },
    { id: "general", name: "General", dur: 35, ht: 18 }
  ];
  var P = {};
  presets.forEach(function (p) { P[p.id] = p; });

  var rows = [
    // date, time, field, preset, matchup, note
    ["2026-10-03", "09:00", 2, "m-group", "Supertrumpf vs Mikado", "Masters · Group A"],
    ["2026-10-03", "09:00", 1, "m-group", "Augärtner Ultimate Graz vs Mosquitos Goldies", "Masters · Group A"],
    ["2026-10-03", "09:40", 1, "m-group", "Lok Stoli vs Disc Fiction", "Masters · Group B"],
    ["2026-10-03", "10:20", 2, "m-group", "Augärtner Ultimate Graz vs Mikado", "Masters · Group A"],
    ["2026-10-03", "10:20", 1, "m-group", "Supertrumpf vs Mosquitos Goldies", "Masters · Group A"],
    ["2026-10-03", "11:00", 2, "m-group", "GTV vs Disc Fiction", "Masters · Group B"],
    ["2026-10-03", "11:40", 2, "m-group", "Mosquitos Goldies vs Mikado", "Masters · Group A"],
    ["2026-10-03", "11:40", 1, "m-group", "Augärtner Ultimate Graz vs Supertrumpf", "Masters · Group A"],
    ["2026-10-03", "13:00", 1, "m-group", "GTV vs Lok Stoli", "Masters · Group B"],
    ["2026-10-03", "14:20", 2, "m-final", "1st of A vs 2nd of B", "Masters · Semi 1-4"],
    ["2026-10-03", "14:20", 1, "m-final", "3rd of B vs 4th of A", "Masters · 5-7"],
    ["2026-10-03", "15:00", 1, "m-final", "1st of B vs 2nd of A", "Masters · Semi 1-4"],
    ["2026-10-03", "15:40", 1, "m-final", "3rd of A vs 4th of A", "Masters · 5-7"],
    ["2026-10-03", "16:20", 2, "m-final", "Loser Semi 1 vs Loser Semi 2", "Masters · 3rd place"],
    ["2026-10-03", "17:00", 1, "m-final", "3rd of A vs 3rd of B", "Masters · 5-7"],
    ["2026-10-03", "17:10", 2, "m-final", "Winner Semi 1 vs Winner Semi 2", "Masters · Final"],

    ["2026-10-04", "09:30", 2, "u-group", "Winona Privateers vs Catchup Twoniors", "U20 · Group B"],
    ["2026-10-04", "09:30", 1, "u-group", "Catchup Juniors vs Styrian Blackbirds", "U20 · Group A"],
    ["2026-10-04", "10:50", 1, "u-group", "Winona Privateers vs Mosquitos", "U20 · Group B"],
    ["2026-10-04", "10:50", 2, "u-group", "Ultimate Primates vs Styrian Blackbirds", "U20 · Group A"],
    ["2026-10-04", "12:15", 1, "u-group", "Mosquitos vs Catchup Twoniors", "U20 · Group B"],
    ["2026-10-04", "12:15", 2, "u-group", "Ultimate Primates vs Catchup Juniors", "U20 · Group A"],
    ["2026-10-04", "13:35", 2, "u-final", "2nd of A vs 3rd of B", "U20 · Crossover"],
    ["2026-10-04", "13:35", 1, "u-final", "2nd of B vs 3rd of A", "U20 · Crossover"],
    ["2026-10-04", "14:55", 2, "u-final", "1st of A vs Crossover winner 2", "U20 · Semi"],
    ["2026-10-04", "14:55", 1, "u-final", "1st of B vs Crossover winner 1", "U20 · Semi"],
    ["2026-10-04", "15:35", 1, "u-final", "Crossover losers", "U20 · 5th place"],
    ["2026-10-04", "16:15", 2, "u-3rd", "Semi losers", "U20 · 3rd place"],
    ["2026-10-04", "16:25", 1, "u-1st", "Semi winners", "U20 · Final"]
  ];

  return {
    version: 1,
    tournament: "JÖM U20 & ÖM-M 2026",
    settings: {
      volume: 1,
      jingles: { start: true, five: true, halftime: true, end: true },
      htBreak: 2,
      mergeFields: true,
      ripple: true,
      fields: [
        { n: 1, name: "Herbertgarten #1" },
        { n: 2, name: "Herbertgarten #2" }
      ]
    },
    presets: presets,
    games: rows.map(function (r, i) {
      var p = P[r[3]];
      return { id: "g" + (i + 1), date: r[0], time: r[1], field: r[2], preset: p.id, dur: p.dur, ht: p.ht, label: r[4], note: r[5], on: true };
    })
  };
})();
