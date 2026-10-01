/* Disc Fiction Jingle Player
 * Plain JS, no build step, works from file:// on Windows and macOS.
 * Audio: Web Audio API with clips decoded from base64 (audio/jingles.js), scheduled
 * ahead of time on the audio clock so background-tab timer throttling can't delay them.
 */
(function () {
  "use strict";

  // ------------------------------------------------------------------ constants
  var STORE_KEY = "dfjp.state.v1";
  var LOOKAHEAD_MS = 70000;   // schedule audio this far ahead (survives 1-per-minute timer throttling)
  var GRACE_MS = 60000;       // after sleep/hiccup: still play announcements up to 1 min late
  var GAP_S = 0.6;            // silence between back-to-back announcements
  var TYPES = {
    start: { label: "Game start", icon: "▶", short: "Start" },
    halftime: { label: "Halftime", icon: "◐", short: "Half" },
    halftime_over: { label: "Halftime over", icon: "↺", short: "2nd half" },
    five: { label: "5 minutes left", icon: "⏳", short: "5 min" },
    end: { label: "Time cap / game over", icon: "■", short: "Cap" }
  };
  var TYPE_PRIORITY = { end: 0, halftime: 1, halftime_over: 2, five: 3, start: 4 };
  var HEADS = ["img/head_jules.webp", "img/head_vincent.webp", "img/head_jules.webp", "img/head_vincent.webp"];
  var FIELD_COLORS = ["lime", "orange", "yellow", "teal"];
  var DAYNAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // Rehearsal / testing: index.html?at=2026-10-03T10:40 runs the app as if it were that time
  // (the clock then keeps ticking from there). Add &nogate to skip the start screen.
  var params = new URLSearchParams(location.search);
  var CLOCK_OFFSET = params.get("at") ? new Date(params.get("at")).getTime() - Date.now() : 0;
  if (isNaN(CLOCK_OFFSET)) CLOCK_OFFSET = 0;
  function clockNow() { return Date.now() + CLOCK_OFFSET; }

  // ------------------------------------------------------------------ state
  var state = load();
  var undoStack = [];
  var view = "live";
  var schedDay = null;
  var plan = [];              // computed announcements
  var skipped = loadSkipped();
  var log = [];

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function load() {
    try {
      var s = JSON.parse(localStorage.getItem(STORE_KEY));
      if (s && s.version === 1 && Array.isArray(s.games)) return s;
    } catch (e) { /* storage blocked or corrupt */ }
    return clone(window.DEFAULT_STATE);
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }
  function loadSkipped() {
    try { return new Set(JSON.parse(localStorage.getItem(STORE_KEY + ".skipped")) || []); } catch (e) { return new Set(); }
  }
  function saveSkipped() {
    try { localStorage.setItem(STORE_KEY + ".skipped", JSON.stringify(Array.from(skipped).slice(-300))); } catch (e) { /* ignore */ }
  }

  // Every schedule/settings mutation goes through here: undo, save, re-plan, re-render.
  function commit(mutator, msg) {
    undoStack.push(JSON.stringify(state));
    if (undoStack.length > 50) undoStack.shift();
    mutator(state);
    afterChange();
    if (msg) toast(msg, true);
  }
  function undo() {
    if (!undoStack.length) { toast("Nothing to undo"); return; }
    state = JSON.parse(undoStack.pop());
    afterChange();
    toast("Undone");
  }
  function afterChange() {
    save();
    replan();
    renderAll();
  }

  // ------------------------------------------------------------------ time helpers
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function gameStart(g) { return new Date(g.date + "T" + (g.time.length === 5 ? g.time + ":00" : g.time)).getTime(); }
  function gameEnd(g) { return gameStart(g) + g.dur * 60000; }
  function hhmm(ms) { var d = new Date(ms); return pad(d.getHours()) + ":" + pad(d.getMinutes()); }
  function hhmmss(ms) { var d = new Date(ms); return hhmm(ms) + ":" + pad(d.getSeconds()); }
  function isoDate(ms) { var d = new Date(ms); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function dayLabel(iso, long) {
    var d = new Date(iso + "T12:00:00");
    return (long ? ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getDay()] : DAYNAMES[d.getDay()]) + " " + d.getDate() + " " + MONTHS[d.getMonth()];
  }
  function timeToMin(t) { var p = t.split(":"); return +p[0] * 60 + +p[1] + (p[2] ? +p[2] / 60 : 0); }
  function minToTime(m) {
    m = Math.max(0, Math.min(24 * 60 - 1, m));
    var s = Math.round(m * 60), h = Math.floor(s / 3600), mi = Math.floor((s % 3600) / 60), se = s % 60;
    return pad(h) + ":" + pad(mi) + (se ? ":" + pad(se) : "");
  }
  function countdown(ms) {
    if (ms < 0) ms = 0;
    var s = Math.ceil(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    s = s % 60;
    return h ? h + ":" + pad(m) + ":" + pad(s) : m + ":" + pad(s);
  }
  function fieldName(n) {
    var f = state.settings.fields.find(function (x) { return x.n === n; });
    return f ? f.name : "Field " + n;
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function uid() { return "g" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  // ------------------------------------------------------------------ planning
  function clipKey(type, fk) { return type + "_" + fk; }
  // the single announcer clip set in audio/jingles.js
  function voiceSet() { return window.JINGLES ? Object.keys(JINGLES.voices)[0] : null; }
  function clipDuration(key) {
    var d = window.JINGLES && JINGLES.duration[voiceSet()];
    return (d && d[key]) || 8;
  }
  function clipText(key) {
    var t = window.JINGLES && JINGLES.text[voiceSet()];
    return (t && t[key]) || key;
  }

  function replan() {
    var s = state.settings, raw = [];
    var fieldsByDate = {};
    state.games.forEach(function (g) {
      if (!g.on) return;
      (fieldsByDate[g.date] = fieldsByDate[g.date] || new Set()).add(g.field);
      var t0 = gameStart(g), add = function (type, offMin) {
        raw.push({ type: type, at: t0 + offMin * 60000, field: g.field, game: g, date: g.date });
      };
      if (s.jingles.start) add("start", 0);
      if (s.jingles.halftime && g.ht > 0 && g.ht < g.dur) {
        add("halftime", g.ht);
        if (g.ht + s.htBreak < g.dur) add("halftime_over", g.ht + s.htBreak);
      }
      if (s.jingles.five && g.dur > 5) add("five", g.dur - 5);
      if (s.jingles.end) add("end", g.dur);
    });

    // group identical moments across fields
    var groups = {};
    raw.forEach(function (r) {
      var k = r.type + "@" + r.at;
      (groups[k] = groups[k] || []).push(r);
    });
    var items = [];
    Object.keys(groups).forEach(function (k) {
      var g = groups[k], fset = new Set(g.map(function (r) { return r.field; }));
      var all = fieldsByDate[g[0].date];
      if (s.mergeFields && fset.size > 1 && all && fset.size === all.size) {
        items.push(mk(g[0].type, g[0].at, "all", g));
      } else {
        Array.from(fset).sort().forEach(function (f) {
          items.push(mk(g[0].type, g[0].at, String(Math.min(f, 4)), g.filter(function (r) { return r.field === f; })));
        });
      }
    });
    function mk(type, at, fk, rs) {
      var key = clipKey(type, fk);
      return {
        id: type + "@" + at + "@" + fk, type: type, at: at, fk: fk, key: key,
        games: rs.map(function (r) { return r.game; }), dur: clipDuration(key)
      };
    }
    items.sort(function (a, b) {
      return a.at - b.at || TYPE_PRIORITY[a.type] - TYPE_PRIORITY[b.type] || (a.fk < b.fk ? -1 : 1);
    });
    // sequence back-to-back clips so they never talk over each other
    var busy = 0;
    items.forEach(function (it) {
      it.playAt = Math.max(it.at, busy);
      busy = it.playAt + (it.dur + GAP_S) * 1000;
    });
    plan = items;
    engine.onPlanChanged();
  }

  // ------------------------------------------------------------------ audio engine
  var engine = (function () {
    var ctx = null, master = null, buffers = {};
    var scheduled = new Map();  // id -> {src, startCtx, endCtx, playAt, text, logged}
    var manual = [];            // manual clips {src,startCtx,endCtx,text,logged}
    var handled = new Set();
    var doneForGame = new Set(); // "gameId:type" - each game's announcement plays at most once
    var windowStart = clockNow();
    var armed = false, wakeLock = null, keepAlive = null;

    function b64ToBuf(dataUri) {
      var b = atob(dataUri.slice(dataUri.indexOf(",") + 1)), u = new Uint8Array(b.length);
      for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
      return u.buffer;
    }
    function decodeVoice(voice) {
      var src = JINGLES.voices[voice], keys = Object.keys(src);
      buffers = {};
      return Promise.all(keys.map(function (k) {
        return new Promise(function (res) {
          ctx.decodeAudioData(b64ToBuf(src[k]), function (b) { buffers[k] = b; res(); }, function () { res(); });
        });
      }));
    }
    function startKeepAlive() {
      // A barely-there noise floor (~-70 dBFS): keeps the tab counted as "playing audio" so the
      // browser doesn't throttle it, and stops USB/Bluetooth speakers from going to sleep.
      var len = ctx.sampleRate, b = ctx.createBuffer(1, len, ctx.sampleRate), d = b.getChannelData(0);
      for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * 0.0003;
      keepAlive = ctx.createBufferSource();
      keepAlive.buffer = b;
      keepAlive.loop = true;
      keepAlive.connect(ctx.destination);
      keepAlive.start();
    }
    function requestWakeLock() {
      if (!("wakeLock" in navigator) || document.hidden) return;
      navigator.wakeLock.request("screen").then(function (l) { wakeLock = l; }).catch(function () { /* not allowed */ });
    }
    document.addEventListener("visibilitychange", function () {
      if (armed && !document.hidden) { requestWakeLock(); if (ctx && ctx.state !== "running") ctx.resume(); }
    });

    function arm() {
      if (armed) return Promise.resolve();
      // iPhone/iPad (iOS 17+): play even with the silent switch on. Note this also pauses other
      // audio on the same device, so run Spotify on a different device.
      try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch (e) { /* unsupported */ }
      var AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC({ latencyHint: "playback" });
      master = ctx.createGain();
      master.gain.value = state.settings.volume;
      master.connect(ctx.destination);
      return ctx.resume().then(function () { return decodeVoice(voiceSet()); }).then(function () {
        startKeepAlive();
        requestWakeLock();
        armed = true;
        windowStart = clockNow();
        tick();
      });
    }

    function playBuffer(key, whenCtx) {
      var b = buffers[key];
      if (!b) return null;
      var src = ctx.createBufferSource();
      src.buffer = b;
      src.connect(master);
      src.start(whenCtx);
      return { src: src, startCtx: whenCtx, endCtx: whenCtx + b.duration };
    }
    function busyUntilCtx() {
      var t = ctx.currentTime;
      scheduled.forEach(function (s) { if (s.startCtx <= t + 0.05 && s.endCtx > t) t = s.endCtx; });
      manual.forEach(function (s) { if (s.endCtx > t) t = s.endCtx; });
      return t;
    }

    function alreadyDone(a) {
      return a.games.every(function (g) { return doneForGame.has(g.id + ":" + a.type); });
    }
    function markDone(a) {
      handled.add(a.id);
      a.games.forEach(function (g) { doneForGame.add(g.id + ":" + a.type); });
    }

    function cancelPending() {
      if (!ctx) return;
      var t = ctx.currentTime;
      scheduled.forEach(function (s, id) {
        if (s.startCtx > t + 0.02) { try { s.src.stop(); } catch (e) { /* not started */ } scheduled.delete(id); }
      });
    }

    function tick() {
      if (!armed) return;
      var now = clockNow(), ctxNow = ctx.currentTime;
      if (ctx.state !== "running") ctx.resume();
      for (var i = 0; i < plan.length; i++) {
        var a = plan[i];
        if (a.playAt > now + LOOKAHEAD_MS) break;
        if (a.playAt <= windowStart || handled.has(a.id) || scheduled.has(a.id)) continue;
        if (alreadyDone(a)) { handled.add(a.id); continue; } // e.g. game nudged +5 after it started
        if (skipped.has(a.id)) { markDone(a); addLog(a.playAt, a, "skipped"); continue; }
        if (a.playAt < now - GRACE_MS) { markDone(a); addLog(a.playAt, a, "missed"); continue; }
        var when = ctxNow + Math.max(0.05, (a.playAt - now) / 1000);
        var p = playBuffer(a.key, when);
        if (p) { p.playAt = a.playAt; p.item = a; scheduled.set(a.id, p); }
      }
      windowStart = Math.max(windowStart, now - 1);
      // bookkeeping: log clips once they actually start, forget finished ones
      scheduled.forEach(function (s, id) {
        if (!s.logged && ctxNow >= s.startCtx) { s.logged = true; markDone(s.item); addLog(clockNow(), s.item, "played"); }
        if (ctxNow > s.endCtx + 1) scheduled.delete(id);
      });
      manual = manual.filter(function (m) { return ctxNow <= m.endCtx + 1; });
    }

    function nowPlaying() {
      if (!armed) return null;
      var t = ctx.currentTime, hit = null;
      scheduled.forEach(function (s) { if (t >= s.startCtx && t < s.endCtx) hit = clipText(s.item.key); });
      manual.forEach(function (m) { if (t >= m.startCtx && t < m.endCtx) hit = m.text; });
      return hit;
    }

    return {
      arm: arm,
      isArmed: function () { return armed; },
      tick: tick,
      nowPlaying: nowPlaying,
      isScheduled: function (id) { return scheduled.has(id); },
      isDone: function (a) { return handled.has(a.id) || alreadyDone(a); },
      onPlanChanged: function () { if (armed) { cancelPending(); tick(); } },
      playNow: function (key) {
        var go = function () {
          var p = playBuffer(key, busyUntilCtx() + 0.05);
          if (p) { p.text = clipText(key); manual.push(p); addLog(clockNow(), { key: key }, "manual"); }
        };
        if (!armed) return arm().then(go);
        go();
        return Promise.resolve();
      },
      setVolume: function (v) { if (master) master.gain.setTargetAtTime(v, ctx.currentTime, 0.05); }
    };
  })();

  function addLog(ms, item, status) {
    log.unshift({ at: ms, text: clipText(item.key), key: item.key, status: status });
    if (log.length > 60) log.pop();
    if (view === "live") renderLive();
  }

  // ------------------------------------------------------------------ schedule ops
  function gamesOn(date) {
    return state.games.filter(function (g) { return g.date === date; })
      .sort(function (a, b) { return gameStart(a) - gameStart(b) || a.field - b.field; });
  }
  function dates() {
    var s = new Set(state.games.map(function (g) { return g.date; }));
    return Array.from(s).sort();
  }
  function overlaps(date) {
    var bad = new Set();
    state.settings.fields.forEach(function (f) {
      var gs = gamesOn(date).filter(function (g) { return g.on && g.field === f.n; });
      for (var i = 1; i < gs.length; i++) {
        if (gameStart(gs[i]) < gameEnd(gs[i - 1])) { bad.add(gs[i].id); bad.add(gs[i - 1].id); }
      }
    });
    return bad;
  }
  function shiftGame(g, min) { g.time = minToTime(timeToMin(g.time) + min); }
  // Shift games on a field (or all fields) that start at/after fromMin on the given date.
  function shiftFrom(s, date, field, fromMin, min) {
    var n = 0;
    s.games.forEach(function (g) {
      if (g.date === date && (field === "all" || g.field === +field) && timeToMin(g.time) >= fromMin - 1e-6) { shiftGame(g, min); n++; }
    });
    return n;
  }
  function findGame(s, id) { return s.games.find(function (g) { return g.id === id; }); }

  // ------------------------------------------------------------------ rendering helpers
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  function toast(msg, withUndo) {
    var t = $("#toast");
    t.innerHTML = esc(msg) + (withUndo ? ' <button type="button" data-act="undo">Undo</button>' : "");
    t.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove("show"); }, 4500);
  }

  function ransom(el, text, colors) {
    colors = colors || ["c-orange", "c-black", "c-yellow", "c-paper", "c-kraft", "c-lime", "c-white", "c-red"];
    var fonts = ["f-anton", "f-anton", "f-marker", "f-type"];
    var seed = 7;
    var rnd = function () { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    el.innerHTML = text.split(" ").map(function (word) {
      return '<span class="rw">' + word.split("").map(function (ch, i) {
        var c = colors[Math.floor(rnd() * colors.length)], f = fonts[Math.floor(rnd() * fonts.length)];
        var rot = (rnd() * 10 - 5).toFixed(1), dy = (rnd() * 6 - 3).toFixed(1);
        return '<span class="rl ' + c + " " + f + '" style="transform:rotate(' + rot + "deg) translateY(" + dy + 'px)">' + esc(ch) + "</span>";
      }).join("") + "</span>";
    }).join("");
  }

  function fieldChip(fk) {
    if (fk === "all") return '<span class="chip chip-all">All fields</span>';
    var n = +fk, i = (n - 1) % 4;
    return '<span class="chip chip-' + FIELD_COLORS[i] + '"><img src="' + HEADS[i] + '" alt="">' + esc(fieldName(n)) + "</span>";
  }

  function fieldOptions(sel) {
    return state.settings.fields.map(function (f) {
      return '<option value="' + f.n + '"' + (f.n === sel ? " selected" : "") + ">" + esc(f.name) + "</option>";
    }).join("");
  }
  function presetOptions(sel) {
    return state.presets.map(function (p) {
      return '<option value="' + p.id + '"' + (p.id === sel ? " selected" : "") + ">" + esc(p.name) + " (" + p.dur + "′)</option>";
    }).join("") + '<option value="custom"' + (sel === "custom" ? " selected" : "") + ">Custom</option>";
  }

  // ------------------------------------------------------------------ LIVE view
  var liveSig = "";
  function renderLive(force) {
    var now = clockNow(), today = isoDate(now);
    var el = $("#view-live");
    var upcoming = plan.filter(function (a) { return a.playAt > now - 1000 && !engine.isDone(a); }).slice(0, 8);
    var next = upcoming.find(function (a) { return !skipped.has(a.id); });
    var todayGames = gamesOn(today).filter(function (g) { return g.on; });
    var nextDay = dates().find(function (d) { return d > today; });

    // structural signature: rebuild DOM only when something other than countdowns changes
    var fieldState = state.settings.fields.map(function (f) {
      var gs = todayGames.filter(function (g) { return g.field === f.n; });
      var cur = gs.find(function (g) { return gameStart(g) <= now && now < gameEnd(g); });
      var nx = gs.find(function (g) { return gameStart(g) > now; });
      return { f: f, cur: cur, next: nx, phase: cur ? phaseOf(cur, now) : null, last: gs[gs.length - 1] };
    });
    var sig = JSON.stringify([upcoming.map(function (a) { return a.id + skipped.has(a.id) + engine.isScheduled(a.id); }),
      fieldState.map(function (x) { return [x.cur && x.cur.id, x.next && x.next.id, x.phase && x.phase.k]; }),
      log.length && log[0].at, log.length, engine.isArmed(), today, state.settings]);
    if (!force && sig === liveSig) { updateTicks(); return; }
    liveSig = sig;

    var html = "";
    // --- hero: next announcement
    html += '<div class="live-grid"><div class="hero paper tilt-l">';
    html += '<div class="tape-label">Next announcement</div>';
    if (next) {
      var ic = TYPES[next.type];
      html += '<div class="hero-type type-' + next.type + '"><span class="hero-icon">' + ic.icon + "</span>" + esc(ic.label) + "</div>";
      html += '<div class="hero-count" data-cd="' + next.playAt + '"></div>';
      html += '<div class="hero-meta">' + fieldChip(next.fk) + ' <span class="type-mono">at ' + hhmmss(next.playAt).replace(/:00$/, "") + (isoDate(next.playAt) !== today ? " · " + dayLabel(isoDate(next.playAt)) : "") + "</span></div>";
      html += '<blockquote class="hero-quote">“' + esc(clipText(next.key)) + "”</blockquote>";
    } else {
      html += '<div class="hero-type">All quiet</div><p class="muted">No more announcements scheduled. Add games in the <a href="#" data-go="schedule">Schedule</a> tab.</p>';
    }
    html += '<img class="hero-sticker" src="img/jthrow_g.webp" alt="">';
    if (!engine.isArmed()) html += '<button class="btn btn-big btn-lime hero-arm" type="button" data-act="arm">Start the jingle player</button>';
    html += "</div>";

    // --- quick adjust
    html += '<div class="quick paper tilt-r"><div class="tape-label">Running late?</div>';
    html += '<p class="muted small">Moves every game today that hasn\'t finished yet.</p><div class="btn-row">';
    html += '<button class="btn" type="button" data-act="shift-all" data-min="-5">−5 min</button>';
    html += '<button class="btn" type="button" data-act="shift-all" data-min="-1">−1</button>';
    html += '<button class="btn" type="button" data-act="shift-all" data-min="1">+1</button>';
    html += '<button class="btn btn-orange" type="button" data-act="shift-all" data-min="5">+5 min</button>';
    html += "</div>";
    html += '<div class="tape-label tape-sm">Soundboard</div><div class="sb-fields">';
    var sbf = renderLive.sbf || "1";
    html += state.settings.fields.map(function (f) {
      var v = String(Math.min(f.n, 4));
      return '<label class="sb-f"><input type="radio" name="sbf" value="' + v + '"' + (sbf === v ? " checked" : "") + "><span>" + esc(f.name) + "</span></label>";
    }).join("") + '<label class="sb-f"><input type="radio" name="sbf" value="all"' + (sbf === "all" ? " checked" : "") + "><span>All fields</span></label></div>";
    html += '<div class="sb-btns">' + ["start", "halftime", "halftime_over", "five", "end"].map(function (t) {
      return '<button class="btn sb type-' + t + '" type="button" data-act="sb" data-type="' + t + '"><span>' + TYPES[t].icon + "</span>" + TYPES[t].short + "</button>";
    }).join("") + '<button class="btn sb" type="button" data-act="test"><span>🔊</span>Test</button></div>';
    html += "</div></div>";

    // --- fields
    html += '<h2 class="sec">' + (todayGames.length ? "Today · " + dayLabel(today, true) : "Fields") + "</h2>";
    if (!todayGames.length) {
      html += '<div class="paper empty">No games today.' + (nextDay ? " Next game day: <b>" + dayLabel(nextDay, true) + "</b>. The player will announce automatically if this window stays open." : "") + "</div>";
    } else {
      html += '<div class="fields">' + fieldState.map(renderFieldCard).join("") + "</div>";
    }

    // --- upcoming + log
    html += '<div class="two-col"><div class="paper list"><div class="tape-label">Coming up</div>';
    html += upcoming.length ? '<ul class="ann">' + upcoming.map(function (a) {
      var sk = skipped.has(a.id);
      return '<li class="' + (sk ? "is-skipped" : "") + '"><span class="t type-mono">' + hhmm(a.playAt) + '</span><span class="ic type-' + a.type + '">' + TYPES[a.type].icon + '</span><span class="what">' + esc(TYPES[a.type].label) + " " + fieldChip(a.fk) +
        '</span><span class="cd type-mono" data-cd="' + a.playAt + '"></span><button class="btn btn-xs" type="button" data-act="skip" data-id="' + esc(a.id) + '">' + (sk ? "Unskip" : "Skip") + "</button></li>";
    }).join("") + "</ul>" : '<p class="muted">Nothing coming up.</p>';
    html += '</div><div class="paper list"><div class="tape-label">Played</div>';
    html += log.length ? '<ul class="ann log">' + log.slice(0, 10).map(function (l) {
      return '<li class="st-' + l.status + '"><span class="t type-mono">' + hhmm(l.at) + '</span><span class="what">' + esc(l.text) + '</span><span class="st">' + l.status + "</span></li>";
    }).join("") + "</ul>" : '<p class="muted">Nothing played yet.</p>';
    html += "</div></div>";

    el.innerHTML = html;
    updateTicks();
  }

  function phaseOf(g, now) {
    var t = (now - gameStart(g)) / 60000, s = state.settings;
    if (t >= g.dur - 5) return { k: "last5", label: "Last 5 minutes" };
    if (s.jingles.halftime && g.ht > 0 && t >= g.ht && t < g.ht + s.htBreak) return { k: "ht", label: "Halftime break" };
    if (g.ht > 0 && t >= g.ht) return { k: "h2", label: "Second half" };
    return { k: "h1", label: g.ht > 0 ? "First half · HT cap " + hhmm(gameStart(g) + g.ht * 60000) : "In play" };
  }

  function renderFieldCard(x, i) {
    var f = x.f, g = x.cur, nx = x.next, html = "";
    var col = FIELD_COLORS[(f.n - 1) % 4];
    html += '<div class="field paper fc-' + col + '"><div class="field-head"><img src="' + HEADS[(f.n - 1) % 4] + '" alt=""><div><div class="field-name">' + esc(f.name) + '</div><div class="field-sub type-mono">Field ' + f.n + "</div></div></div>";
    if (g) {
      var t0 = gameStart(g), t1 = gameEnd(g);
      html += '<div class="match">' + esc(g.label || "Game") + '</div><div class="note">' + esc(g.note || "") + "</div>";
      html += '<div class="phase ph-' + x.phase.k + '">' + esc(x.phase.label) + "</div>";
      html += '<div class="bar"><div class="bar-fill" data-prog="' + t0 + "," + t1 + '"></div>';
      if (g.ht > 0 && g.ht < g.dur) html += '<i class="mk mk-ht" style="left:' + (g.ht / g.dur * 100) + '%" title="Halftime"></i>';
      if (g.dur > 5) html += '<i class="mk mk-5" style="left:' + ((g.dur - 5) / g.dur * 100) + '%" title="5 min left"></i>';
      html += "</div>";
      html += '<div class="bar-legend type-mono"><span>' + hhmm(t0) + '</span><span><b data-cd="' + t1 + '"></b> left</span><span>' + hhmm(t1) + "</span></div>";
    } else if (nx) {
      html += '<div class="idle">Next up at <b>' + hhmm(gameStart(nx)) + '</b> · in <b data-cd="' + gameStart(nx) + '"></b></div><div class="match">' + esc(nx.label || "Game") + '</div><div class="note">' + esc(nx.note || "") + "</div>";
    } else {
      html += '<div class="idle done">Done for today 🍻</div>';
    }
    if (g && nx) html += '<div class="after type-mono">Then ' + hhmm(gameStart(nx)) + " · " + esc(nx.label) + "</div>";
    html += '<div class="btn-row">';
    if (nx) html += '<button class="btn btn-lime" type="button" data-act="start-now" data-id="' + nx.id + '" title="Start the next game on this field right now">▶ Start next game now</button>';
    if (g || nx) {
      html += '<button class="btn" type="button" data-act="shift-field" data-field="' + f.n + '" data-min="-5">−5</button>';
      html += '<button class="btn" type="button" data-act="shift-field" data-field="' + f.n + '" data-min="5">+5</button>';
    }
    html += "</div></div>";
    return html;
  }

  function updateTicks() {
    var now = clockNow();
    $$("[data-cd]").forEach(function (e) { e.textContent = countdown(+e.getAttribute("data-cd") - now); });
    $$("[data-prog]").forEach(function (e) {
      var p = e.getAttribute("data-prog").split(","), a = +p[0], b = +p[1];
      e.style.width = Math.max(0, Math.min(100, (now - a) / (b - a) * 100)) + "%";
    });
    var nl = $("#now-line");
    if (nl) positionNowLine(nl);
  }

  // ------------------------------------------------------------------ SCHEDULE view
  var PX_PER_MIN = 2.2;
  function renderSchedule() {
    var el = $("#view-schedule"), ds = dates(), today = isoDate(clockNow());
    if (!schedDay || ds.indexOf(schedDay) < 0) schedDay = ds.indexOf(today) >= 0 ? today : (ds.find(function (d) { return d >= today; }) || ds[0] || today);
    var games = gamesOn(schedDay), bad = overlaps(schedDay);
    var html = '<div class="sched-top">';
    html += '<div class="days">' + ds.map(function (d) {
      return '<button type="button" class="day' + (d === schedDay ? " on" : "") + '" data-day="' + d + '">' + dayLabel(d) + (d === today ? ' <span class="today">today</span>' : "") + "</button>";
    }).join("") + '<label class="day day-add" title="Add a game day"><span>+ Day</span><input type="date" id="add-day"></label></div>';
    html += '<div class="sched-actions">' +
      '<button class="btn btn-lime" type="button" data-act="add-game">+ Add game</button>' +
      '<button class="btn" type="button" data-act="undo">↶ Undo</button>' +
      '<button class="btn" type="button" data-act="import-open">Paste from ultie.org</button>' +
      '<button class="btn" type="button" data-act="export">Save file</button>' +
      '<button class="btn" type="button" data-act="import-file">Load file</button>' +
      "</div></div>";

    // shift tool
    html += '<div class="paper shift-tool"><span class="tape-label tape-inline">Shift</span> games on <select id="sh-field"><option value="all">all fields</option>' + fieldOptions(-1) +
      '</select> starting at or after <input type="time" id="sh-from" value="' + (schedDay === today ? hhmm(clockNow()) : "00:00") + '"> by <input type="number" id="sh-min" value="5" step="5" class="num"> min <button class="btn btn-orange" type="button" data-act="shift-tool">Apply</button>' +
      '<label class="chk ripple"><input type="checkbox" id="ripple"' + (state.settings.ripple ? " checked" : "") + '> Dragging or retiming a game also moves the later games on its field</label></div>';

    // timeline
    html += renderTimeline(games, bad);

    // table
    if (bad.size) html += '<div class="warn">⚠ Some games overlap on the same field (marked red). Fine if intentional; otherwise drag them apart or shorten them.</div>';
    html += '<div class="paper table-wrap"><table class="sched"><thead><tr><th title="Announcements on/off">On</th><th>Start</th><th>Field</th><th>Type</th><th>Length</th><th>HT at</th><th>Ends</th><th>Matchup</th><th>Note</th><th></th></tr></thead><tbody>';
    html += games.map(function (g) {
      var cls = (bad.has(g.id) ? "overlap " : "") + (g.on ? "" : "off ") + (gameEnd(g) < clockNow() ? "past" : "");
      return '<tr class="' + cls + '" data-id="' + g.id + '">' +
        '<td><input type="checkbox" data-f="on"' + (g.on ? " checked" : "") + "></td>" +
        '<td><input type="time" data-f="time" value="' + g.time + '"' + (g.time.length > 5 ? ' step="1"' : "") + "></td>" +
        '<td><select data-f="field">' + fieldOptions(g.field) + "</select></td>" +
        '<td><select data-f="preset">' + presetOptions(g.preset) + "</select></td>" +
        '<td><input type="number" class="num" min="6" max="180" data-f="dur" value="' + g.dur + '">′</td>' +
        '<td><input type="number" class="num" min="0" max="179" data-f="ht" value="' + g.ht + '" title="0 = no halftime">′</td>' +
        '<td class="type-mono">' + hhmm(gameEnd(g)) + "</td>" +
        '<td><input type="text" data-f="label" value="' + esc(g.label) + '" placeholder="Team A vs Team B"></td>' +
        '<td><input type="text" data-f="note" value="' + esc(g.note) + '" placeholder="Division / round"></td>' +
        '<td class="row-act"><button class="btn btn-xs" type="button" data-act="dup" title="Duplicate">⧉</button><button class="btn btn-xs btn-del" type="button" data-act="del" title="Delete">✕</button></td></tr>';
    }).join("");
    if (!games.length) html += '<tr><td colspan="10" class="muted center">No games on this day yet. Click “+ Add game”.</td></tr>';
    html += "</tbody></table></div>";
    html += '<p class="muted small center">Changes save automatically in this browser. Use “Save file” to back up or move the schedule to another laptop. <a href="#" data-act="reset">Reset to tournament default</a></p>';
    el.innerHTML = html;
    var nl = $("#now-line");
    if (nl) positionNowLine(nl);
  }

  var tlStartMin = 0;
  function renderTimeline(games, bad) {
    if (!games.length) return "";
    var mins = games.map(function (g) { return timeToMin(g.time); });
    var ends = games.map(function (g) { return timeToMin(g.time) + g.dur; });
    var a = Math.floor((Math.min.apply(null, mins) - 10) / 30) * 30, b = Math.ceil((Math.max.apply(null, ends) + 10) / 30) * 30;
    tlStartMin = a;
    // fit the day into the available width (scrolls only when it would get too cramped)
    var avail = ($("#view-schedule").clientWidth || 1200) - 32 - 150 - 4;
    PX_PER_MIN = Math.max(1.6, Math.min(4, avail / (b - a)));
    var w = (b - a) * PX_PER_MIN, html = '<div class="paper tl-wrap"><div class="tl" style="width:' + (w + 150) + 'px">';
    html += '<div class="tl-axis" style="margin-left:150px;width:' + w + 'px">';
    for (var m = Math.ceil(a / 60) * 60; m <= b; m += 60) html += '<span style="left:' + ((m - a) * PX_PER_MIN) + 'px">' + pad(m / 60) + ":00</span>";
    html += "</div>";
    state.settings.fields.forEach(function (f, i) {
      html += '<div class="tl-lane" data-field="' + f.n + '"><div class="tl-name"><img src="' + HEADS[i % 4] + '" alt="">' + esc(f.name) + '</div><div class="tl-track" style="width:' + w + 'px">';
      for (var m = a; m <= b; m += 30) html += '<i class="grid' + (m % 60 ? " half" : "") + '" style="left:' + ((m - a) * PX_PER_MIN) + 'px"></i>';
      games.filter(function (g) { return g.field === f.n; }).forEach(function (g) {
        var x = (timeToMin(g.time) - a) * PX_PER_MIN, gw = g.dur * PX_PER_MIN;
        html += '<div class="tl-game fc-' + FIELD_COLORS[i % 4] + (bad.has(g.id) ? " overlap" : "") + (g.on ? "" : " off") + '" data-id="' + g.id + '" style="left:' + x + "px;width:" + gw + 'px" title="' + esc(g.label + " · " + g.note) + '">' +
          (g.ht > 0 && g.ht < g.dur ? '<i class="tl-ht" style="left:' + (g.ht / g.dur * 100) + '%"></i>' : "") +
          '<i class="tl-5" style="left:' + ((g.dur - 5) / g.dur * 100) + '%"></i>' +
          '<b class="type-mono">' + g.time.slice(0, 5) + "</b><span>" + esc(g.label) + "</span></div>";
      });
      html += "</div></div>";
    });
    html += '<div id="now-line" class="now-line" data-left="150"></div>';
    html += '</div></div><p class="muted small tl-help">Drag a game sideways to retime it (5-minute steps) or up/down to change field. Red = overlapping on the same field.</p>';
    return html;
  }
  function positionNowLine(nl) {
    var now = clockNow();
    if (view !== "schedule" || isoDate(now) !== schedDay) { nl.style.display = "none"; return; }
    var d = new Date(now), m = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
    var x = (m - tlStartMin) * PX_PER_MIN;
    var track = $(".tl-track");
    if (x < 0 || !track || x > track.offsetWidth) { nl.style.display = "none"; return; }
    nl.style.display = "block";
    nl.style.left = (150 + x) + "px";
  }

  // timeline dragging
  var drag = null;
  document.addEventListener("pointerdown", function (e) {
    var gEl = e.target.closest && e.target.closest(".tl-game");
    if (!gEl || e.button !== 0) return;
    e.preventDefault();
    drag = { el: gEl, id: gEl.getAttribute("data-id"), x0: e.clientX, y0: e.clientY, dMin: 0, field: null, moved: false };
    try { gEl.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
    gEl.classList.add("dragging");
  });
  document.addEventListener("pointermove", function (e) {
    if (!drag) return;
    var dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    drag.dMin = Math.round(dx / PX_PER_MIN / 5) * 5;
    var lane = document.elementsFromPoint(e.clientX, e.clientY).map(function (n) { return n.closest && n.closest(".tl-lane"); }).find(Boolean);
    drag.field = lane ? +lane.getAttribute("data-field") : null;
    var g = findGame(state, drag.id), laneEl = drag.el.closest(".tl-lane");
    var dyPx = lane && laneEl ? lane.getBoundingClientRect().top - laneEl.getBoundingClientRect().top : 0;
    drag.el.style.transform = "translate(" + (drag.dMin * PX_PER_MIN) + "px," + dyPx + "px)";
    drag.el.querySelector("b").textContent = minToTime(timeToMin(g.time) + drag.dMin).slice(0, 5);
  });
  document.addEventListener("pointerup", function () {
    if (!drag) return;
    var d = drag;
    drag = null;
    var g = findGame(state, d.id);
    var fieldChanged = d.field && d.field !== g.field;
    if (!d.moved || (!d.dMin && !fieldChanged)) {
      d.el.style.transform = "";
      d.el.classList.remove("dragging");
      var row = $('tr[data-id="' + d.id + '"]');
      if (row && !d.moved) { row.scrollIntoView({ block: "center", behavior: "smooth" }); row.classList.add("flash"); setTimeout(function () { row.classList.remove("flash"); }, 1200); }
      return;
    }
    commit(function (s) {
      var gg = findGame(s, d.id), from = timeToMin(gg.time);
      if (d.dMin && s.settings.ripple && !fieldChanged) {
        s.games.forEach(function (o) { if (o !== gg && o.date === gg.date && o.field === gg.field && timeToMin(o.time) > from) shiftGame(o, d.dMin); });
      }
      shiftGame(gg, d.dMin);
      if (fieldChanged) gg.field = d.field;
    }, (g.label || "Game") + " → " + minToTime(timeToMin(g.time) + d.dMin).slice(0, 5) + (fieldChanged ? " on " + fieldName(d.field) : "") + (d.dMin && state.settings.ripple && !fieldChanged ? " (later games moved too)" : ""));
  });

  // ------------------------------------------------------------------ SETTINGS view
  function renderSettings() {
    var s = state.settings, el = $("#view-settings"), html = '<div class="settings-grid">';
    // voice
    html += '<div class="paper set-card tilt-l"><div class="tape-label">Announcer</div><div class="announcer-row"><img src="img/jrun_a_o.webp" alt=""><p>Same voice as Disc Fiction’s <em>Ultimate in a Minute</em> explainer.</p><button type="button" class="btn" data-act="test">🔊 Test sound</button></div>';
    html += '<label class="vol">Jingle volume <input type="range" id="vol" min="0" max="1" step="0.05" value="' + s.volume + '"><b id="vol-v">' + Math.round(s.volume * 100) + "%</b></label>";
    html += '<p class="muted small">Keep this at 100% and turn <b>Spotify</b> down to ~75% with its own slider, so the jingles stand out over the music. Jingles are already mastered extra-loud.</p></div>';

    // jingles
    html += '<div class="paper set-card tilt-r"><div class="tape-label">Which jingles</div>';
    [["start", "Game start", "“Time is running. Pull when ready!”"], ["five", "5 minutes left", "5 minutes before each game's time cap"],
      ["halftime", "Halftime + halftime over", "At each game's halftime minute, and again after the break"], ["end", "Time cap / game over", "When a game's time is up"]].forEach(function (j) {
      html += '<label class="toggle"><input type="checkbox" data-jingle="' + j[0] + '"' + (s.jingles[j[0]] ? " checked" : "") + '><span class="sw"></span><span><b>' + j[1] + "</b><small>" + j[2] + "</small></span></label>";
    });
    html += '<label class="inline">Halftime break <input type="number" class="num" id="htbreak" min="1" max="15" value="' + s.htBreak + '"> min</label>';
    html += '<label class="toggle"><input type="checkbox" id="merge"' + (s.mergeFields ? " checked" : "") + '><span class="sw"></span><span><b>Say “all fields” when every field hits the same moment</b><small>Otherwise each field is announced one after another</small></span></label>';
    html += "</div>";

    // fields
    html += '<div class="paper set-card tilt-l"><div class="tape-label">Fields</div><p class="muted small">Announcements say “field one”, “field two”, … (up to 4). Names are only shown on screen.</p>';
    s.fields.forEach(function (f, i) {
      html += '<div class="field-row"><img src="' + HEADS[i % 4] + '" alt=""><span class="type-mono">Field ' + f.n + '</span><input type="text" data-fieldname="' + f.n + '" value="' + esc(f.name) + '">' + (s.fields.length > 1 && i === s.fields.length - 1 ? '<button type="button" class="btn btn-xs btn-del" data-act="rm-field">✕</button>' : "") + "</div>";
    });
    if (s.fields.length < 4) html += '<button class="btn btn-xs" type="button" data-act="add-field">+ Add field</button>';
    html += "</div>";

    // presets
    html += '<div class="paper set-card tilt-r"><div class="tape-label">Game types</div><p class="muted small">Picking a type in the schedule fills in length and halftime minute. Values from the ultie.org regulations.</p><table class="presets"><thead><tr><th>Name</th><th>Length</th><th>HT at</th></tr></thead><tbody>';
    state.presets.forEach(function (p, i) {
      html += '<tr><td><input type="text" data-preset="' + i + '" data-pf="name" value="' + esc(p.name) + '"></td><td><input type="number" class="num" data-preset="' + i + '" data-pf="dur" value="' + p.dur + '">′</td><td><input type="number" class="num" data-preset="' + i + '" data-pf="ht" value="' + p.ht + '">′</td></tr>';
    });
    html += '</tbody></table><label class="chk"><input type="checkbox" id="preset-apply" checked> Editing a type updates all games of that type</label></div>';

    html += '<div class="paper set-card help tilt-l"><div class="tape-label">On the day</div><ol>' +
      "<li>Open this page on the laptop that's plugged into the speaker. Press <b>Start</b>; you should hear the test sound.</li>" +
      "<li>Laptop volume 100%, Spotify slider ~75%. Plug in the charger, and turn off sleep/screen saver if you can.</li>" +
      "<li>Leave this window open. Other apps are fine. The jingles play on their own.</li>" +
      "<li>Field running late? Use <b>+5</b> on that field (Live tab), or <b>▶ Start next game now</b> when the teams are ready to pull.</li>" +
      "<li>Bigger changes: <b>Schedule</b> tab. Drag games on the timeline or edit the table. Everything saves automatically.</li>" +
      "</ol></div>";
    html += "</div>";
    el.innerHTML = html;
  }

  // ------------------------------------------------------------------ view switching
  function setView(v) {
    view = v;
    $$(".tab").forEach(function (t) { t.classList.toggle("on", t.getAttribute("data-view") === v); });
    $$(".view").forEach(function (s) { s.classList.toggle("on", s.id === "view-" + v); });
    try { localStorage.setItem(STORE_KEY + ".view", v); } catch (e) { /* ignore */ }
    renderAll();
  }
  function renderAll() {
    $("#top-tournament").textContent = state.tournament || "";
    if (view === "live") renderLive(true);
    if (view === "schedule") keepFocus(renderSchedule);
    if (view === "settings") keepFocus(renderSettings);
  }
  // Re-render after the browser has moved focus (e.g. Tab out of a field), then put the
  // cursor back on the equivalent element in the fresh DOM.
  function keepFocus(render) {
    setTimeout(function () {
      var a = document.activeElement, sel = null, caret = null;
      if (a && a !== document.body && a.closest && a.closest("main")) {
        if (a.id) sel = "#" + a.id;
        else {
          sel = a.tagName.toLowerCase() + Array.prototype.map.call(a.attributes, function (at) {
            return /^data-|^name$/.test(at.name) ? "[" + at.name + '="' + at.value + '"]' : "";
          }).join("") + (a.type === "radio" ? '[value="' + a.value + '"]' : "");
          var row = a.closest("tr[data-id]");
          if (row) sel = 'tr[data-id="' + row.getAttribute("data-id") + '"] ' + sel;
        }
        try { caret = a.selectionStart; } catch (e) { /* not a text input */ }
      }
      render();
      if (sel) {
        var n = document.querySelector(sel);
        if (n) { n.focus({ preventScroll: true }); try { if (caret != null) n.setSelectionRange(caret, caret); } catch (e) { /* ignore */ } }
      }
    }, 0);
  }

  // ------------------------------------------------------------------ events
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-act],[data-view],[data-day],[data-go]");
    if (!t) return;
    if (t.hasAttribute("data-view")) { setView(t.getAttribute("data-view")); return; }
    if (t.hasAttribute("data-go")) { e.preventDefault(); setView(t.getAttribute("data-go")); return; }
    if (t.hasAttribute("data-day")) { schedDay = t.getAttribute("data-day"); renderSchedule(); return; }
    var act = t.getAttribute("data-act"), row = t.closest("tr[data-id]"), id = row && row.getAttribute("data-id");
    var now = clockNow(), today = isoDate(now), nowMin = new Date(now).getHours() * 60 + new Date(now).getMinutes() + new Date(now).getSeconds() / 60;
    switch (act) {
      case "undo": undo(); break;
      case "arm": armUI(true); break;
      case "test": engine.playNow("test"); break;
      case "sb": {
        var fk = ($('input[name="sbf"]:checked') || {}).value || "1";
        renderLive.sbf = fk;
        engine.playNow(t.getAttribute("data-type") + "_" + fk);
        break;
      }
      case "skip": {
        var aid = t.getAttribute("data-id");
        if (skipped.has(aid)) skipped.delete(aid); else skipped.add(aid);
        saveSkipped();
        engine.onPlanChanged();
        renderLive(true);
        break;
      }
      case "shift-all": {
        var m = +t.getAttribute("data-min");
        commit(function (s) {
          s.games.forEach(function (g) { if (g.date === today && gameEnd(g) > now) shiftGame(g, m); });
        }, "Today's remaining games moved " + (m > 0 ? "+" : "") + m + " min");
        break;
      }
      case "shift-field": {
        var mm = +t.getAttribute("data-min"), fld = +t.getAttribute("data-field");
        commit(function (s) {
          s.games.forEach(function (g) { if (g.date === today && g.field === fld && gameEnd(g) > now) shiftGame(g, mm); });
        }, fieldName(fld) + ": remaining games " + (mm > 0 ? "+" : "") + mm + " min");
        break;
      }
      case "start-now": {
        var gid = t.getAttribute("data-id"), g0 = findGame(state, gid);
        var running = state.games.find(function (g) { return g.on && g.date === g0.date && g.field === g0.field && gameStart(g) <= now && now < gameEnd(g); });
        if (running && !confirm((running.label || "A game") + " is still running on this field until " + hhmm(gameEnd(running)) + ".\n\nStart “" + (g0.label || "the next game") + "” now anyway?")) break;
        var newMin = nowMin + 3 / 60; // 3 s from now, so the start jingle plays right away
        var delta = newMin - timeToMin(g0.time);
        commit(function (s) {
          var g = findGame(s, gid), from = timeToMin(g.time);
          if (s.settings.ripple && delta > 0) s.games.forEach(function (o) { if (o !== g && o.date === g.date && o.field === g.field && timeToMin(o.time) > from) o.time = minToTime(Math.round(timeToMin(o.time) + delta)); });
          g.time = minToTime(newMin);
        }, (g0.label || "Game") + " starts now" + (state.settings.ripple && delta > 0 ? " (later games on this field moved +" + Math.round(delta) + " min)" : ""));
        break;
      }
      case "add-game": {
        var gs = gamesOn(schedDay).filter(function (g) { return g.field === 1; });
        var last = gs[gs.length - 1], p = state.presets[0];
        var startMin = last ? Math.ceil((timeToMin(last.time) + last.dur + 5) / 5) * 5 : 9 * 60;
        var ng = { id: uid(), date: schedDay, time: minToTime(startMin), field: 1, preset: p.id, dur: p.dur, ht: p.ht, label: "", note: "", on: true };
        commit(function (s) { s.games.push(ng); }, "Game added at " + ng.time);
        setTimeout(function () { var r = $('tr[data-id="' + ng.id + '"] input[data-f="label"]'); if (r) r.focus(); }, 50);
        break;
      }
      case "dup": commit(function (s) {
        var g = findGame(s, id), c = clone(g);
        c.id = uid();
        c.time = minToTime(timeToMin(g.time) + g.dur + 5);
        s.games.push(c);
      }, "Game duplicated"); break;
      case "del": commit(function (s) { s.games = s.games.filter(function (g) { return g.id !== id; }); }, "Game deleted"); break;
      case "shift-tool": {
        var f = $("#sh-field").value, from = $("#sh-from").value || "00:00", by = +$("#sh-min").value || 0;
        var n = 0;
        commit(function (s) { n = shiftFrom(s, schedDay, f, timeToMin(from), by); });
        toast(n + " game(s) moved " + (by > 0 ? "+" : "") + by + " min", true);
        break;
      }
      case "export": exportJson(); break;
      case "import-file": $("#file-json").click(); break;
      case "import-open": openImport(); break;
      case "reset":
        e.preventDefault();
        if (confirm("Replace the whole schedule and settings with the tournament defaults?")) commit(function (s) { var d = clone(window.DEFAULT_STATE); Object.keys(d).forEach(function (k) { s[k] = d[k]; }); }, "Reset to tournament default");
        break;
      case "add-field": commit(function (s) { var n = s.settings.fields.length + 1; s.settings.fields.push({ n: n, name: "Field " + n }); }); break;
      case "rm-field": commit(function (s) {
        var f = s.settings.fields.pop();
        s.games.forEach(function (g) { if (g.field === f.n) g.field = 1; });
      }, "Field removed (its games moved to field 1)"); break;
    }
  });

  // schedule table + settings inputs
  document.addEventListener("change", function (e) {
    var t = e.target;
    var row = t.closest && t.closest("tr[data-id]");
    if (row && t.hasAttribute("data-f")) {
      var id = row.getAttribute("data-id"), f = t.getAttribute("data-f");
      commit(function (s) {
        var g = findGame(s, id);
        if (f === "on") g.on = t.checked;
        else if (f === "time") {
          if (!t.value) return;
          var delta = timeToMin(t.value) - timeToMin(g.time);
          if (s.settings.ripple && delta) s.games.forEach(function (o) { if (o !== g && o.date === g.date && o.field === g.field && timeToMin(o.time) > timeToMin(g.time)) shiftGame(o, delta); });
          g.time = t.value;
        } else if (f === "field") g.field = +t.value;
        else if (f === "preset") {
          g.preset = t.value;
          var p = s.presets.find(function (x) { return x.id === t.value; });
          if (p) { g.dur = p.dur; g.ht = p.ht; }
        } else if (f === "dur" || f === "ht") { g[f] = Math.max(0, +t.value || 0); g.preset = "custom"; }
        else g[f] = t.value;
      });
      return;
    }
    if (t.id === "add-day" && t.value) {
      var p = state.presets[0], d = t.value;
      commit(function (s) { s.games.push({ id: uid(), date: d, time: "09:00", field: 1, preset: p.id, dur: p.dur, ht: p.ht, label: "", note: "", on: true }); }, "Day added");
      schedDay = d;
      renderSchedule();
      return;
    }
    if (t.name === "sbf") { renderLive.sbf = t.value; return; }
    if (t.id === "ripple") { commit(function (s) { s.settings.ripple = t.checked; }); return; }
    if (t.hasAttribute && t.hasAttribute("data-jingle")) { var k = t.getAttribute("data-jingle"); commit(function (s) { s.settings.jingles[k] = t.checked; }); return; }
    if (t.id === "htbreak") { commit(function (s) { s.settings.htBreak = Math.max(1, +t.value || 2); }); return; }
    if (t.id === "merge") { commit(function (s) { s.settings.mergeFields = t.checked; }); return; }
    if (t.hasAttribute && t.hasAttribute("data-fieldname")) { var n = +t.getAttribute("data-fieldname"); commit(function (s) { s.settings.fields.find(function (x) { return x.n === n; }).name = t.value || "Field " + n; }); return; }
    if (t.hasAttribute && t.hasAttribute("data-preset")) {
      var i = +t.getAttribute("data-preset"), pf = t.getAttribute("data-pf"), apply = $("#preset-apply").checked;
      commit(function (s) {
        var pr = s.presets[i];
        pr[pf] = pf === "name" ? t.value : Math.max(0, +t.value || 0);
        if (apply && pf !== "name") s.games.forEach(function (g) { if (g.preset === pr.id) { g.dur = pr.dur; g.ht = pr.ht; } });
      });
      return;
    }
  });
  document.addEventListener("input", function (e) {
    if (e.target.id === "vol") {
      var v = +e.target.value;
      state.settings.volume = v;
      $("#vol-v").textContent = Math.round(v * 100) + "%";
      engine.setVolume(v);
      save();
    }
  });
  document.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "z" && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); undo(); }
  });
  window.addEventListener("beforeunload", function (e) {
    if (engine.isArmed()) { e.preventDefault(); e.returnValue = "The jingle player is running. Closing this page stops the announcements."; }
  });

  // ------------------------------------------------------------------ import / export
  function exportJson() {
    var blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "jingleplayer-schedule-" + isoDate(clockNow()) + ".json";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  $("#file-json").addEventListener("change", function (e) {
    var f = e.target.files[0];
    if (!f) return;
    f.text().then(function (txt) {
      var s = JSON.parse(txt);
      if (!s || !Array.isArray(s.games) || !s.settings) throw new Error("bad");
      commit(function (st) { Object.keys(s).forEach(function (k) { st[k] = s[k]; }); }, "Schedule loaded from " + f.name);
    }).catch(function () { toast("That file isn't a Jingle Player schedule"); });
    e.target.value = "";
  });

  // Parse the text you get by copy-pasting ultie.org's "Games → Scheduled" list.
  function parseUltie(text, presetGroup, presetFinal) {
    var lines = text.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
    var out = [], buf = [], year = new Date().getFullYear(), fieldMap = {}, newFields = [];
    state.settings.fields.forEach(function (f) { fieldMap[f.name.toLowerCase()] = f.n; });
    for (var i = 0; i < lines.length; i++) {
      var tm = lines[i].match(/^(\d{1,2}):(\d{2})\s+(\d{1,2})\.(\d{1,2})\.?(\d{4})?$/);
      if (tm && i > 0 && lines[i - 1].indexOf("•") > 0) {
        var meta = lines[i - 1].split("•").map(function (x) { return x.trim(); });
        var division = meta.slice(0, -1).join(" · "), fieldStr = meta[meta.length - 1];
        // team names: groups separated by "-" lines; each group's last line is the team name
        var teamLines = buf.slice(0, -1), groups = [[]];
        teamLines.forEach(function (l) { if (l === "-" || l === "–") groups.push([]); else groups[groups.length - 1].push(l); });
        var teams = groups.filter(function (g) { return g.length; }).map(function (g) { return g[g.length - 1]; }).slice(-2);
        var fkey = fieldStr.toLowerCase(), fn = fieldMap[fkey];
        if (!fn) {
          var num = fieldStr.match(/(\d+)\s*$/);
          fn = num ? +num[1] : Object.keys(fieldMap).length + 1;
          fieldMap[fkey] = fn;
          newFields.push({ n: fn, name: fieldStr });
        }
        var yr = tm[5] ? +tm[5] : year;
        var isFinal = /place|1\/2|final|semi|crossover|5-7|1-4/i.test(division) && !/^group/i.test(division);
        var p = isFinal ? presetFinal : presetGroup;
        out.push({
          id: uid() + out.length, date: yr + "-" + pad(+tm[4]) + "-" + pad(+tm[3]), time: pad(+tm[1]) + ":" + tm[2],
          field: Math.min(4, fn), preset: p.id, dur: p.dur, ht: p.ht, label: teams.join(" vs "), note: division, on: true
        });
        buf = [];
      } else buf.push(lines[i]);
    }
    return { games: out, newFields: newFields };
  }
  function openImport() {
    var dlg = $("#dlg-import");
    $("#import-preset-group").innerHTML = presetOptions(state.presets[0].id).replace(/<option value="custom".*?<\/option>/, "");
    $("#import-preset-final").innerHTML = presetOptions(state.presets[1] ? state.presets[1].id : state.presets[0].id).replace(/<option value="custom".*?<\/option>/, "");
    $("#import-preview").textContent = "";
    dlg.showModal();
  }
  function importPresets() {
    var pg = state.presets.find(function (p) { return p.id === $("#import-preset-group").value; });
    var pf = state.presets.find(function (p) { return p.id === $("#import-preset-final").value; });
    return parseUltie($("#import-text").value, pg, pf);
  }
  $("#import-text").addEventListener("input", function () {
    var r = importPresets(), ds = Array.from(new Set(r.games.map(function (g) { return g.date; })));
    $("#import-preview").textContent = r.games.length ? "Found " + r.games.length + " games on " + ds.map(function (d) { return dayLabel(d); }).join(", ") + "." : "No games recognised yet.";
  });
  $("#dlg-import").addEventListener("close", function () {
    if ($("#dlg-import").returnValue !== "ok") return;
    var r = importPresets();
    if (!r.games.length) { toast("No games found in the pasted text"); return; }
    var ds = new Set(r.games.map(function (g) { return g.date; })), replace = $("#import-replace").checked;
    commit(function (s) {
      if (replace) s.games = s.games.filter(function (g) { return !ds.has(g.date); });
      r.newFields.forEach(function (f) { if (f.n <= 4 && !s.settings.fields.some(function (x) { return x.n === f.n; })) s.settings.fields.push(f); });
      s.settings.fields.sort(function (a, b) { return a.n - b.n; });
      s.games = s.games.concat(r.games);
    }, "Imported " + r.games.length + " games");
    schedDay = Array.from(ds).sort()[0];
    setView("schedule");
    $("#import-text").value = "";
  });

  // ------------------------------------------------------------------ arming
  function armUI(withTest) {
    $("#gate").classList.add("gone");
    return engine.arm().then(function () {
      if (withTest) engine.playNow("test");
      renderAll();
      updateOnAir();
    }).catch(function (err) {
      toast("Couldn't start audio: " + err.message);
    });
  }
  function updateOnAir() {
    var on = engine.isArmed(), b = $("#onair");
    b.classList.toggle("on", on);
    $("#onair-text").textContent = on ? "On air" : "Off air · click to start";
  }
  $("#gate-start").addEventListener("click", function () { armUI(true); });
  $("#gate-silent").addEventListener("click", function () { armUI(false); });
  $("#onair").addEventListener("click", function () { if (!engine.isArmed()) armUI(true); else engine.playNow("test"); });

  // speech bubble
  var lastBubble = null;
  function updateAnnouncer() {
    var txt = engine.nowPlaying(), a = $("#announcer");
    if (txt !== lastBubble) {
      lastBubble = txt;
      if (txt) $("#announcer-text").textContent = txt;
      a.classList.toggle("show", !!txt);
    }
  }

  // ------------------------------------------------------------------ boot
  ransom($(".gate .ransom"), "JINGLE PLAYER");
  ransom($(".top .ransom"), "JINGLE PLAYER", ["c-orange", "c-yellow", "c-paper", "c-kraft", "c-lime", "c-white"]);
  $("#gate-tournament").textContent = state.tournament || "";
  if (!window.JINGLES) { toast("audio/jingles.js is missing. Run tools/generate_jingles.py"); }
  if (params.has("nogate")) $("#gate").style.display = "none";
  if (CLOCK_OFFSET) document.body.classList.add("rehearsal");
  replan();
  var v0 = params.get("view") || "live";
  if (!params.get("view")) try { v0 = localStorage.getItem(STORE_KEY + ".view") || "live"; } catch (e) { /* ignore */ }
  setView(v0);
  updateOnAir();

  // offline support when hosted (service workers don't run from file://)
  if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register("sw.js").catch(function () { /* offline support unavailable */ });
  }

  var resizeT;
  window.addEventListener("resize", function () {
    clearTimeout(resizeT);
    resizeT = setTimeout(function () { if (view === "schedule") renderSchedule(); }, 150);
  });

  var lastSec = 0;
  setInterval(function () {
    var now = clockNow();
    engine.tick();
    updateAnnouncer();
    var sec = Math.floor(now / 1000);
    if (sec !== lastSec) {
      lastSec = sec;
      $("#clock").textContent = hhmmss(now);
      if (view === "live") renderLive(); else updateTicks();
    }
  }, 250);
})();
