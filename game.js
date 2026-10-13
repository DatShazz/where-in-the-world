/* =====================================================================
 * WHERE IN THE WORLD? — Game engine
 * ---------------------------------------------------------------------
 *  1. Utilities & storage
 *  2. Content constants (team names, champion lines, timing model)
 *  3. Audio engine (original Web Audio synthesis — no recorded assets)
 *  4. Geography (point-in-polygon, coastline snap, haversine, great circle)
 *  5. Map view (Leaflet)
 *  6. Settings, state & question selection
 *  7. Navigation & menu screens (intro, setup, rules, teams, start)
 *  8. Turn timer & session clock
 *  9. Round / turn flow, pins and facilitator tools
 * 10. Scoring & answer reveal
 * 11. Sudden Death, end of game & World Journey
 * 12. Dialogs (confirm, settings, info, credits, highlights)
 * 13. Soundboard
 * 14. Confetti, keyboard shortcuts & initialisation
 * ===================================================================== */
(function () {
  'use strict';

  /* =================================================================
   * 1. UTILITIES & STORAGE
   * ================================================================= */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtKm = (km) => Math.round(km).toLocaleString('en-GB') + ' km';
  const fmtClock = (sec) => {
    const s = Math.max(0, Math.round(sec));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  };
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  /** Safe wrappers: the game must work when storage is blocked (private mode, policies). */
  const store = {
    _s(kind) { return kind === 'local' ? window.localStorage : window.sessionStorage; },
    get(kind, key, fallback) {
      try { const v = this._s(kind).getItem('witw.' + key); return v == null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
    },
    set(kind, key, value) { try { this._s(kind).setItem('witw.' + key, JSON.stringify(value)); return true; } catch (e) { return false; } },
    remove(kind, key) { try { this._s(kind).removeItem('witw.' + key); } catch (e) { /* ignore */ } },
    available(kind) { try { const s = this._s(kind); s.setItem('witw.__t', '1'); s.removeItem('witw.__t'); return true; } catch (e) { return false; } },
  };

  function announce(msg) {
    const a = $('#announcer');
    a.textContent = '';
    window.setTimeout(() => { a.textContent = msg; }, 30);
  }
  function toast(msg, kind) {
    const t = document.createElement('div');
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.textContent = msg;
    $('#toasts').appendChild(t);
    window.setTimeout(() => t.remove(), 4200);
  }

  const DATA = window.WITW_DATA || { CATEGORIES: [], MAIN: [], TIEBREAKERS: [], REGIONS: [] };

  /* =================================================================
   * 2. CONTENT CONSTANTS
   * ================================================================= */
  const TEAM_NAMES = [
    'The Globe Trotters', 'Culture Crew', 'Atlas Avengers', 'Passport Posse', 'The Map Pack', 'Continental Drift',
    'Pin It to Win It', 'The Border Hoppers', 'Trivia Travellers', 'The Roaming Know-It-Alls', 'Global Guessers',
    'Latitude Legends', 'The Compass Collective', 'Destination Unknown', 'The Curious Cartographers',
    'Equator Experts', 'The Time-Zone Travellers', 'Postcard Pioneers', 'The Wayfinders', 'Meridian Mavericks',
    'Suitcase Sleuths', 'The Itinerary Icons', 'Jet-Lag Geniuses', 'The Souvenir Squad',
  ];
  const CHAMPION_LINES = [
    'Champions of Curiosity — every stamp in the passport is yours!',
    'Masters of the Map! The world is officially your oyster.',
    'Gold-star globetrotters with knowledge from every corner of the planet.',
    'Navigators extraordinaire — you pinned it, you won it!',
    'Culture connoisseurs! Your team’s combined experience took you all the way.',
  ];
  const CAT_ICON = {
    'Food and Drink': 'c-food', 'Traditions and Celebrations': 'c-trad', 'Objects and Clothing': 'c-obj',
    'Music and Instruments': 'c-mus', 'Inventions': 'c-inv', 'Animals and Wildlife': 'c-ani', 'Sports and Games': 'c-spo',
    'Landmarks and Architecture': 'c-land', 'Arts and Crafts': 'c-art', 'Natural Wonders': 'c-nat',
  };
  const CONFIDENCE_RANK = { 'Very Confident': 4, 'Fairly Confident': 3, 'Unsure': 2, 'Total Guess': 1 };

  /** Timing model for round estimates (seconds). Two full 60-second turns are always assumed. */
  const TIMING = { clueIntro: 10, turn: 60, handover: 5, reveal: 10, spotlight: 15 };
  const TURN_SECONDS = 60;
  const SEA_TOLERANCE_KM = 50;   // pin in open water this close to the answer marker counts as correct
  const COAST_SNAP_KM = 25;      // pin in water this close to a coastline is assigned to that country
  const SOLO_NEAR_KM = 1000;     // solo / single-team play: an incorrect pin this close scores 2 instead of 1

  /* =================================================================
   * 3. AUDIO ENGINE — every sound is synthesised here (original work).
   * ================================================================= */
  const Sound = (() => {
    const CATS = {
      ui: 'Buttons, typing and name shuffles',
      timer: 'Timer ticks, warnings and countdown',
      lock: 'Pin drops and lock-in chimes',
      reveal: 'Drum rolls, suspense and reveal impacts',
      reactions: 'Answer reactions (success, near miss)',
      comedy: 'Comedy reactions (trombone, quack, scratch…)',
      crowd: 'Crowd sounds (cheers, “ooh”, applause)',
      music: 'Stings, fanfares and lobby music',
    };
    const defaults = { master: 80, music: 60, sfx: 80, muted: false, mode: 'fun', lobby: false, custom: Object.fromEntries(Object.keys(CATS).map((k) => [k, true])) };
    const saved = store.get('session', 'audio', {});
    const prefs = Object.assign({}, defaults, saved, { custom: Object.assign({}, defaults.custom, saved.custom || {}) });

    let ctx = null; let master; let musicBus; let sfxBus; let comp; let noiseBuf = null;
    const active = new Set();
    let majorHandle = null; let boardHandle = null; let clueHandle = null; let clueEl = null;
    const lastPlayed = {};
    const listeners = new Set();

    function save() { store.set('session', 'audio', prefs); listeners.forEach((fn) => fn(prefs)); }
    function onChange(fn) { listeners.add(fn); }

    function ensure() {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        try { ctx = new AC(); } catch (e) { return null; }
        comp = ctx.createDynamicsCompressor(); // acts as a limiter so stacked sounds never get painfully loud
        comp.threshold.value = -16; comp.knee.value = 8; comp.ratio.value = 10; comp.attack.value = 0.003; comp.release.value = 0.25;
        master = ctx.createGain(); musicBus = ctx.createGain(); sfxBus = ctx.createGain();
        musicBus.connect(master); sfxBus.connect(master); master.connect(comp); comp.connect(ctx.destination);
        applyVolumes(true);
      }
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    }
    function applyVolumes(immediate) {
      if (!ctx) return;
      const t = ctx.currentTime; const k = immediate ? 0.001 : 0.03;
      master.gain.setTargetAtTime(prefs.muted ? 0 : (prefs.master / 100) * 0.85, t, k);
      musicBus.gain.setTargetAtTime(prefs.music / 100, t, k);
      sfxBus.gain.setTargetAtTime(prefs.sfx / 100, t, k);
      if (clueEl) clueEl.volume = prefs.muted ? 0 : (prefs.master / 100) * (prefs.sfx / 100);
    }

    /* ---------- synthesis primitives ---------- */
    const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
    function noise() {
      if (!noiseBuf) {
        noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      }
      return noiseBuf;
    }
    /** Oscillator voice with an attack/decay envelope and optional pitch glide / filter. */
    function tone(out, t, dur, { type = 'sine', f = 440, f2 = null, gain = 0.2, a = 0.005, curve = 'exp', detune = 0, lp = null, vib = 0, vibRate = 5.5 } = {}) {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = type; o.frequency.setValueAtTime(f, t); o.detune.value = detune;
      if (f2) { if (curve === 'exp') o.frequency.exponentialRampToValueAtTime(Math.max(20, f2), t + dur); else o.frequency.linearRampToValueAtTime(f2, t + dur); }
      if (vib) { const l = ctx.createOscillator(); const lg = ctx.createGain(); l.frequency.value = vibRate; lg.gain.value = vib; l.connect(lg); lg.connect(o.frequency); l.start(t); l.stop(t + dur + 0.05); }
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      let node = o;
      if (lp) { const fl = ctx.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = lp; o.connect(fl); node = fl; }
      node.connect(g); g.connect(out); o.start(t); o.stop(t + dur + 0.05);
      return o;
    }
    /** Sustained note with flat envelope (for brass, trombone, crowd voices). */
    function held(out, t, dur, { type = 'sawtooth', f = 220, f2 = null, gain = 0.1, a = 0.03, r = 0.08, lp = 1800, lp2 = null, q = 0.7, vib = 0, vibRate = 5, bp = null, bpQ = 4 } = {}) {
      const o = ctx.createOscillator(); const g = ctx.createGain(); const fl = ctx.createBiquadFilter();
      o.type = type; o.frequency.setValueAtTime(f, t);
      if (f2) o.frequency.linearRampToValueAtTime(f2, t + dur);
      if (vib) { const l = ctx.createOscillator(); const lg = ctx.createGain(); l.frequency.value = vibRate; lg.gain.value = vib; l.connect(lg); lg.connect(o.frequency); l.start(t); l.stop(t + dur + r + 0.05); }
      fl.type = bp ? 'bandpass' : 'lowpass'; fl.frequency.setValueAtTime(bp || lp, t); fl.Q.value = bp ? bpQ : q;
      if (lp2) fl.frequency.linearRampToValueAtTime(lp2, t + dur);
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(gain, t + a); g.gain.setValueAtTime(gain, t + Math.max(a, dur - r)); g.gain.linearRampToValueAtTime(0.0001, t + dur + r);
      o.connect(fl); fl.connect(g); g.connect(out); o.start(t); o.stop(t + dur + r + 0.05);
      return o;
    }
    function hiss(out, t, dur, { type = 'bandpass', f = 1500, f2 = null, q = 1, gain = 0.2, a = 0.003, shape = 'exp' } = {}) {
      const s = ctx.createBufferSource(); s.buffer = noise(); s.loop = true;
      const fl = ctx.createBiquadFilter(); fl.type = type; fl.frequency.setValueAtTime(f, t); fl.Q.value = q;
      if (f2) fl.frequency.exponentialRampToValueAtTime(f2, t + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(gain, t + a);
      if (shape === 'exp') g.gain.exponentialRampToValueAtTime(0.0001, t + dur); else g.gain.linearRampToValueAtTime(0.0001, t + dur);
      s.connect(fl); fl.connect(g); g.connect(out);
      s.start(t, Math.random() * 1.5); s.stop(t + dur + 0.05);
    }
    function bell(out, t, f, dur = 1.2, gain = 0.15) {
      [[1, 1], [2.0, 0.45], [3.0, 0.2], [4.2, 0.12]].forEach(([m, v]) => tone(out, t, dur / m * 1.4 > dur ? dur : dur / Math.sqrt(m), { f: f * m, gain: gain * v, a: 0.004 }));
    }
    function thud(out, t, f = 110, gain = 0.5, dur = 0.25) { tone(out, t, dur, { f, f2: f * 0.45, gain, a: 0.003 }); }
    function crash(out, t, gain = 0.12, dur = 1.4) { hiss(out, t, dur, { type: 'highpass', f: 5200, gain }); }
    function snare(out, t, gain = 0.15) { hiss(out, t, 0.12, { type: 'bandpass', f: 2600, q: 0.8, gain }); tone(out, t, 0.06, { f: 220, gain: gain * 0.6 }); }
    /** Karplus–Strong plucked string rendered to a buffer (for kora/valiha impressions). */
    const pluckCache = new Map();
    function pluck(out, t, f, dur = 1.6, gain = 0.35, bright = 0.5) {
      const key = Math.round(f) + ':' + bright;
      let buf = pluckCache.get(key);
      if (!buf) {
        const sr = ctx.sampleRate; const n = Math.floor(sr * dur); buf = ctx.createBuffer(1, n, sr);
        const d = buf.getChannelData(0); const p = Math.max(2, Math.round(sr / f)); const ring = new Float32Array(p);
        for (let i = 0; i < p; i++) ring[i] = Math.random() * 2 - 1;
        let idx = 0; const damp = 0.996 - (1 - bright) * 0.006;
        for (let i = 0; i < n; i++) { const nx = (idx + 1) % p; const v = (ring[idx] + ring[nx]) * 0.5 * damp; d[i] = ring[idx]; ring[idx] = v; idx = nx; }
        pluckCache.set(key, buf);
      }
      const s = ctx.createBufferSource(); const g = ctx.createGain(); s.buffer = buf; g.gain.value = gain;
      s.connect(g); g.connect(out); s.start(t); s.stop(t + buf.duration);
    }
    function voices(out, t, dur, { n = 6, lo = 160, hi = 300, bend = 1.1, bend2 = 0.9, f1 = 500, f2 = null, gain = 0.03, vib = 6 } = {}) {
      for (let i = 0; i < n; i++) {
        const st = t + rand(0, 0.12); const f = rand(lo, hi);
        const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.setValueAtTime(f, st);
        o.frequency.linearRampToValueAtTime(f * bend, st + dur * 0.4); o.frequency.linearRampToValueAtTime(f * bend2, st + dur);
        const l = ctx.createOscillator(); const lg = ctx.createGain(); l.frequency.value = rand(4, 6.5); lg.gain.value = vib; l.connect(lg); lg.connect(o.frequency);
        const b1 = ctx.createBiquadFilter(); b1.type = 'bandpass'; b1.frequency.setValueAtTime(f1, st); b1.Q.value = 3;
        if (f2) b1.frequency.linearRampToValueAtTime(f2, st + dur);
        const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, st); g.gain.linearRampToValueAtTime(gain, st + 0.15); g.gain.linearRampToValueAtTime(gain * 0.8, st + dur * 0.7); g.gain.linearRampToValueAtTime(0.0001, st + dur);
        o.connect(b1); b1.connect(g); g.connect(out); o.start(st); l.start(st); o.stop(st + dur + 0.05); l.stop(st + dur + 0.05);
      }
      hiss(out, t, dur, { type: 'bandpass', f: f1 * 2, q: 0.6, gain: gain * 1.2, a: 0.2, shape: 'lin' });
    }
    function clap(out, t, gain) { hiss(out, t, 0.03 + Math.random() * 0.02, { type: 'bandpass', f: rand(900, 2600), q: rand(0.8, 2), gain, a: 0.001 }); }

    /* ---------- sound library: name → { cat, bus, fn(t, out) => duration } ---------- */
    const S = {
      click: { cat: 'ui', fn: (t, o) => { tone(o, t, 0.06, { f: 1150, f2: 700, gain: 0.12 }); return 0.08; } },
      type: { cat: 'ui', fn: (t, o) => { hiss(o, t, 0.03, { type: 'highpass', f: rand(2500, 4500), gain: 0.07 }); return 0.04; } },
      shuffle: { cat: 'ui', fn: (t, o) => { for (let i = 0; i < 11; i++) tone(o, t + i * 0.055, 0.05, { type: 'triangle', f: 420 + i * 75 + rand(-20, 20), gain: 0.12 }); return 0.7; } },
      confirm: { cat: 'ui', fn: (t, o) => { [72, 76, 79, 84].forEach((n, i) => tone(o, t + i * 0.09, 0.4, { type: 'triangle', f: midi(n), gain: 0.16 })); bell(o, t + 0.36, midi(88), 1, 0.08); return 1.2; } },
      intro: { cat: 'music', bus: 'music', fn: (t, o) => {
        const b = 0.13; const mel = [[72, 0], [76, 1], [79, 2], [84, 3], [83, 5], [79, 6], [81, 7], [84, 9]];
        mel.forEach(([n, s], i) => { tone(o, t + s * b, i === mel.length - 1 ? 0.9 : 0.3, { f: midi(n), gain: 0.2 }); tone(o, t + s * b, 0.2, { f: midi(n + 12), gain: 0.05 }); });
        [[48, 0], [55, 4], [53, 6], [48, 9]].forEach(([n, s]) => tone(o, t + s * b, 0.4, { type: 'triangle', f: midi(n), gain: 0.22 }));
        for (let s = 0; s < 10; s++) hiss(o, t + s * b, 0.05, { type: 'highpass', f: 6000, gain: s % 2 ? 0.03 : 0.06 });
        [60, 64, 67, 72].forEach((n) => tone(o, t + 9 * b, 1.1, { type: 'triangle', f: midi(n), gain: 0.07 }));
        return 9 * b + 1.2;
      } },
      flourish: { cat: 'music', bus: 'music', fn: (t, o) => { held(o, t, 0.45, { f: 180, f2: 720, gain: 0.08, lp: 900, lp2: 3000 }); [60, 64, 67, 72].forEach((n) => tone(o, t + 0.45, 0.9, { type: 'triangle', f: midi(n), gain: 0.1 })); crash(o, t + 0.45, 0.07, 1); return 1.4; } },
      roundSting: { cat: 'music', bus: 'music', fn: (t, o) => { [[79, 0], [84, 0.11], [88, 0.22]].forEach(([n, d]) => tone(o, t + d, 0.25, { type: 'triangle', f: midi(n), gain: 0.15 })); bell(o, t + 0.34, midi(91), 1.1, 0.09); return 1.4; } },
      ready: { cat: 'timer', fn: (t, o) => { bell(o, t, 1319, 0.6, 0.1); bell(o, t + 0.12, 1760, 0.8, 0.1); return 0.9; } },
      tick: { cat: 'timer', fn: (t, o) => { tone(o, t, 0.035, { f: 1000, gain: 0.06 }); hiss(o, t, 0.02, { type: 'highpass', f: 3000, gain: 0.03 }); return 0.05; } },
      warn10: { cat: 'timer', fn: (t, o) => { bell(o, t, 880, 0.5, 0.12); bell(o, t + 0.22, 660, 0.7, 0.12); return 0.9; } },
      beep: { cat: 'timer', fn: (t, o) => { tone(o, t, 0.14, { type: 'square', f: 880, gain: 0.07, lp: 2500 }); return 0.16; } },
      buzzer: { cat: 'timer', fn: (t, o) => { held(o, t, 0.5, { type: 'square', f: 196, gain: 0.07, lp: 1200 }); held(o, t, 0.5, { type: 'square', f: 207, gain: 0.05, lp: 1200 }); return 0.6; } },
      horn: { cat: 'comedy', fn: (t, o) => { held(o, t, 0.22, { f: 330, f2: 300, gain: 0.1, lp: 2200 }); held(o, t + 0.3, 0.45, { f: 300, f2: 200, gain: 0.1, lp: 1800, vib: 6 }); return 0.85; } },
      pinDrop: { cat: 'lock', fn: (t, o) => { tone(o, t, 0.14, { f: 1900, f2: 650, gain: 0.12 }); thud(o, t + 0.1, 140, 0.25, 0.14); return 0.3; } },
      lockChime: { cat: 'lock', fn: (t, o) => { bell(o, t, 988, 0.6, 0.12); bell(o, t + 0.11, 1319, 0.9, 0.12); return 1; } },
      success: { cat: 'reactions', fn: (t, o) => { [1047, 1319, 1568].forEach((f, i) => bell(o, t + i * 0.07, f, 1.4, 0.1)); return 1.6; } },
      nearMiss: { cat: 'reactions', fn: (t, o) => { [[76, 0], [74, 0.14], [79, 0.3]].forEach(([n, d]) => tone(o, t + d, 0.4, { type: 'triangle', f: midi(n), gain: 0.12 })); return 0.8; } },
      softTone: { cat: 'reactions', fn: (t, o) => { tone(o, t, 0.6, { type: 'triangle', f: midi(67), gain: 0.1 }); tone(o, t + 0.2, 0.7, { type: 'triangle', f: midi(64), gain: 0.1 }); return 1; } },
      gentleBuzzer: { cat: 'reactions', fn: (t, o) => { held(o, t, 0.4, { type: 'square', f: 180, gain: 0.05, lp: 900 }); held(o, t, 0.4, { type: 'square', f: 189, gain: 0.04, lp: 900 }); return 0.5; } },
      cheer: { cat: 'crowd', fn: (t, o) => { voices(o, t, 2.2, { n: 9, lo: 200, hi: 380, bend: 1.25, bend2: 1.05, f1: 900, gain: 0.025 }); hiss(o, t, 2.4, { type: 'bandpass', f: 1400, q: 0.5, gain: 0.08, a: 0.25, shape: 'lin' }); for (let i = 0; i < 40; i++) clap(o, t + 0.3 + rand(0, 1.8), rand(0.03, 0.08)); return 2.5; } },
      applause: { cat: 'crowd', fn: (t, o) => { for (let i = 0; i < 170; i++) { const x = Math.pow(Math.random(), 1.6) * 3; clap(o, t + x, rand(0.03, 0.09) * (1 - x / 3.6)); } hiss(o, t, 3.2, { type: 'bandpass', f: 1800, q: 0.4, gain: 0.05, a: 0.2, shape: 'lin' }); return 3.3; } },
      ooh: { cat: 'crowd', fn: (t, o) => { voices(o, t, 1.4, { n: 8, lo: 150, hi: 280, bend: 1.12, bend2: 0.86, f1: 380, gain: 0.04 }); return 1.5; } },
      wow: { cat: 'crowd', fn: (t, o) => { voices(o, t, 1.3, { n: 8, lo: 170, hi: 300, bend: 1.2, bend2: 0.95, f1: 950, f2: 420, gain: 0.04 }); return 1.4; } },
      gasp: { cat: 'crowd', fn: (t, o) => { hiss(o, t, 0.45, { type: 'bandpass', f: 1200, f2: 2600, q: 1.5, gain: 0.14, a: 0.25, shape: 'lin' }); voices(o, t + 0.05, 0.4, { n: 6, lo: 220, hi: 360, bend: 1.3, bend2: 1.3, f1: 1100, gain: 0.02 }); return 0.6; } },
      victory: { cat: 'music', bus: 'music', fn: (t, o) => { [[67, 0, 0.14], [72, 0.15, 0.14], [76, 0.3, 0.14], [79, 0.45, 0.7]].forEach(([n, d, l]) => { held(o, t + d, l, { f: midi(n), gain: 0.07, lp: 2400 }); held(o, t + d, l, { f: midi(n), gain: 0.05, lp: 2400, type: 'square' }); }); crash(o, t + 0.45, 0.06, 1.2); return 1.4; } },
      sadTrombone: { cat: 'comedy', fn: (t, o) => { [[62, 0, 0.32], [61, 0.38, 0.32], [60, 0.76, 0.32], [59, 1.14, 1.0]].forEach(([n, d, l], i) => held(o, t + d, l, { f: midi(n - 12), gain: 0.12, lp: 900, lp2: 600, vib: i === 3 ? 4 : 0, vibRate: 5 })); return 2.3; } },
      wahwah: { cat: 'comedy', fn: (t, o) => { held(o, t, 0.45, { f: midi(45), gain: 0.12, lp: 400, lp2: 1600 }); held(o, t + 0.5, 0.8, { f: midi(43), gain: 0.12, lp: 1600, lp2: 300, vib: 3 }); return 1.4; } },
      quack: { cat: 'comedy', fn: (t, o) => { [0, 0.26].forEach((d) => { held(o, t + d, 0.15, { f: 560, f2: 380, gain: 0.16, bp: 1150, bpQ: 3, a: 0.01, r: 0.04 }); hiss(o, t + d, 0.12, { type: 'bandpass', f: 1500, q: 2, gain: 0.03 }); }); return 0.5; } },
      recordScratch: { cat: 'comedy', fn: (t, o) => { [0, 0.24].forEach((d, i) => { hiss(o, t + d, 0.2, { type: 'bandpass', f: i ? 2800 : 700, f2: i ? 600 : 3200, q: 4, gain: 0.25, a: 0.01 }); held(o, t + d, 0.18, { f: i ? 700 : 180, f2: i ? 150 : 820, gain: 0.04, lp: 3000, r: 0.02 }); }); return 0.5; } },
      drumroll: { cat: 'reveal', fn: (t, o) => { let x = 0; let gap = 0.065; while (x < 1.55) { snare(o, t + x, 0.04 + 0.12 * (x / 1.55)); x += gap; gap = Math.max(0.032, gap * 0.985); } return 1.6; } },
      impact: { cat: 'reveal', fn: (t, o) => { thud(o, t, 95, 0.5, 0.7); hiss(o, t, 0.6, { type: 'lowpass', f: 2500, gain: 0.15 }); crash(o, t, 0.08, 1.4); return 1.5; } },
      heartbeat: { cat: 'reveal', fn: (t, o) => { for (let i = 0; i < 4; i++) { thud(o, t + i * 0.85, 62, 0.6, 0.16); thud(o, t + i * 0.85 + 0.24, 55, 0.4, 0.16); } return 3.4; } },
      suddenDeath: { cat: 'music', bus: 'music', fn: (t, o) => { [[0, 0.25], [0.32, 0.25], [0.64, 1.3]].forEach(([d, l]) => [36, 39, 43, 48].forEach((n) => held(o, t + d, l, { f: midi(n), gain: 0.06, lp: 900 }))); thud(o, t + 0.64, 70, 0.5, 0.8); crash(o, t + 0.64, 0.07, 1.6); return 2.2; } },
      confettiPop: { cat: 'crowd', fn: (t, o) => { hiss(o, t, 0.12, { type: 'highpass', f: 1200, gain: 0.25, a: 0.001 }); for (let i = 0; i < 8; i++) tone(o, t + 0.05 + rand(0, 0.5), 0.06, { f: rand(1800, 3800), gain: 0.05 }); return 0.7; } },
      fanfare: { cat: 'music', bus: 'music', fn: (t, o) => {
        const b = 0.16; const mel = [[60, 0, 1], [64, 1, 1], [67, 2, 1], [72, 3, 2], [67, 5, 1], [72, 6, 1], [76, 7, 1], [79, 8, 5]];
        mel.forEach(([n, s, l]) => { held(o, t + s * b, l * b * 0.95, { f: midi(n), gain: 0.07, lp: 2600 }); held(o, t + s * b, l * b * 0.95, { f: midi(n - 4), gain: 0.04, lp: 2000, type: 'square' }); });
        [0, 3, 8].forEach((s) => thud(o, t + s * b, 90, 0.45, 0.4)); crash(o, t + 8 * b, 0.07, 1.6);
        return 8 * b + 1.4;
      } },
      jackpot: { cat: 'reactions', fn: (t, o) => { for (let i = 0; i < 12; i++) bell(o, t + i * 0.06, i % 2 ? 2093 : 1568, 0.35, 0.06); [72, 76, 79, 84].forEach((n) => tone(o, t + 0.8, 0.9, { type: 'triangle', f: midi(n), gain: 0.08 })); return 1.8; } },
      shrug: { cat: 'comedy', fn: (t, o) => { tone(o, t, 0.28, { type: 'triangle', f: midi(64), f2: midi(65), gain: 0.12, curve: 'lin' }); tone(o, t + 0.3, 0.45, { type: 'triangle', f: midi(62), f2: midi(59), gain: 0.12, curve: 'lin', vib: 3 }); return 0.85; } },
      badumtss: { cat: 'comedy', fn: (t, o) => { thud(o, t, 190, 0.4, 0.16); thud(o, t + 0.17, 135, 0.45, 0.2); thud(o, t + 0.4, 60, 0.4, 0.2); crash(o, t + 0.4, 0.12, 1.1); return 1.5; } },
      crickets: { cat: 'comedy', fn: (t, o) => { for (let k = 0; k < 6; k++) for (let p = 0; p < 3; p++) tone(o, t + k * 0.42 + p * 0.06 + (k % 2) * 0.05, 0.035, { f: 4400 + (k % 2) * 160, gain: 0.04 }); return 2.6; } },
      airhorn: { cat: 'comedy', fn: (t, o) => { [[0, 0.32], [0.42, 0.65]].forEach(([d, l]) => [415, 419, 622].forEach((f) => held(o, t + d, l, { f, gain: 0.045, lp: 2800, a: 0.01, r: 0.05 }))); return 1.15; } },
      suspense: { cat: 'reveal', fn: (t, o) => { const g = ctx.createGain(); const l = ctx.createOscillator(); const lg = ctx.createGain(); l.frequency.value = 9; lg.gain.value = 0.5; g.gain.value = 0.5; l.connect(lg); lg.connect(g.gain); g.connect(o); l.start(t); l.stop(t + 2.7); [110, 131, 165].forEach((f) => held(g, t, 2.4, { f, f2: f * 1.06, gain: 0.06, lp: 600, lp2: 1600, a: 0.6, r: 0.3 })); return 2.8; } },
      mindBlown: { cat: 'comedy', fn: (t, o) => { tone(o, t, 0.8, { f: 300, f2: 2400, gain: 0.07 }); thud(o, t + 0.8, 70, 0.5, 0.7); hiss(o, t + 0.8, 0.9, { type: 'lowpass', f: 1800, f2: 200, gain: 0.25 }); for (let i = 0; i < 6; i++) bell(o, t + 1 + i * 0.08, rand(1800, 3200), 0.4, 0.04); return 1.9; } },
      micDrop: { cat: 'comedy', fn: (t, o) => { thud(o, t, 90, 0.6, 0.3); hiss(o, t, 0.25, { type: 'lowpass', f: 1500, gain: 0.2 }); tone(o, t + 0.05, 1.4, { f: 1180, gain: 0.03, vib: 12 }); thud(o, t + 0.35, 80, 0.25, 0.2); return 1.6; } },
      awkward: { cat: 'comedy', fn: (t, o) => { hiss(o, t, 3, { type: 'lowpass', f: 400, gain: 0.04, a: 0.6, shape: 'lin' }); for (let p = 0; p < 3; p++) tone(o, t + 1.2 + p * 0.07, 0.035, { f: 4300, gain: 0.04 }); return 3.1; } },
      mystery: { cat: 'reveal', fn: (t, o) => { [72, 74, 76, 78, 80, 82, 84].forEach((n, i) => tone(o, t + i * 0.08, 0.6, { type: 'triangle', f: midi(n), gain: 0.07 })); bell(o, t + 0.6, midi(96), 1.4, 0.06); return 2; } },
      chime: { cat: 'reactions', fn: (t, o) => { bell(o, t, 1047, 1.2, 0.12); bell(o, t + 0.16, 1568, 1.4, 0.1); return 1.6; } },
      countdown: { cat: 'timer', fn: (t, o) => { [0, 1, 2].forEach((i) => tone(o, t + i, 0.16, { type: 'square', f: 660, gain: 0.07, lp: 2200 })); tone(o, t + 3, 0.5, { type: 'square', f: 1320, gain: 0.07, lp: 2600 }); return 3.6; } },
    };

    /* ---------- audio-clue impressions (labelled as synthesised, not recordings) ---------- */
    const CLUES = {
      steelpan: (t, o) => { const mel = [[76, 0], [79, 1], [81, 2], [79, 3], [76, 4], [74, 5], [72, 6], [74, 7], [76, 8], [72, 10]]; mel.forEach(([n, s]) => { const f = midi(n); [[1, 0.2], [2, 0.08], [3.01, 0.03], [4.02, 0.02]].forEach(([m, g]) => tone(o, t + s * 0.18, 0.9, { f: f * m, gain: g, a: 0.003 })); }); return 2.8; },
      kora: (t, o) => { const bass = [53, 60, 57, 60]; const mel = [72, 74, 76, 77, 76, 74, 72, 69, 72, 76, 74, 72]; for (let i = 0; i < 12; i++) { pluck(o, t + i * 0.24, midi(bass[i % 4]), 1.6, 0.3, 0.4); pluck(o, t + i * 0.24 + 0.12, midi(mel[i]), 1.4, 0.25, 0.7); } return 4.2; },
      valiha: (t, o) => { const arp = [67, 71, 74, 79, 74, 71, 69, 72, 76, 81, 76, 72, 67, 74, 79]; arp.forEach((n, i) => pluck(o, t + i * 0.19, midi(n), 1.6, 0.28, 0.85)); return 4.2; },
      talkingdrum: (t, o) => { const pat = [[140, 220, 0.3], [220, 150, 0.25], [170, 170, 0.18], [150, 240, 0.32], [240, 240, 0.15], [230, 140, 0.35], [160, 200, 0.25], [200, 130, 0.4]]; let x = 0; pat.forEach(([a, b, d]) => { tone(o, t + x, d + 0.2, { f: a, f2: b, gain: 0.45, a: 0.004, curve: 'lin' }); hiss(o, t + x, 0.04, { type: 'bandpass', f: 1800, gain: 0.08 }); x += d; }); return x + 0.5; },
      danbau: (t, o) => { const osc = ctx.createOscillator(); const g = ctx.createGain(); const l = ctx.createOscillator(); const lg = ctx.createGain(); osc.type = 'triangle'; const pts = [[72, 0], [72, 0.5], [74, 0.9], [74, 1.3], [71, 1.8], [71, 2.2], [72, 2.7], [72, 3.6]]; pts.forEach(([n, d], i) => { if (i === 0) osc.frequency.setValueAtTime(midi(n), t); else osc.frequency.linearRampToValueAtTime(midi(n), t + d); }); l.frequency.value = 5; lg.gain.setValueAtTime(0, t); lg.gain.linearRampToValueAtTime(8, t + 3.5); l.connect(lg); lg.connect(osc.frequency); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.06, t + 1.5); g.gain.exponentialRampToValueAtTime(0.0001, t + 3.8); const fl = ctx.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = 2200; osc.connect(fl); fl.connect(g); g.connect(o); osc.start(t); l.start(t); osc.stop(t + 3.9); l.stop(t + 3.9); return 4; },
      candombe: (t, o) => { const b = 0.125; for (let bar = 0; bar < 4; bar++) { const s = t + bar * 16 * b; for (let i = 0; i < 16; i++) { if (i % 4 === 1 || i % 4 === 3) { tone(o, s + i * b, 0.08, { f: 420, f2: 330, gain: 0.18 }); } if ([0, 3, 6, 10, 12].includes(i)) { tone(o, s + i * b, 0.14, { f: 260, f2: 200, gain: 0.25 }); hiss(o, s + i * b, 0.05, { type: 'bandpass', f: 1500, gain: 0.05 }); } if ([0, 7, 8].includes(i)) thud(o, s + i * b, 95, 0.5, 0.35); if ([2, 5, 9, 13].includes(i)) hiss(o, s + i * b, 0.03, { type: 'highpass', f: 4000, gain: 0.08 }); } } return 64 * b + 0.4; },
      coqui: (t, o) => { for (let k = 0; k < 5; k++) { const s = t + k * 0.85; tone(o, s, 0.1, { f: 1150, f2: 1100, gain: 0.22, a: 0.01 }); tone(o, s + 0.13, 0.17, { f: 1850, f2: 2300, gain: 0.2, a: 0.01, curve: 'lin' }); } return 4.5; },
    };

    /* ---------- mode policy ---------- */
    const PRO_CATS = ['ui', 'timer', 'lock', 'reveal', 'reactions', 'music'];
    function allowed(name) {
      if (prefs.muted) return false;
      const def = S[name]; if (!def) return false;
      switch (prefs.mode) {
        case 'professional': return PRO_CATS.includes(def.cat) || name === 'applause';
        case 'custom': return !!prefs.custom[def.cat];
        default: return true; // fun & chaotic
      }
    }

    function makeHandle(g, dur, name) {
      const h = {
        name, stopped: false, end: ctx.currentTime + dur,
        stop(fade = 0.06) {
          if (h.stopped) return; h.stopped = true;
          try { const n = ctx.currentTime; g.gain.cancelScheduledValues(n); g.gain.setValueAtTime(g.gain.value, n); g.gain.linearRampToValueAtTime(0, n + fade); } catch (e) { /* ignore */ }
          window.setTimeout(() => { try { g.disconnect(); } catch (e) { /* ignore */ } active.delete(h); }, fade * 1000 + 80);
        },
      };
      active.add(h);
      window.setTimeout(() => { if (!h.stopped) { h.stopped = true; try { g.disconnect(); } catch (e) { /* ignore */ } active.delete(h); } }, (dur + 0.6) * 1000);
      // voice limit: never let more than 12 sounds stack up
      if (active.size > 12) { const oldest = active.values().next().value; if (oldest && oldest !== h) oldest.stop(0.05); }
      return h;
    }

    /**
     * Play a named sound.
     * opts.major  – stop the previous major sound first (stings, reactions, reveals)
     * opts.board  – soundboard sound (one at a time)
     * opts.force  – bypass the sound-mode filter (soundboard only); mute still applies
     * opts.delay  – seconds from now
     */
    function play(name, opts = {}) {
      const def = S[name];
      if (!def) return null;
      if (prefs.muted) return null;
      if (!opts.force && !allowed(name)) return null;
      const c = ensure(); if (!c) return null;
      const nowMs = performance.now();
      if (lastPlayed[name] && nowMs - lastPlayed[name] < 110) return null; // anti-stacking on rapid clicks
      lastPlayed[name] = nowMs;
      if (opts.major && majorHandle) majorHandle.stop(0.12);
      if (opts.board && boardHandle) boardHandle.stop(0.08);
      const g = c.createGain(); g.gain.value = 1;
      g.connect(def.bus === 'music' ? musicBus : sfxBus);
      const t = c.currentTime + 0.02 + (opts.delay || 0);
      let dur = 0.5;
      try { dur = def.fn(t, g) + (opts.delay || 0); } catch (e) { console.warn('Sound failed:', name, e); return null; }
      const h = makeHandle(g, dur, name);
      if (opts.major) majorHandle = h;
      if (opts.board) boardHandle = h;
      return h;
    }

    /** Play an audio clue: a licensed file if supplied, otherwise the synthesised impression. */
    function playClue(q, onUnavailable) {
      stopClue();
      if (prefs.muted) { onUnavailable && onUnavailable('Sound is muted — unmute to hear the clue, or use the description.'); return; }
      const synth = () => {
        if (!q.audioSynth || !CLUES[q.audioSynth]) { onUnavailable && onUnavailable('This sound clue is not available — please use the description.'); return; }
        const c = ensure(); if (!c) { onUnavailable && onUnavailable('Audio is not supported in this browser — please use the description.'); return; }
        const g = c.createGain(); g.connect(sfxBus);
        const t = c.currentTime + 0.05;
        const dur = CLUES[q.audioSynth](t, g);
        clueHandle = makeHandle(g, dur, 'clue');
      };
      if (q.audioPath) {
        try {
          const el = new window.Audio(q.audioPath);
          el.volume = (prefs.master / 100) * (prefs.sfx / 100);
          el.addEventListener('error', () => { clueEl = null; synth(); }, { once: true });
          const p = el.play();
          if (p && p.catch) p.catch(() => { clueEl = null; synth(); });
          clueEl = el;
        } catch (e) { synth(); }
      } else synth();
    }
    function stopClue() {
      if (clueHandle) { clueHandle.stop(0.05); clueHandle = null; }
      if (clueEl) { try { clueEl.pause(); } catch (e) { /* ignore */ } clueEl = null; }
    }

    /* ---------- gentle lobby music (optional, menu screens only) ---------- */
    let lobbyTimer = null; let lobbyNext = 0; let lobbyStep = 0; let lobbyGain = null;
    const LOBBY_CHORDS = [[60, 64, 67, 72], [57, 60, 64, 69], [53, 57, 60, 65], [55, 59, 62, 67]];
    function lobbyStart() {
      if (lobbyTimer || !prefs.lobby || prefs.muted) return;
      const c = ensure(); if (!c) return;
      lobbyGain = c.createGain(); lobbyGain.gain.value = 0.55; lobbyGain.connect(musicBus);
      lobbyNext = c.currentTime + 0.1; lobbyStep = 0;
      lobbyTimer = window.setInterval(() => {
        while (lobbyNext < ctx.currentTime + 0.4) {
          const ch = LOBBY_CHORDS[Math.floor(lobbyStep / 8) % 4]; const i = lobbyStep % 8;
          tone(lobbyGain, lobbyNext, 0.5, { f: midi(ch[[0, 1, 2, 3, 2, 1, 2, 3][i]] + 12), gain: 0.05 });
          if (i === 0) tone(lobbyGain, lobbyNext, 1.4, { type: 'triangle', f: midi(ch[0] - 12), gain: 0.07 });
          if (i % 2 === 1) hiss(lobbyGain, lobbyNext, 0.04, { type: 'highpass', f: 7000, gain: 0.015 });
          lobbyNext += 0.3125; lobbyStep++;
        }
      }, 100);
    }
    function lobbyStop() {
      if (lobbyTimer) { window.clearInterval(lobbyTimer); lobbyTimer = null; }
      if (lobbyGain) { const g = lobbyGain; lobbyGain = null; try { g.gain.setTargetAtTime(0, ctx.currentTime, 0.1); } catch (e) { /* ignore */ } window.setTimeout(() => { try { g.disconnect(); } catch (e) { /* ignore */ } }, 600); }
    }

    function stopAll() {
      active.forEach((h) => h.stop(0.05));
      majorHandle = null; boardHandle = null;
      stopClue(); lobbyStop();
    }

    return {
      CATS, prefs, play, playClue, stopClue, stopAll, lobbyStart, lobbyStop, ensure, onChange,
      isBoardPlaying: (h) => h && !h.stopped && ctx && ctx.currentTime < h.end,
      setMuted(m) { prefs.muted = !!m; applyVolumes(); if (m) { stopAll(); } save(); },
      setVolume(which, v) { prefs[which] = clamp(Math.round(v), 0, 100); applyVolumes(); save(); },
      setMode(m) { prefs.mode = m; save(); },
      setCustom(cat, on) { prefs.custom[cat] = !!on; save(); },
      setLobby(on) { prefs.lobby = !!on; save(); if (!on) lobbyStop(); },
      hasSound: (name) => !!S[name],
    };
  })();

  /* =================================================================
   * 4. GEOGRAPHY
   * ================================================================= */
  const Geo = (() => {
    const feats = (window.WORLD_GEOJSON && window.WORLD_GEOJSON.features) || [];
    const index = feats.map((f) => {
      const g = f.geometry; const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
      let minX = 180; let minY = 90; let maxX = -180; let maxY = -90;
      polys.forEach((p) => p[0].forEach(([x, y]) => { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }));
      const p = f.properties;
      return { code: p.code, name: p.name, neName: p.neName, labelLat: p.labelLat, labelLng: p.labelLng, continent: p.continent, polys, bbox: [minX, minY, maxX, maxY] };
    });
    const byCode = new Map(index.map((c) => [c.code, c]));

    function inRing(x, y, ring) {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0]; const yi = ring[i][1]; const xj = ring[j][0]; const yj = ring[j][1];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    }
    function inPoly(x, y, poly) {
      if (!inRing(x, y, poly[0])) return false;
      for (let k = 1; k < poly.length; k++) if (inRing(x, y, poly[k])) return false; // holes
      return true;
    }
    /** Returns the country whose polygon (any part, incl. islands) contains the point. */
    function countryAt(lat, lng) {
      for (const c of index) {
        const b = c.bbox;
        if (lng < b[0] || lng > b[2] || lat < b[1] || lat > b[3]) continue;
        if (c.polys.some((p) => inPoly(lng, lat, p))) return c;
      }
      return null;
    }
    /** Nearest country edge within maxKm (local equirectangular approximation, fine at this scale). */
    function nearestCountry(lat, lng, maxKm) {
      const kx = 111.32 * Math.cos((lat * Math.PI) / 180); const ky = 110.57;
      const padX = maxKm / Math.max(kx, 1); const padY = maxKm / ky;
      let best = null; let bestD = maxKm;
      for (const c of index) {
        const b = c.bbox;
        if (lng < b[0] - padX || lng > b[2] + padX || lat < b[1] - padY || lat > b[3] + padY) continue;
        for (const poly of c.polys) {
          const ring = poly[0];
          for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const ax = (ring[j][0] - lng) * kx; const ay = (ring[j][1] - lat) * ky;
            const bx = (ring[i][0] - lng) * kx; const by = (ring[i][1] - lat) * ky;
            const dx = bx - ax; const dy = by - ay; const len = dx * dx + dy * dy;
            let tt = len ? -(ax * dx + ay * dy) / len : 0; tt = clamp(tt, 0, 1);
            const px = ax + tt * dx; const py = ay + tt * dy; const d = Math.sqrt(px * px + py * py);
            if (d < bestD) { bestD = d; best = c; }
          }
        }
      }
      return best ? { country: best, km: bestD } : null;
    }
    /** Great-circle distance (haversine), mean Earth radius 6,371 km. */
    function haversine(lat1, lng1, lat2, lng2) {
      const R = 6371.0088; const r = Math.PI / 180;
      const dLat = (lat2 - lat1) * r; const dLng = (lng2 - lng1) * r;
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
      return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
    }
    /** Points along the great circle, with longitudes unwrapped so the line never jumps across the map. */
    function greatCircle(a, b, n = 64) {
      const r = Math.PI / 180;
      const φ1 = a[0] * r; const λ1 = a[1] * r; const φ2 = b[0] * r; const λ2 = b[1] * r;
      const d = 2 * Math.asin(Math.sqrt(Math.sin((φ2 - φ1) / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2));
      if (d < 1e-6) return [a, b];
      const pts = [];
      for (let i = 0; i <= n; i++) {
        const f = i / n; const A = Math.sin((1 - f) * d) / Math.sin(d); const B = Math.sin(f * d) / Math.sin(d);
        const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
        const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
        const z = A * Math.sin(φ1) + B * Math.sin(φ2);
        pts.push([Math.atan2(z, Math.sqrt(x * x + y * y)) / r, Math.atan2(y, x) / r]);
      }
      for (let i = 1; i < pts.length; i++) { while (pts[i][1] - pts[i - 1][1] > 180) pts[i][1] -= 360; while (pts[i][1] - pts[i - 1][1] < -180) pts[i][1] += 360; }
      return pts;
    }
    function findByName(text) {
      const t = String(text || '').trim().toLowerCase();
      if (!t) return null;
      return index.find((c) => c.name.toLowerCase() === t) || index.find((c) => (c.neName || '').toLowerCase() === t) || null;
    }
    return { ok: index.length > 0, index, byCode, countryAt, nearestCountry, haversine, greatCircle, findByName };
  })();

  /* =================================================================
   * 5. MAP VIEW (Leaflet)
   * ================================================================= */
  const MapView = (() => {
    let map = null; const layersByCode = new Map(); let pinLayer = null; let revealLayer = null; let highlighted = [];
    let clickHandler = null; let dragHandler = null;
    const BASE = { color: '#8c98ad', weight: 0.6, fillColor: '#f4ecd8', fillOpacity: 1 };
    const HIGHLIGHT = { color: '#a86b00', weight: 2.2, fillColor: '#ffd25e', fillOpacity: 1 };

    function init() {
      if (map) return true;
      if (!window.L || !Geo.ok) {
        const err = $('#map-error');
        err.hidden = false;
        err.textContent = 'The interactive map could not load. Use the country list in the clue panel to place your pin — scoring still works.';
        return false;
      }
      map = L.map('map', {
        preferCanvas: true, zoomSnap: 0.25, zoomDelta: 0.5, minZoom: 1, maxZoom: 9, worldCopyJump: false,
        maxBounds: [[-89, -250], [89, 250]], maxBoundsViscosity: 0.7, keyboard: true, keyboardPanDelta: 120,
        attributionControl: true,
      });
      map.attributionControl.setPrefix(false);
      map.attributionControl.addAttribution('Boundaries: Natural Earth 1:50m v5.1.2 · Map library: Leaflet');
      L.geoJSON(window.WORLD_GEOJSON, {
        style: () => BASE, interactive: false,
        onEachFeature: (f, layer) => { const c = f.properties.code; if (!layersByCode.has(c)) layersByCode.set(c, []); layersByCode.get(c).push(layer); },
      }).addTo(map);
      revealLayer = L.layerGroup().addTo(map);
      pinLayer = L.layerGroup().addTo(map);
      map.on('click', (e) => { if (clickHandler) { const ll = e.latlng.wrap(); clickHandler(ll.lat, ll.lng); } });
      resetView();
      return true;
    }
    function resetView() { if (map) map.fitBounds([[-56, -168], [76, 190]], { animate: false }); }
    function invalidate() { if (map) window.setTimeout(() => map.invalidateSize(), 60); }
    function centre() { if (!map) return null; const c = map.getCenter().wrap(); return [c.lat, c.lng]; }
    function panTo(lat, lng) { if (map) map.panTo([lat, lng]); }
    function icon(kind, label, animate) {
      const cls = kind === 0 ? 'pin-t1' : kind === 1 ? 'pin-t2' : 'pin-ans';
      const inner = kind === 2 ? '<svg aria-hidden="true"><use href="#i-star"/></svg>' : `<span>${kind + 1}</span>`;
      return L.divIcon({ className: `pin ${cls}${animate ? ' drop' : ''}`, html: `<div class="pin-shape">${inner}</div><div class="pin-label">${esc(label)}</div>`, iconSize: [0, 0] });
    }
    /** Shows only the given pins (used during turns so hidden guesses are never drawn). */
    function setPins(pins) {
      if (!map) return;
      pinLayer.clearLayers();
      pins.forEach((p) => {
        const m = L.marker([p.lat, p.lng], { icon: icon(p.kind, p.label, p.animate), draggable: !!p.draggable, keyboard: false, title: p.title || p.label, alt: p.title || p.label, zIndexOffset: p.kind === 2 ? 1000 : 0 });
        if (p.draggable) m.on('dragend', () => { const ll = m.getLatLng().wrap(); if (dragHandler) dragHandler(ll.lat, ll.lng); });
        m.addTo(pinLayer);
      });
    }
    function highlight(codes) {
      clearHighlight();
      codes.forEach((c) => (layersByCode.get(c) || []).forEach((l) => { l.setStyle(HIGHLIGHT); highlighted.push(l); }));
    }
    function clearHighlight() { highlighted.forEach((l) => l.setStyle(BASE)); highlighted = []; }
    function showReveal({ codes, answer, guesses, showDistance }) {
      if (!map) return;
      highlight(codes);
      revealLayer.clearLayers();
      const bounds = [[answer.lat, answer.lng]];
      guesses.forEach((g) => {
        if (!g) return;
        const pts = Geo.greatCircle([g.lat, g.lng], [answer.lat, answer.lng]);
        const line = L.polyline(pts, { color: g.kind === 0 ? '#d1432b' : '#1f5fbf', weight: 3.5, dashArray: g.kind === 0 ? null : '10 7', opacity: 0.95 }).addTo(revealLayer);
        if (showDistance) line.bindTooltip(fmtKm(g.km), { permanent: true, direction: 'center', className: 'dist-tip ' + (g.kind === 0 ? 't1' : 't2') });
        bounds.push([g.lat, g.lng]);
      });
      const pins = guesses.filter(Boolean).map((g) => ({ kind: g.kind, lat: g.lat, lng: g.lng, label: g.label, title: g.label + ' guess' }));
      pins.push({ kind: 2, lat: answer.lat, lng: answer.lng, label: 'Answer', title: 'Correct answer location' });
      setPins(pins);
      if (bounds.length > 1) map.fitBounds(bounds, { padding: [70, 70], maxZoom: 5 }); else map.setView([answer.lat, answer.lng], 4);
    }
    function clearReveal() { if (!map) return; clearHighlight(); revealLayer.clearLayers(); pinLayer.clearLayers(); }
    function focus() { const el = $('#map'); if (el) el.focus({ preventScroll: true }); }
    return {
      init, resetView, invalidate, centre, panTo, setPins, showReveal, clearReveal, focus,
      onClick(fn) { clickHandler = fn; }, onDrag(fn) { dragHandler = fn; }, ready: () => !!map,
    };
  })();

  /* =================================================================
   * 6. SETTINGS, STATE & QUESTION SELECTION
   * ================================================================= */
  const DEFAULT_SETTINGS = {
    duration: '25', customMinutes: 45, rounds: null, roundsManual: false, difficulty: 'mixed', category: 'all',
    images: true, audioClues: true, spotlights: true, confidence: true, distance: true, tiebreaker: true,
    random: true, noRepeat: true, warnings: true, hints: true, alternate: false,
  };
  let settings = Object.assign({}, DEFAULT_SETTINGS);
  let teams = ['', ''];
  let solo = false; // one-screen solo play (a single team, no rival)
  let game = null;
  const ui = { reducedMotion: false, keepTimerInSettings: false, screen: 'intro', mode: 'local' }; // mode: 'local' (one screen) | 'online' (hosted rooms)

  const minutesSelected = () => (settings.duration === 'custom' ? Number(settings.customMinutes) : Number(settings.duration));
  const perRoundSeconds = () => TIMING.clueIntro + 2 * TIMING.turn + TIMING.handover + TIMING.reveal + (settings.spotlights ? TIMING.spotlight : 0);
  const recommendedRounds = () => Math.max(1, Math.round((minutesSelected() * 60) / perRoundSeconds()));

  function questionPool() {
    let qs = DATA.MAIN;
    if (settings.category !== 'all' && settings.category !== 'mystery') qs = qs.filter((q) => q.category === settings.category);
    if (settings.difficulty === 'hard' || settings.difficulty === 'expert') qs = qs.filter((q) => q.difficulty !== 'Medium');
    return qs;
  }
  const maxRounds = () => Math.max(1, Math.min(40, questionPool().length));

  /* Previously-played history (localStorage, optional) */
  const History = {
    list() { return store.get('local', 'played', []); },
    add(id) { if (!settings.noRepeat) return; const l = this.list().filter((x) => x !== id); l.push(id); store.set('local', 'played', l.slice(-400)); },
    clear() { store.remove('local', 'played'); },
  };

  const regionOf = (q) => q.region;
  const continentOf = (q) => { const c = Geo.byCode.get(q.acceptedCountryCodes[0]); return c ? c.continent : q.region; };

  /**
   * Picks the next question. Hard rules: no duplicates within a game, tie-breakers never used.
   * Soft rules (penalties): ≤2 consecutive questions from one category, varied regions,
   * no repeated countries, avoid recently played questions, Expert Explorer prefers Expert.
   */
  function pickQuestion(ctx = game) {
    const pool = questionPool().filter((q) => !ctx.usedIds.has(q.id));
    if (!pool.length) return null;
    const seq = ctx.sequence.map((id) => DATA.MAIN.find((q) => q.id === id)).filter(Boolean);
    const last = seq[seq.length - 1]; const last2 = seq[seq.length - 2];
    const usedCodes = new Set(seq.flatMap((q) => q.acceptedCountryCodes));
    const regionCount = {}; seq.forEach((q) => { regionCount[regionOf(q)] = (regionCount[regionOf(q)] || 0) + 1; });
    const hist = settings.noRepeat ? History.list() : [];
    const histRank = new Map(hist.map((id, i) => [id, i + 1]));
    const singleCategory = settings.category !== 'all' && settings.category !== 'mystery';

    if (!settings.random) {
      // fixed bank order, but still skip recently played questions where possible
      return pool.find((q) => !histRank.has(q.id)) || pool[0];
    }
    let best = null; let bestScore = Infinity;
    for (const q of pool) {
      let s = Math.random() * 12;
      if (!singleCategory) {
        if (last && last2 && last.category === q.category && last2.category === q.category) s += 1000;
        if (last && last.category === q.category) s += 25;
      }
      if (q.acceptedCountryCodes.some((c) => usedCodes.has(c))) s += 220;
      if (last && regionOf(last) === regionOf(q)) s += 60;
      s += (regionCount[regionOf(q)] || 0) * 28;
      if (histRank.has(q.id)) s += 400 + histRank.get(q.id) * 2; // played before: deprioritise (older = slightly better)
      if (settings.difficulty === 'expert' && q.difficulty !== 'Expert') s += 150;
      if (s < bestScore) { bestScore = s; best = q; }
    }
    return best;
  }
  function pickTiebreaker(used = game.tb.used) {
    const pool = DATA.TIEBREAKERS.filter((q) => !used.has(q.id));
    return pool.length ? pick(pool) : null;
  }

  const teamName = (i) => teams[i] || `Team ${i + 1}`;
  const totals = () => {
    const t = [0, 0];
    if (game) game.rounds.forEach((r) => { t[0] += r.result.points[0]; t[1] += r.result.points[1]; });
    return t;
  };

  /* =================================================================
   * 7. NAVIGATION & MENU SCREENS
   * ================================================================= */
  const MENU_SCREENS = ['intro', 'setup', 'rules', 'teams', 'start'];
  function goTo(name, { focus = true } = {}) {
    $$('.screen').forEach((s) => { s.hidden = s.id !== 'screen-' + name; });
    ui.screen = name;
    const screen = $('#screen-' + name);
    window.scrollTo(0, 0);
    if (MENU_SCREENS.includes(name)) Sound.lobbyStart(); else Sound.lobbyStop();
    if (name === 'game') { MapView.init(); MapView.invalidate(); }
    if (focus && screen) {
      const hd = screen.querySelector('h1, h2:not(.visually-hidden), [tabindex="-1"]') || screen.querySelector('h2');
      if (hd) { if (!hd.hasAttribute('tabindex')) hd.setAttribute('tabindex', '-1'); hd.focus({ preventScroll: true }); }
    }
  }

  /** Switches between the one-screen game and hosting an online game (shows/hides online-only fields). */
  function setMode(mode) {
    ui.mode = mode;
    $$('[data-online-only]').forEach((el) => { el.hidden = mode !== 'online'; });
    $$('[data-local-only]').forEach((el) => { el.hidden = mode === 'online'; });
  }

  /* ---------- Intro ---------- */
  function bindIntro() {
    $('#btn-play').addEventListener('click', () => {
      setMode('local');
      Sound.ensure();
      Sound.play('intro', { major: true });
      goTo('setup');
    });
    $('#intro-sound-mode').addEventListener('change', (e) => {
      Sound.setMode(e.target.value); syncSoundUI();
      Sound.play('click');
    });
    $('#btn-intro-mute').addEventListener('click', () => toggleMute());
  }

  /* ---------- Setup ---------- */
  function buildCategoryChoices() {
    const box = $('#category-choices');
    const items = [['all', 'All Categories', 'A balanced mix of everything']]
      .concat(DATA.CATEGORIES.map((c) => [c, c, DATA.MAIN.filter((q) => q.category === c).length + ' questions']))
      .concat([['mystery', 'Mystery Mix', 'Categories stay hidden until the reveal']]);
    box.innerHTML = items.map(([v, label, sub]) => `<label class="choice"><input type="radio" name="category" value="${esc(v)}"><span><strong>${esc(label)}</strong><em>${esc(sub)}</em></span></label>`).join('');
  }
  function settingsToForm() {
    const f = $('#setup-form');
    f.querySelector(`input[name="duration"][value="${settings.duration}"]`).checked = true;
    $('#custom-minutes').value = settings.customMinutes;
    $('#custom-duration-row').hidden = settings.duration !== 'custom';
    f.querySelector(`input[name="difficulty"][value="${settings.difficulty}"]`).checked = true;
    const catInput = f.querySelector(`input[name="category"][value="${CSS.escape(settings.category)}"]`);
    if (catInput) catInput.checked = true;
    const sm = f.querySelector(`input[name="soundmode"][value="${Sound.prefs.mode}"]`); if (sm) sm.checked = true;
    const map = { images: 'opt-images', audioClues: 'opt-audioclues', spotlights: 'opt-spotlights', confidence: 'opt-confidence', distance: 'opt-distance', tiebreaker: 'opt-tiebreaker', random: 'opt-random', noRepeat: 'opt-norepeat', warnings: 'opt-warnings', hints: 'opt-hints', alternate: 'opt-alternate' };
    Object.entries(map).forEach(([k, id]) => { $('#' + id).checked = !!settings[k]; });
    updateRoundsUI();
    updateHistoryHelp();
  }
  function readOptionToggles() {
    settings.images = $('#opt-images').checked; settings.audioClues = $('#opt-audioclues').checked;
    settings.spotlights = $('#opt-spotlights').checked; settings.confidence = $('#opt-confidence').checked;
    settings.distance = $('#opt-distance').checked; settings.tiebreaker = $('#opt-tiebreaker').checked;
    settings.random = $('#opt-random').checked; settings.noRepeat = $('#opt-norepeat').checked;
    settings.warnings = $('#opt-warnings').checked; settings.hints = $('#opt-hints').checked; settings.alternate = $('#opt-alternate').checked;
  }
  function validateCustom(showError) {
    if (settings.duration !== 'custom') { $('#custom-minutes-error').textContent = ''; return true; }
    const raw = $('#custom-minutes').value.trim();
    const n = Number(raw);
    let msg = '';
    if (!/^\d+$/.test(raw)) msg = 'Please enter a whole number of minutes.';
    else if (n < 3) msg = 'Custom games must be at least 3 minutes.';
    else if (n > 120) msg = 'Custom games can be at most 120 minutes.';
    if (showError) $('#custom-minutes-error').textContent = msg;
    if (!msg) settings.customMinutes = n;
    return !msg;
  }
  function updateRoundsUI() {
    const max = maxRounds();
    const rec = Math.min(recommendedRounds(), max);
    if (!settings.roundsManual || settings.rounds == null) settings.rounds = rec;
    settings.rounds = clamp(settings.rounds, 1, max);
    const input = $('#rounds-input'); input.max = max; input.value = settings.rounds;
    const per = perRoundSeconds();
    const validMin = settings.duration !== 'custom' || validateCustom(false);
    $('#rounds-estimate').innerHTML = validMin
      ? `Recommended for <strong>${minutesSelected()} minutes</strong>: <strong>${rec} round${rec === 1 ? '' : 's'}</strong>.`
      : 'Enter a valid custom length to see the recommended number of rounds.';
    $('#rounds-help').textContent = `Each round is estimated at about ${Math.floor(per / 60)} min ${per % 60} s: two 60-second team turns plus ${TIMING.clueIntro} s clue introduction, ${TIMING.handover} s handover, ${TIMING.reveal} s reveal${settings.spotlights ? ` and ${TIMING.spotlight} s Cultural Spotlight` : ''}. ${max} question${max === 1 ? '' : 's'} available with the current selection${settings.roundsManual ? ' · manually adjusted' : ''}.`;
    $('#rounds-minus').disabled = settings.rounds <= 1;
    $('#rounds-plus').disabled = settings.rounds >= max;
  }
  function updateHistoryHelp() {
    const n = History.list().length;
    const ok = store.available('local');
    $('#history-help').textContent = !ok
      ? 'Browser storage is unavailable, so previously played questions cannot be remembered — the game still works normally.'
      : n ? `${n} question${n === 1 ? ' has' : 's have'} been played in this browser before and will be used last.` : 'No previously played questions recorded in this browser.';
    $('#btn-clear-history').hidden = !ok || !n;
  }
  function bindSetup() {
    buildCategoryChoices();
    const f = $('#setup-form');
    f.addEventListener('change', (e) => {
      const t = e.target;
      if (t.name === 'duration') { settings.duration = t.value; settings.roundsManual = false; $('#custom-duration-row').hidden = t.value !== 'custom'; validateCustom(true); }
      if (t.name === 'difficulty') settings.difficulty = t.value;
      if (t.name === 'category') settings.category = t.value;
      if (t.name === 'soundmode') { Sound.setMode(t.value); syncSoundUI(); }
      if (t.type === 'checkbox') readOptionToggles();
      if (t.id === 'opt-spotlights' && !settings.roundsManual) settings.rounds = null;
      updateRoundsUI();
      if (t.type !== 'number') Sound.play('click');
    });
    $('#custom-minutes').addEventListener('input', () => { validateCustom(true); settings.roundsManual = false; updateRoundsUI(); });
    $('#rounds-input').addEventListener('change', (e) => {
      const n = Math.round(Number(e.target.value));
      if (Number.isFinite(n) && n >= 1) { settings.rounds = n; settings.roundsManual = true; }
      updateRoundsUI();
    });
    $('#rounds-minus').addEventListener('click', () => { settings.rounds = (settings.rounds || 1) - 1; settings.roundsManual = true; updateRoundsUI(); Sound.play('click'); });
    $('#rounds-plus').addEventListener('click', () => { settings.rounds = (settings.rounds || 1) + 1; settings.roundsManual = true; updateRoundsUI(); Sound.play('click'); });
    $('#rounds-recommended').addEventListener('click', () => { settings.roundsManual = false; settings.rounds = null; updateRoundsUI(); Sound.play('click'); });
    $('#btn-clear-history').addEventListener('click', () => { History.clear(); updateHistoryHelp(); toast('Question history cleared.'); });
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      readOptionToggles();
      if (!validateCustom(true)) { $('#custom-minutes').focus(); return; }
      updateRoundsUI();
      Sound.play('click');
      goTo('rules');
    });
  }

  /* ---------- Rules ---------- */
  function bindRules() {
    $('#btn-rules-continue').addEventListener('click', () => {
      Sound.play('click');
      if (ui.mode === 'online' && window.WITW_ONLINE) { window.WITW_ONLINE.createRoom(); return; }
      prepareTeamsScreen(); goTo('teams');
    });
  }

  /* ---------- Teams ---------- */
  function randomNames(exclude = []) {
    const ex = exclude.map((x) => x.toLowerCase());
    return shuffle(TEAM_NAMES).filter((n) => !ex.includes(n.toLowerCase()));
  }
  function prepareTeamsScreen() {
    $('#team1-name').value = teams[0] || ''; $('#team2-name').value = teams[1] || '';
    $('#team1-error').textContent = ''; $('#team2-error').textContent = '';
    $('#solo-toggle').checked = solo;
    applySoloUI();
  }
  function applySoloUI() {
    $('.team-input.team-2').hidden = solo;
    $('label[for="team1-name"]').firstChild.textContent = solo ? 'Your name or team name ' : 'Team 1 name ';
    $('#btn-choose-names').textContent = solo ? 'Choose a Name for Me' : 'Choose Names for Us';
  }
  function bindTeams() {
    let lastType = 0;
    ['#team1-name', '#team2-name'].forEach((sel) => $(sel).addEventListener('input', () => {
      const now = performance.now(); if (now - lastType > 60) { Sound.play('type'); lastType = now; }
    }));
    $('#solo-toggle').addEventListener('change', (e) => { solo = e.target.checked; applySoloUI(); $('#team2-error').textContent = ''; Sound.play('click'); });
    $('#btn-choose-names').addEventListener('click', () => {
      const n = randomNames(); $('#team1-name').value = n[0]; if (!solo) $('#team2-name').value = n[1];
      Sound.play('shuffle'); announce(solo ? `Name: ${n[0]}. You can edit it.` : `Team names: ${n[0]} and ${n[1]}. You can edit them.`);
    });
    [[1, '#team1-name', '#team2-name'], [2, '#team2-name', '#team1-name']].forEach(([i, mine, other]) => {
      $(`#team${i}-reroll`).addEventListener('click', () => {
        const n = randomNames([$(other).value, $(mine).value])[0]; $(mine).value = n;
        Sound.play('shuffle'); announce(`Team ${i} is now ${n}.`);
      });
    });
    $('#teams-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const a = $('#team1-name').value.trim().replace(/\s+/g, ' ');
      if (solo) {
        $('#team1-error').textContent = a ? '' : 'Please enter a name (or use Choose a Name for Me).';
        if (!a) { $('#team1-name').focus(); return; }
        teams = [a, ''];
        Sound.play('confirm', { major: true });
        buildStartScreen(); goTo('start');
        return;
      }
      const b = $('#team2-name').value.trim().replace(/\s+/g, ' ');
      $('#team1-error').textContent = a ? '' : 'Please enter a name for Team 1 (or use Choose Names for Us).';
      $('#team2-error').textContent = b ? '' : 'Please enter a name for Team 2 (or use Choose Names for Us).';
      if (a && b && a.toLowerCase() === b.toLowerCase()) $('#team2-error').textContent = 'Each team needs a different name.';
      if (!a || !b || a.toLowerCase() === b.toLowerCase()) { (!a ? $('#team1-name') : $('#team2-name')).focus(); return; }
      teams = [a, b];
      Sound.play('confirm', { major: true });
      buildStartScreen();
      goTo('start');
    });
  }

  /* ---------- Starting page ---------- */
  function buildStartScreen() {
    $('#start-versus').innerHTML = solo
      ? `<div class="vs-name vs-1">● ${esc(teamName(0))}</div><div class="vs">SOLO</div><div class="vs-name vs-2">Aim for ${settings.rounds * 3} points</div>`
      : `<div class="vs-name vs-1">● ${esc(teamName(0))}</div><div class="vs">VS</div><div class="vs-name vs-2">◆ ${esc(teamName(1))}</div>`;
    const diffLabel = { mixed: 'Mixed Challenge', hard: 'Hard', expert: 'Expert Explorer' }[settings.difficulty];
    const catLabel = settings.category === 'all' ? 'All Categories' : settings.category === 'mystery' ? 'Mystery Mix (hidden until reveal)' : settings.category;
    const modeLabel = { professional: 'Professional', fun: 'Fun', chaotic: 'Chaotic', custom: 'Custom' }[Sound.prefs.mode];
    const rows = [
      ['Game length', `${minutesSelected()} minutes`],
      ['Planned rounds', `${settings.rounds} (two 60-second turns each)`],
      ['Difficulty', diffLabel], ['Categories', catLabel], ['Sound mode', modeLabel + (Sound.prefs.muted ? ' (muted)' : '')],
      ['Options', [settings.spotlights && 'Cultural Spotlights', settings.confidence && 'confidence ratings', settings.hints && 'hints', settings.tiebreaker && 'Sudden Death tie-breaker'].filter(Boolean).join(', ') || 'Standard'],
    ];
    $('#start-summary').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
    $('#btn-begin').textContent = 'Begin Round 1';
  }
  function bindStart() {
    $('#btn-begin').addEventListener('click', () => { Sound.play('flourish', { major: true }); newGame(); });
  }

  /* =================================================================
   * 8. TURN TIMER & SESSION CLOCK
   * ================================================================= */
  const Timer = (() => {
    let remaining = TURN_SECONDS; let active = false; let lastTs = 0; let lastWhole = TURN_SECONDS; let iv = null;
    const reasons = new Set(); let onExpire = null;
    const running = () => active && reasons.size === 0;
    function loop() {
      const now = performance.now();
      if (running()) {
        remaining -= (now - lastTs) / 1000;
        const whole = Math.max(0, Math.ceil(remaining));
        if (whole !== lastWhole) { lastWhole = whole; second(whole); }
        if (remaining <= 0) { remaining = 0; active = false; render(); if (onExpire) onExpire(); return; }
      }
      lastTs = now; render();
    }
    function second(w) {
      if (w === 30) announce('30 seconds remaining.');
      if (w === 10) { Sound.play('warn10'); announce('10 seconds remaining.'); }
      else if (w <= 9 && w >= 4) Sound.play('tick');
      else if (w <= 3 && w >= 1) Sound.play('beep');
    }
    function render() {
      const ring = $('#timer-ring'); const num = Math.max(0, Math.ceil(remaining));
      $('#timer-num').textContent = num;
      $('#ring-fg').style.strokeDashoffset = String(119.4 * (1 - clamp(remaining / TURN_SECONDS, 0, 1)));
      ring.classList.toggle('warn', num <= 20 && num > 10);
      ring.classList.toggle('danger', num <= 10);
      ring.classList.toggle('pulse', num <= 10 && running());
      ring.setAttribute('aria-label', `Team turn timer: ${num} seconds`);
      let st = 'Ready';
      if (active) st = reasons.has('manual') ? 'Paused' : reasons.has('hidden') ? 'Paused (tab hidden)' : reasons.size ? 'Paused (panel open)' : 'Running';
      else if (game && game.current && game.current.phase === 'reveal') st = 'Round over';
      else if (remaining <= 0) st = 'Time’s up!';
      $('#timer-state').textContent = st;
      syncToolbar();
    }
    return {
      start(expire) { remaining = TURN_SECONDS; lastWhole = TURN_SECONDS; reasons.delete('manual'); active = true; onExpire = expire; lastTs = performance.now(); if (!iv) iv = window.setInterval(loop, 100); render(); },
      stop() { active = false; reasons.delete('manual'); render(); },
      reset() { remaining = TURN_SECONDS; lastWhole = TURN_SECONDS; lastTs = performance.now(); render(); },
      idle() { active = false; remaining = TURN_SECONDS; lastWhole = TURN_SECONDS; reasons.delete('manual'); render(); },
      pause(reason) { reasons.add(reason); lastTs = performance.now(); render(); },
      resume(reason) { reasons.delete(reason); lastTs = performance.now(); render(); },
      isActive: () => active, isRunning: running, isPaused: (r) => reasons.has(r),
      kill() { active = false; reasons.clear(); remaining = TURN_SECONDS; if (iv) { window.clearInterval(iv); iv = null; } onExpire = null; },
      render,
    };
  })();

  const Session = (() => {
    let iv = null;
    function tick() {
      if (!game || game.ended) return;
      const elapsed = (Date.now() - game.sessionStart) / 1000;
      const left = game.sessionSec - elapsed;
      const el = $('#sb-session');
      el.textContent = left >= 0 ? fmtClock(left) : 'Over +' + fmtClock(-left);
      $('#sb-session-progress').style.width = clamp((elapsed / game.sessionSec) * 100, 0, 100) + '%';
      el.closest('.sb-session').classList.toggle('warn', left <= 120);
      if (settings.warnings) {
        [[300, '5 minutes left in the session.'], [120, '2 minutes left in the session.'], [60, '1 minute left in the session.']].forEach(([th, msg]) => {
          if (!game.warned[th] && left <= th && left > 0) { game.warned[th] = true; toast(msg, th <= 60 ? 'warn' : ''); announce(msg); Sound.play('warn10'); }
        });
      }
      if (left <= 0 && !game.timeUpHandled) { game.timeUpHandled = true; sessionTimeUp(); }
    }
    return {
      start() { if (!iv) iv = window.setInterval(tick, 1000); tick(); },
      stop() { if (iv) { window.clearInterval(iv); iv = null; } },
      tick,
    };
  })();

  async function sessionTimeUp() {
    if (!game || game.ended) return;
    const r = game.current;
    if (r && r.tiebreak) return; // Sudden Death always finishes
    Sound.play('chime', { force: false });
    if (r && r.phase !== 'reveal') {
      const v = await confirmDialog({
        title: 'Scheduled session time is up',
        body: '<p>The current round is still in progress. Would you like to finish it, or end the game now? If you end now, only completed, scored rounds count.</p>',
        buttons: [{ label: 'Finish This Round', value: 'finish', cls: 'btn-primary' }, { label: 'End Game Now', value: 'end', cls: 'btn-secondary' }],
        pauseTimer: true,
      });
      if (!game || game.ended) return;
      if (v === 'end') finishGame({ early: true });
      else { game.finishAfterRound = true; updateNextButton(); toast('This will be the final round.'); }
    } else {
      const v = await confirmDialog({
        title: 'Scheduled session time is up',
        body: '<p>You can finish now and see the results, or keep playing your planned rounds.</p>',
        buttons: [{ label: 'See Final Results', value: 'end', cls: 'btn-primary' }, { label: 'Keep Playing', value: 'keep', cls: 'btn-secondary' }],
      });
      if (!game || game.ended) return;
      if (v === 'end') finishGame({ early: false, timeUp: true });
    }
  }

  /* =================================================================
   * 9. ROUND / TURN FLOW
   * ================================================================= */
  function newGame() {
    Timer.kill();
    MapView.clearReveal();
    game = {
      plannedRounds: settings.rounds, sessionSec: minutesSelected() * 60, sessionStart: Date.now(),
      roundNo: 1, rounds: [], usedIds: new Set(), sequence: [], current: null, finishAfterRound: false,
      timeUpHandled: false, warned: {}, tb: null, ended: false, outcome: null, revealToken: 0, solo,
    };
    $('#sb-team-2').hidden = solo;
    // Do not warn about thresholds longer than the session itself
    [300, 120, 60].forEach((th) => { if (game.sessionSec <= th + 30) game.warned[th] = true; });
    $('#sb-name-1').textContent = teamName(0); $('#sb-name-1').title = teamName(0);
    $('#sb-name-2').textContent = teamName(1); $('#sb-name-2').title = teamName(1);
    renderScores(false);
    goTo('game');
    Session.start();
    startRound();
  }

  function makeRound(q, tiebreak) {
    const first = settings.alternate && !tiebreak && game.roundNo % 2 === 0 ? 1 : 0;
    return {
      no: game.roundNo, q, tiebreak: !!tiebreak,
      order: game.solo ? [0] : [first, 1 - first],
      status: game.solo ? ['pending', 'done'] : ['pending', 'pending'],
      active: null, phase: 'handover', guesses: [null, null], conf: [null, null], hintsShown: 0, result: null, scored: false,
    };
  }

  function startRound() {
    const q = pickQuestion();
    if (!q) { toast('No unused questions remain for these settings — showing results.'); finishGame({ early: false }); return; }
    game.usedIds.add(q.id); game.sequence.push(q.id);
    game.current = makeRound(q, false);
    Sound.play('roundSting', { major: true });
    beginRoundUI();
  }

  /** Shared UI set-up for a fresh round (normal or Sudden Death). */
  function beginRoundUI() {
    const r = game.current;
    game.revealToken++;
    Sound.stopClue();
    MapView.clearReveal();
    MapView.resetView();
    $('#clue-view').hidden = false; $('#reveal-view').hidden = true;
    renderClue();
    renderScores(false);
    showHandover(r.order[0]);
  }

  function renderClue() {
    const r = game.current; const q = r.q;
    const mystery = settings.category === 'mystery' && !r.tiebreak;
    const planned = r.tiebreak ? 'Sudden Death' : `${r.no} / ${game.plannedRounds}`;
    $('#sb-round').textContent = planned;
    $('#sb-round-progress').style.width = r.tiebreak ? '100%' : clamp(((r.no - 1) / game.plannedRounds) * 100, 0, 100) + '%';
    $('#clue-category').innerHTML = `<svg aria-hidden="true"><use href="#${mystery ? 'c-mystery' : CAT_ICON[q.category]}"/></svg>${esc(mystery ? 'Mystery category' : q.category)}`;
    const diff = $('#clue-difficulty'); diff.textContent = r.tiebreak ? 'Expert · Sudden Death' : q.difficulty; diff.classList.toggle('expert', q.difficulty === 'Expert');
    $('#clue-type').textContent = { text: 'Text clue', image: 'Picture clue', audio: 'Sound clue' }[q.clueType] || 'Clue';
    $('#clue-title').textContent = q.title;
    $('#clue-text').textContent = q.clueText;

    // ----- media (image with graceful fallback, audio clue with caption) -----
    const media = $('#clue-media'); media.innerHTML = '';
    const fallback = (label, text) => {
      const d = document.createElement('div'); d.className = 'fallback-card';
      d.innerHTML = `<svg aria-hidden="true"><use href="#${mystery ? 'c-mystery' : CAT_ICON[q.category]}"/></svg><p><span class="fc-label">${esc(label)}</span>${esc(text)}</p>`;
      return d;
    };
    if (q.clueType === 'image') {
      if (settings.images && q.imagePath) {
        const img = document.createElement('img');
        img.src = q.imagePath; img.alt = q.imageAltText || 'Clue image'; img.loading = 'eager';
        img.title = 'Click to enlarge';
        img.addEventListener('click', () => img.classList.toggle('zoomed'));
        img.addEventListener('error', () => { img.replaceWith(fallback('Picture this (image unavailable)', q.imageAltText || 'The clue image could not be loaded.')); }, { once: true });
        media.appendChild(img);
      } else {
        media.appendChild(fallback(settings.images ? 'Picture this' : 'Picture this (images off)', q.imageAltText || 'Imagine the object described in the clue.'));
      }
    } else if (q.clueType === 'text') {
      media.appendChild(fallback(mystery ? 'Mystery clue card' : q.category, 'Read the clue together — who has seen, tasted, heard or visited something like this?'));
    }
    if (q.audioDescription || q.audioSynth || q.audioPath) {
      const box = document.createElement('div'); box.className = 'audio-clue';
      const canPlay = settings.audioClues && (q.audioSynth || q.audioPath);
      box.innerHTML = `<span class="ac-label">Sound clue — description</span><p>${esc(q.audioDescription || 'Listen carefully.')}</p>`;
      if (canPlay) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-secondary btn-small'; b.textContent = '▶ Play sound clue';
        b.addEventListener('click', () => { Sound.playClue(q, (msg) => toast(msg)); });
        const s = document.createElement('button'); s.type = 'button'; s.className = 'btn btn-ghost btn-small'; s.textContent = 'Stop';
        s.addEventListener('click', () => Sound.stopClue());
        box.append(b, document.createTextNode(' '), s);
        const n = document.createElement('p'); n.className = 'help';
        n.textContent = q.audioPath ? 'Licensed recording.' : 'Synthesised impression created for this game — not a field recording.';
        box.appendChild(n);
      } else if (!settings.audioClues) {
        const n = document.createElement('p'); n.className = 'help'; n.textContent = 'Audio clues are switched off — use the description.'; box.appendChild(n);
      }
      media.appendChild(box);
    }
    renderHints();
    // confidence
    $('#confidence-box').hidden = !settings.confidence || r.tiebreak;
  }

  function renderHints() {
    const r = game.current; const q = r.q;
    const box = $('#hints-box');
    box.hidden = !settings.hints || !q.hints.length;
    $('#hint-list').innerHTML = q.hints.slice(0, r.hintsShown).map((h) => `<li>${esc(h)}</li>`).join('');
    const left = q.hints.length - r.hintsShown;
    const btn = $('#btn-hint'); btn.disabled = left <= 0 || r.phase === 'reveal';
    btn.textContent = left > 0 ? `Reveal a hint (${left} left)` : 'No more hints';
  }

  function showHandover(team) {
    const r = game.current;
    r.phase = 'handover'; r.active = team;
    Timer.idle();
    MapView.setPins([]); // never show any guess between turns
    const other = 1 - team;
    const otherDone = !game.solo && r.status[other] === 'done';
    $('#handover-badge').className = 'team-badge team-badge-' + (team + 1); $('#handover-badge').textContent = team + 1;
    $('#handover-title').textContent = (r.tiebreak ? 'Sudden Death: ' : '') + teamName(team);
    $('#handover-text').textContent = (r.tiebreak ? 'One secret guess — closest pin wins. ' : 'Your turn! ') +
      `You have 60 seconds to discuss and place your pin.${otherDone ? ` ${teamName(other)}’s pin is hidden.` : ''} Press Start when your team is ready.`;
    $('#btn-start-turn').textContent = `Start ${teamName(team).length > 24 ? 'Turn' : teamName(team) + '’s Turn'}`;
    $('#map-overlay').hidden = false;
    renderTurnUI();
    window.setTimeout(() => $('#btn-start-turn').focus({ preventScroll: true }), 50);
    announce(`${teamName(team)}, get ready. Press Start when ready.`);
  }

  function startTurn() {
    const r = game && game.current; if (!r || r.phase !== 'handover') return;
    r.phase = 'turn';
    $('#map-overlay').hidden = true;
    Timer.start(onTimeExpired);
    Sound.play('ready');
    renderTurnUI();
    drawActivePin(false);
    announce(`${teamName(r.active)}: your 60 seconds have started. Place your pin on the map.`);
    MapView.focus();
  }

  function renderTurnUI() {
    const r = game.current; const t = r.active;
    const banner = $('#turn-banner');
    banner.className = 'turn-banner ' + (r.tiebreak ? 'tb' : t === 0 ? 't1' : 't2');
    banner.textContent = r.phase === 'turn' ? `${r.tiebreak ? 'Sudden Death — ' : ''}${teamName(t)}: your turn` : `Up next: ${teamName(t)}`;
    $('#sb-team-1').classList.toggle('active', t === 0 && r.phase !== 'reveal');
    $('#sb-team-2').classList.toggle('active', t === 1 && r.phase !== 'reveal');
    const inTurn = r.phase === 'turn';
    const g = r.guesses[t];
    $$('#confidence-options button').forEach((b) => { b.disabled = !inTurn; b.setAttribute('aria-checked', String(r.conf[t] === b.dataset.conf)); });
    const lock = $('#btn-lock'); lock.disabled = !inTurn || !g;
    lock.textContent = inTurn ? `Lock In ${teamName(t).length > 22 ? 'Guess' : teamName(t) + '’s Guess'}` : 'Lock In Guess';
    const ps = $('#pin-status');
    if (!inTurn) ps.textContent = '';
    else if (!g) ps.textContent = 'Click or tap the map to place your pin. You can move it until you lock in.';
    else ps.textContent = `${teamName(t)} pin: ${g.name}${g.snapped ? ' (nearest coastline)' : ''}. Drag or click again to move it.`;
    renderHints();
    syncToolbar();
  }

  function syncToolbar() {
    const r = game && game.current; if (!r) return;
    const turn = r.phase === 'turn'; const hand = r.phase === 'handover'; const rev = r.phase === 'reveal';
    const paused = Timer.isPaused('manual');
    $('#t-pause').disabled = !turn || paused;
    $('#t-resume').disabled = !turn || !paused;
    $('#t-reset-timer').disabled = !turn;
    $('#t-end-turn').disabled = !(turn || hand);
    $('#t-reset-guess').disabled = rev;
    $('#t-reset-round').disabled = false;
    $('#t-skip').disabled = rev || r.tiebreak;
    $('#t-reveal').disabled = rev;
    $('#t-end-game').disabled = false;
  }

  function drawActivePin(animate) {
    const r = game.current; const t = r.active; const g = r.guesses[t];
    if (r.phase !== 'turn' || !g) { MapView.setPins([]); return; }
    MapView.setPins([{ kind: t, lat: g.lat, lng: g.lng, label: teamName(t), draggable: true, animate, title: `${teamName(t)} pin (draggable)` }]);
  }

  /** Places or moves the active team's pin. `forced` = a country chosen from the accessible list. */
  function placePin(lat, lng, forced) {
    const r = game && game.current;
    if (!r || r.phase !== 'turn' || r.active == null) return;
    const t = r.active;
    let c = forced || Geo.countryAt(lat, lng); let snapped = false;
    if (!c) { const n = Geo.nearestCountry(lat, lng, COAST_SNAP_KM); if (n) { c = n.country; snapped = true; } }
    r.guesses[t] = { lat, lng, code: c ? c.code : null, name: c ? c.name : 'Open water', snapped, auto: false };
    Sound.play('pinDrop');
    drawActivePin(true);
    renderTurnUI();
  }

  function lockIn() {
    const r = game && game.current; if (!r || r.phase !== 'turn') return;
    const t = r.active;
    if (!r.guesses[t]) { $('#pin-status').textContent = 'Place a pin on the map first.'; return; }
    if (settings.confidence && !r.tiebreak && !r.conf[t]) {
      $('#pin-status').textContent = 'Choose a confidence rating before locking in.';
      $('#confidence-options button').focus();
      return;
    }
    endTurn('lock');
  }

  function onTimeExpired() {
    const r = game && game.current; if (!r || r.phase !== 'turn') return;
    const hasPin = !!r.guesses[r.active];
    Sound.play(Sound.prefs.mode === 'professional' || Sound.prefs.mode === 'custom' && !Sound.prefs.custom.comedy ? 'buzzer' : 'horn', { major: true });
    toast(hasPin ? `Time’s up! ${teamName(r.active)}’s pin was locked automatically.` : `Time’s up! ${teamName(r.active)} did not place a pin.`, 'warn');
    endTurn('timeout');
  }

  /** Ends the active team's turn. reason: lock | timeout | endTurn | reveal */
  function endTurn(reason) {
    const r = game.current; const t = r.active;
    if (r.phase !== 'turn' && r.phase !== 'handover') return;
    Timer.stop();
    const g = r.guesses[t];
    if (g) { g.locked = true; g.auto = reason !== 'lock'; Sound.play('lockChime'); }
    if (!r.conf[t] && g) r.conf[t] = 'Not stated';
    r.status[t] = 'done';
    announce(g ? `${teamName(t)} locked in a guess.` : `${teamName(t)}’s turn ended without a guess.`);
    if (reason === 'reveal') return;
    const next = r.order.find((x) => r.status[x] === 'pending');
    if (next != null) showHandover(next); else reveal();
  }

  /* ---------- facilitator tools ---------- */
  function bindGameControls() {
    MapView.onClick((lat, lng) => placePin(lat, lng));
    MapView.onDrag((lat, lng) => placePin(lat, lng));
    $('#btn-start-turn').addEventListener('click', startTurn);
    $('#btn-lock').addEventListener('click', lockIn);
    $('#btn-hint').addEventListener('click', () => {
      const r = game.current; if (r.hintsShown < r.q.hints.length) { r.hintsShown++; renderHints(); Sound.play('click'); announce('Hint: ' + r.q.hints[r.hintsShown - 1]); }
    });
    $('#confidence-options').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-conf]'); if (!b) return;
      const r = game.current; if (r.phase !== 'turn') return;
      r.conf[r.active] = b.dataset.conf; Sound.play('click'); renderTurnUI();
    });
    // Arrow-key navigation inside the confidence radio group
    $('#confidence-options').addEventListener('keydown', (e) => {
      const btns = $$('#confidence-options button'); const i = btns.indexOf(document.activeElement);
      if (i < 0) return;
      if (['ArrowRight', 'ArrowDown'].includes(e.key)) { e.preventDefault(); btns[(i + 1) % btns.length].focus(); }
      if (['ArrowLeft', 'ArrowUp'].includes(e.key)) { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length].focus(); }
    });
    // Answers are placed only by clicking/tapping the map (or dragging the pin) — no typing.
    $('#btn-reset-view').addEventListener('click', () => { MapView.resetView(); Sound.play('click'); });

    $('#t-pause').addEventListener('click', () => { Timer.pause('manual'); announce('Timer paused.'); });
    $('#t-resume').addEventListener('click', () => { Timer.resume('manual'); announce('Timer resumed.'); });
    $('#t-reset-timer').addEventListener('click', () => { Timer.reset(); announce('Timer reset to 60 seconds.'); });
    $('#t-end-turn').addEventListener('click', async () => {
      const r = game.current; const t = r.active;
      const v = await confirmDialog({ title: 'End this turn?', body: `<p>${esc(teamName(t))}’s turn will end now. ${r.guesses[t] ? 'Their placed pin will be locked in.' : 'They have not placed a pin, so they will score 0 this round.'}</p>`, buttons: [{ label: 'End Turn', value: 'yes', cls: 'btn-primary' }, { label: 'Cancel', value: 'no', cls: 'btn-ghost' }], pauseTimer: true });
      if (v === 'yes' && game && game.current === r && (r.phase === 'turn' || r.phase === 'handover')) endTurn('endTurn');
    });
    $('#t-reset-guess').addEventListener('click', resetTeamGuess);
    $('#t-reset-round').addEventListener('click', async () => {
      const r = game.current;
      const v = await confirmDialog({ title: 'Reset the current round?', body: `<p>Both guesses${r.scored && !r.tiebreak ? ' and any points awarded this round' : ''} will be removed and the timer restored. The same question will be replayed.</p>`, buttons: [{ label: 'Reset Round', value: 'yes', cls: 'btn-primary' }, { label: 'Cancel', value: 'no', cls: 'btn-ghost' }], pauseTimer: true });
      if (v === 'yes' && game && game.current === r) resetRound();
    });
    $('#t-skip').addEventListener('click', async () => {
      const r = game.current;
      const v = await confirmDialog({ title: 'Skip this question?', body: '<p>A new question will replace this one. This round’s guesses will be cleared and the round number stays the same.</p>', buttons: [{ label: 'Skip Question', value: 'yes', cls: 'btn-primary' }, { label: 'Cancel', value: 'no', cls: 'btn-ghost' }], pauseTimer: true });
      if (v === 'yes' && game && game.current === r) skipQuestion();
    });
    $('#t-reveal').addEventListener('click', async () => {
      const r = game.current;
      const pending = r.order.filter((t) => r.status[t] === 'pending');
      if (pending.length) {
        const names = pending.map(teamName).join(' and ');
        const v = await confirmDialog({ title: 'Reveal the answer now?', body: `<p>${esc(names)} ${pending.length > 1 ? 'have' : 'has'} not finished. Any placed pin will be locked in; a team with no pin scores 0.</p>`, buttons: [{ label: 'Reveal Answer', value: 'yes', cls: 'btn-primary' }, { label: 'Cancel', value: 'no', cls: 'btn-ghost' }], pauseTimer: true });
        if (v !== 'yes' || !game || game.current !== r || r.phase === 'reveal') return;
        if (r.phase === 'turn') endTurn('reveal');
        r.order.forEach((t) => { if (r.status[t] === 'pending') r.status[t] = 'done'; });
      }
      reveal();
    });
    $('#t-end-game').addEventListener('click', async () => {
      const r = game.current;
      const counts = r && r.scored && !r.tiebreak;
      const v = await confirmDialog({ title: 'End the game early?', body: `<p>Scores will be calculated from completed, scored rounds only${counts ? ' (including this round)' : r && !r.tiebreak ? '. The current unfinished round will not count' : ''}.</p>`, buttons: [{ label: 'End Game Now', value: 'yes', cls: 'btn-primary' }, { label: 'Keep Playing', value: 'no', cls: 'btn-ghost' }], pauseTimer: true });
      if (v === 'yes' && game && !game.ended) finishGame({ early: true });
    });
    $('#btn-next').addEventListener('click', onNext);
  }

  async function resetTeamGuess() {
    const r = game.current; if (r.phase === 'reveal') return;
    const v = await confirmDialog({
      title: 'Reset a team’s guess',
      body: '<p>Which team’s guess should be cleared? A team that has already locked in will retake its turn.</p>',
      buttons: [{ label: teamName(0), value: '0', cls: 'btn-secondary' }].concat(game.solo ? [] : [{ label: teamName(1), value: '1', cls: 'btn-secondary' }]).concat([{ label: 'Cancel', value: 'no', cls: 'btn-ghost' }]),
      pauseTimer: true,
    });
    if (v !== '0' && v !== '1') return;
    if (!game || game.current !== r || r.phase === 'reveal') return;
    const t = Number(v);
    r.guesses[t] = null; r.conf[t] = null;
    if (r.active === t && r.phase === 'turn') { drawActivePin(false); renderTurnUI(); announce(`${teamName(t)}’s pin has been cleared.`); return; }
    if (r.status[t] === 'done') { r.status[t] = 'pending'; toast(`${teamName(t)} will retake its turn.`); }
    if (r.phase === 'handover' && r.active !== t && r.status[r.active] === 'done') showHandover(t);
    renderTurnUI();
  }

  function resetRound() {
    const r = game.current;
    Timer.stop();
    if (r.scored && !r.tiebreak) game.rounds = game.rounds.filter((x) => x.no !== r.no); // remove points awarded this round
    if (r.tiebreak && game.tb) game.tb.log = game.tb.log.filter((x) => x.round !== r);
    game.current = makeRound(r.q, r.tiebreak);
    game.current.no = r.no;
    renderScores(false);
    toast('Round reset — same question, fresh guesses.');
    beginRoundUI();
  }

  function skipQuestion() {
    const r = game.current;
    History.add(r.q.id);
    const q = pickQuestion();
    if (!q) { toast('No other unused questions are available for these settings.'); return; }
    game.usedIds.add(q.id); game.sequence.push(q.id);
    Timer.stop();
    game.current = makeRound(q, false); game.current.no = r.no;
    toast('Question skipped.');
    Sound.play('mystery', { major: true });
    beginRoundUI();
  }

  function onNext() {
    const r = game.current;
    if (r.tiebreak) { tiebreakNext(); return; }
    if (game.finishAfterRound || game.roundNo >= game.plannedRounds) { finishGame({ early: false }); return; }
    game.roundNo++;
    startRound();
  }
  function updateNextButton() {
    const r = game && game.current; if (!r || r.tiebreak) return;
    $('#btn-next').textContent = game.finishAfterRound || game.roundNo >= game.plannedRounds ? 'See Final Results' : `Next Round (${game.roundNo + 1} of ${game.plannedRounds})`;
  }

  function renderScores(bump) {
    const t = totals();
    [0, 1].forEach((i) => {
      const el = $('#sb-score-' + (i + 1));
      if (el.textContent !== String(t[i]) && bump) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }
      el.textContent = t[i];
    });
  }

  /* =================================================================
   * 10. SCORING & ANSWER REVEAL
   * ================================================================= */
  /** Pure scoring function — awards points exactly once per round (the caller records it once). */
  function scoreRound(q, guesses, soloMode) {
    const ans = [q.correctLatitude, q.correctLongitude];
    const info = guesses.map((g) => {
      if (!g) return null;
      const km = Math.round(Geo.haversine(g.lat, g.lng, ans[0], ans[1]));
      const inCountry = !!g.code && q.acceptedCountryCodes.includes(g.code);
      const seaHit = !g.code && km <= SEA_TOLERANCE_KM;
      return { km, correct: inCountry || seaHit, seaHit };
    });
    const points = [0, 0]; const reasons = ['', ''];
    const valid = info.filter(Boolean).length;
    if (soloMode) {
      // Solo / single-team scoring: no rival to compare against, so closeness is judged by distance.
      const me = info[0];
      if (!me) { points[0] = 0; reasons[0] = 'No pin was locked in, so no points this round.'; }
      else if (me.correct) { points[0] = 3; reasons[0] = me.seaHit ? 'Pin in the sea within 50 km of the answer — counts as the correct location.' : `Pin is inside ${q.correctCountry.split(' (')[0]} — the correct country!`; }
      else if (me.km <= SOLO_NEAR_KM) { points[0] = 2; reasons[0] = 'Incorrect, but within 1,000 km of the answer.'; }
      else { points[0] = 1; reasons[0] = 'Incorrect and more than 1,000 km from the answer.'; }
      return { info, points, reasons, noneSubmitted: !me };
    }
    for (let t = 0; t < 2; t++) {
      const me = info[t]; const other = info[1 - t];
      if (!me) { points[t] = 0; reasons[t] = valid ? 'No guess was locked in, so no points this round.' : 'Neither team submitted a guess.'; continue; }
      if (me.correct) { points[t] = 3; reasons[t] = me.seaHit ? 'Pin in the sea within 50 km of the answer — counts as the correct location.' : `Pin is inside ${q.correctCountry.split(' (')[0]} — the correct country!`; continue; }
      if (!other) { points[t] = 2; reasons[t] = 'Incorrect, but the only submitted guess — it counts as the closer guess.'; continue; }
      if (other.correct) { points[t] = 1; reasons[t] = 'Incorrect — the other team found the correct country.'; continue; }
      if (me.km < other.km) { points[t] = 2; reasons[t] = 'Incorrect, but the closer of the two guesses.'; }
      else if (me.km === other.km) { points[t] = 2; reasons[t] = 'Incorrect — both guesses are exactly the same rounded distance away, so both score 2.'; }
      else { points[t] = 1; reasons[t] = 'Incorrect and further away than the other guess.'; }
    }
    return { info, points, reasons, noneSubmitted: valid === 0 };
  }

  function reveal() {
    const r = game.current;
    if (r.phase === 'reveal') return;
    Timer.stop();
    r.phase = 'reveal';
    $('#map-overlay').hidden = true;
    Sound.stopClue();
    if (r.tiebreak) { revealTiebreak(); return; }
    if (!r.scored) {
      r.result = scoreRound(r.q, r.guesses, game.solo);
      r.scored = true; // guard: points are recorded once, and removed by Reset Current Round
      game.rounds.push({ no: r.no, q: r.q, guesses: r.guesses.map((g) => g && Object.assign({}, g)), conf: r.conf.slice(), result: r.result });
      History.add(r.q.id);
    }
    renderRevealCommon();
    const res = r.result;
    // result cards
    $('#result-cards').innerHTML = (game.solo ? [0] : [0, 1]).map((t) => resultCard(t, res.points[t], res.info[t], res.reasons[t], r.conf[t])).join('') +
      (res.noneSubmitted ? '<div class="result-card"><p class="rc-detail"><strong>No guesses this round.</strong> You can replay it with the same question, or continue.</p><button type="button" class="btn btn-secondary btn-small" id="btn-replay">Replay this round</button></div>' : '');
    const replay = $('#btn-replay'); if (replay) replay.addEventListener('click', resetRound);
    updateNextButton();
    renderScores(true);
    playRevealSounds(res, r.conf);
    announce(`The answer is ${r.q.answerName}, ${r.q.correctCountry}. ${teamName(0)} scores ${res.points[0]}, ${teamName(1)} scores ${res.points[1]}.`);
  }

  function renderRevealCommon() {
    const r = game.current; const q = r.q;
    $('#clue-view').hidden = true; $('#reveal-view').hidden = false;
    $('#sb-team-1').classList.remove('active'); $('#sb-team-2').classList.remove('active');
    $('#reveal-eyebrow').textContent = r.tiebreak ? 'Sudden Death reveal' : `Answer reveal — Round ${r.no}${settings.category === 'mystery' ? ' · ' + q.category : ''}`;
    $('#reveal-answer').textContent = q.answerName;
    $('#reveal-country').innerHTML = `<svg aria-hidden="true"><use href="#i-star"/></svg>${esc(q.correctCountry)}`;
    // Cultural Spotlight (or compact explanation) + always-visible sources
    const src = `<p class="sources"><strong>Sources:</strong> ${q.factualSources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a>`).join(' · ')}</p>`;
    $('#spotlight').innerHTML = settings.spotlights
      ? `<h4>Cultural Spotlight</h4><dl><dt>What it is</dt><dd>${esc(q.answerExplanation)}</dd><dt>Why it matters</dt><dd>${esc(q.culturalSignificance)}</dd><dt>Memorable fact</dt><dd>${esc(q.surprisingFact)}</dd>${q.originNuance ? `<dt>Origins &amp; nuance</dt><dd>${esc(q.originNuance)}</dd>` : ''}</dl>${src}`
      : `<p>${esc(q.answerExplanation)}</p>${q.originNuance ? `<p><em>${esc(q.originNuance)}</em></p>` : ''}${src}`;
    // map
    MapView.showReveal({
      codes: q.acceptedCountryCodes,
      answer: { lat: q.correctLatitude, lng: q.correctLongitude },
      guesses: r.guesses.map((g, t) => g && { kind: t, lat: g.lat, lng: g.lng, label: teamName(t), km: Geo.haversine(g.lat, g.lng, q.correctLatitude, q.correctLongitude) }),
      showDistance: settings.distance,
    });
    window.setTimeout(() => $('#reveal-answer').focus({ preventScroll: true }), 80);
  }

  function resultCard(t, points, info, reason, conf) {
    const g = game.current.guesses[t];
    const dist = info && settings.distance ? ` · ${fmtKm(info.km)} from the answer` : '';
    const where = g ? `Pin: ${esc(g.name)}${g.snapped ? ' (coastline)' : ''}${dist}${g.auto ? ' · auto-locked' : ''}` : 'No pin placed';
    const c = conf && !game.current.tiebreak ? ` · Confidence: ${esc(conf)}` : '';
    const pts = points == null ? '' : `<span class="rc-points">+${points}</span>`;
    return `<div class="result-card t${t + 1}"><div class="rc-head"><span class="rc-name">${t === 0 ? '●' : '◆'} ${esc(teamName(t))}</span>${pts}</div><p class="rc-detail">${where}${c}</p><p class="rc-reason">${esc(reason)}</p></div>`;
  }

  /** Context-aware reveal audio: drum roll → impact → one varied reaction. */
  let lastReaction = '';
  function playRevealSounds(res, conf) {
    const token = ++game.revealToken;
    const mode = Sound.prefs.mode;
    Sound.play('drumroll', { major: true });
    window.setTimeout(() => {
      if (!game || game.revealToken !== token) return;
      Sound.play('impact');
      const anyCorrect = res.info.some((i) => i && i.correct);
      const correctGuess = res.info.some((i, t) => i && i.correct && conf[t] === 'Total Guess');
      const correctVery = res.info.some((i, t) => i && i.correct && conf[t] === 'Very Confident');
      const near = res.info.some((i) => i && !i.correct && i.km <= 400);
      const wrongVery = res.info.some((i, t) => i && !i.correct && conf[t] === 'Very Confident');
      const wrongGuess = res.info.some((i, t) => i && !i.correct && conf[t] === 'Total Guess');
      let seq = [];
      if (mode === 'professional') seq = [anyCorrect ? 'success' : 'softTone'];
      else if (correctGuess) seq = ['jackpot', 'cheer'];
      else if (correctVery) seq = ['success', 'cheer', mode === 'chaotic' ? 'airhorn' : null];
      else if (anyCorrect) seq = ['success', mode === 'chaotic' ? 'cheer' : 'applause'];
      else if (near) seq = [pick(['gasp', 'ooh']), 'nearMiss'];
      else if (wrongVery) seq = [pick(['recordScratch', 'sadTrombone'])];
      else if (wrongGuess) seq = ['shrug'];
      else {
        const opts = ['sadTrombone', 'wahwah', 'gentleBuzzer', 'quack', 'recordScratch'].filter((s) => s !== lastReaction);
        seq = [pick(opts)];
      }
      seq = seq.filter(Boolean);
      lastReaction = seq[0];
      seq.forEach((s, i) => window.setTimeout(() => { if (game && game.revealToken === token) Sound.play(s, { major: i === 0 }); }, 250 + i * 650));
    }, 1650);
  }

  /* =================================================================
   * 11. SUDDEN DEATH, END OF GAME & WORLD JOURNEY
   * ================================================================= */
  async function finishGame({ early, timeUp }) {
    if (!game || game.ended) return;
    Timer.stop();
    Sound.stopClue();
    const r = game.current;
    if (r && !r.scored && !r.tiebreak) { /* unfinished round is discarded and never counted */ }
    const t = totals();
    if (game.solo) { const n = game.rounds.length; endScreen({ winner: 0, method: 'solo', note: `Solo game: ${t[0]} points from ${n} completed round${n === 1 ? '' : 's'}, out of a possible ${n * 3}${early ? ' (game ended early)' : ''}.` }); return; }
    if (t[0] !== t[1]) { endScreen({ winner: t[0] > t[1] ? 0 : 1, method: 'score', note: `Decided on total score from ${game.rounds.length} completed round${game.rounds.length === 1 ? '' : 's'}: ${t[0]} to ${t[1]}${early ? ' (game ended early)' : ''}.` }); return; }
    const canTB = DATA.TIEBREAKERS.length > 0 && (!game.tb || DATA.TIEBREAKERS.some((q) => !game.tb.used.has(q.id)));
    if (!settings.tiebreaker || !canTB) { endScreen({ winner: null, method: 'draw', note: `Scores are level at ${t[0]}–${t[1]}${settings.tiebreaker ? '' : ' and the tie-breaker is switched off'}, so the game is a draw.` }); return; }
    if (early || timeUp) {
      const v = await confirmDialog({
        title: 'Scores are level!', body: `<p>Both teams have ${t[0]} points. Play an Expert Sudden Death question, or declare a draw?</p>`,
        buttons: [{ label: 'Sudden Death', value: 'tb', cls: 'btn-primary' }, { label: 'Declare a Draw', value: 'draw', cls: 'btn-secondary' }],
      });
      if (!game || game.ended) return;
      if (v !== 'tb') { endScreen({ winner: null, method: 'draw', note: `Scores level at ${t[0]}–${t[1]}; the facilitator declared a draw.` }); return; }
    }
    startTiebreak();
  }

  function startTiebreak() {
    if (!game.tb) game.tb = { attempt: 0, used: new Set(), log: [] };
    const q = pickTiebreaker();
    if (!q) { resolveTieFallback(); return; }
    game.tb.used.add(q.id); game.tb.attempt++;
    game.current = makeRound(q, true);
    game.current.no = game.roundNo;
    const t = totals();
    $('#tb-kicker').textContent = game.tb.attempt === 1 ? 'IT’S A TIE!' : 'STILL TIED — EXACTLY!';
    $('#tb-score').textContent = `${teamName(0)} ${t[0]} – ${t[1]} ${teamName(1)}`;
    goTo('tiebreak');
    const title = $('#tb-title'); title.classList.remove('shake'); void title.offsetWidth; title.classList.add('shake');
    Sound.play('suddenDeath', { major: true });
    Sound.play('heartbeat', { delay: 2.2 });
  }

  function revealTiebreak() {
    const r = game.current; const q = r.q;
    const km = r.guesses.map((g) => (g ? Math.round(Geo.haversine(g.lat, g.lng, q.correctLatitude, q.correctLongitude)) : Infinity));
    const entry = { round: r, q, km };
    game.tb.log.push(entry);
    renderRevealCommon();
    let verdict = '';
    if (km[0] !== km[1]) {
      const w = km[0] < km[1] ? 0 : 1;
      entry.winner = w;
      verdict = `${teamName(w)}’s pin was closest${Number.isFinite(km[1 - w]) ? ` (${fmtKm(km[w])} vs ${fmtKm(km[1 - w])})` : ' — the other team did not submit'}.`;
      r.tbOutcome = { winner: w, method: 'suddenDeath', note: `Won in Expert Sudden Death: ${verdict}` };
      $('#btn-next').textContent = 'See the Winner';
    } else {
      verdict = Number.isFinite(km[0]) ? `Both pins are exactly ${fmtKm(km[0])} from the answer!` : 'Neither team submitted a guess.';
      $('#btn-next').textContent = game.tb.attempt === 1 && DATA.TIEBREAKERS.some((x) => !game.tb.used.has(x.id)) ? 'Next Expert Question' : 'Apply Tie-Break Rules';
      r.tbOutcome = null;
    }
    $('#result-cards').innerHTML = [0, 1].map((t) => resultCard(t, null, r.guesses[t] ? { km: km[t] } : null, Number.isFinite(km[t]) ? `${fmtKm(km[t])} from the answer.` : 'No guess submitted.', null)).join('') +
      `<div class="result-card"><p class="rc-detail"><strong>${esc(verdict)}</strong></p></div>`;
    Sound.play('drumroll', { major: true });
    window.setTimeout(() => { if (game && game.current === r) { Sound.play('impact'); Sound.play(r.tbOutcome ? 'fanfare' : 'suspense', { major: true, delay: 0.3 }); } }, 1650);
    announce(verdict);
  }

  function tiebreakNext() {
    const r = game.current;
    if (r.tbOutcome) { endScreen(r.tbOutcome); return; }
    if (game.tb.attempt === 1 && DATA.TIEBREAKERS.some((x) => !game.tb.used.has(x.id))) { startTiebreak(); return; }
    resolveTieFallback();
  }

  /** Tie-break chain after repeated exact ties: correct-country count → average proximity → facilitator. */
  async function resolveTieFallback() {
    const correct = [0, 0]; const dist = [[], []];
    game.rounds.forEach((rd) => rd.result.info.forEach((i, t) => { if (i) { if (i.correct) correct[t]++; dist[t].push(i.km); } }));
    if (correct[0] !== correct[1]) {
      const w = correct[0] > correct[1] ? 0 : 1;
      endScreen({ winner: w, method: 'correctCount', note: `Still tied after Sudden Death, so the winner was decided by correct-country answers in the main game: ${correct[w]} vs ${correct[1 - w]}.` });
      return;
    }
    const avg = dist.map((d) => (d.length ? Math.round(d.reduce((a, b) => a + b, 0) / d.length) : Infinity));
    if (avg[0] !== avg[1]) {
      const w = avg[0] < avg[1] ? 0 : 1;
      endScreen({ winner: w, method: 'avgProximity', note: `Still tied after Sudden Death and on correct countries (${correct[0]} each), so the winner was decided by average distance across main-game guesses: ${Number.isFinite(avg[w]) ? fmtKm(avg[w]) : '—'} vs ${Number.isFinite(avg[1 - w]) ? fmtKm(avg[1 - w]) : 'no guesses'}.` });
      return;
    }
    const more = DATA.TIEBREAKERS.some((x) => !game.tb.used.has(x.id));
    const v = await confirmDialog({
      title: 'A truly perfect tie!',
      body: `<p>The teams are level on score, Sudden Death distance, correct countries (${correct[0]} each) and average proximity. How would you like to finish?</p>`,
      buttons: [{ label: 'Declare Joint Winners', value: 'joint', cls: 'btn-primary' }].concat(more ? [{ label: 'Another Expert Question', value: 'again', cls: 'btn-secondary' }] : []),
    });
    if (!game || game.ended) return;
    if (v === 'again' && more) { startTiebreak(); return; }
    endScreen({ winner: null, method: 'joint', note: 'Level on every tie-break measure — the facilitator declared joint winners.' });
  }

  function endScreen(outcome) {
    game.ended = true; game.outcome = outcome;
    Timer.stop(); Session.stop(); Sound.stopClue();
    $('#map-overlay').hidden = true;
    const t = totals();
    const w = outcome.winner;
    if (game.solo) {
      const max = game.rounds.length * 3; const pct = max ? t[0] / max : 0;
      $('#end-title').textContent = `Journey complete, ${teamName(0)}!`;
      $('#champion-msg').textContent = pct >= 0.8 ? 'Master navigator — you know your world!' : pct >= 0.5 ? 'A well-travelled explorer — great instincts!' : 'Every round was a new discovery — that’s what the journey is for!';
      $('#final-scores').innerHTML = `<div class="final-score t1 win"><div class="fs-name">● ${esc(teamName(0))}</div><div class="fs-pts">${t[0]}</div><div>out of ${max} possible points</div></div>`;
      $('#method-note').textContent = outcome.note;
    } else {
      $('#end-title').textContent = w == null ? (outcome.method === 'joint' ? `Joint winners: ${teamName(0)} & ${teamName(1)}!` : 'It’s a draw!') : `${teamName(w)} win!`;
      $('#champion-msg').textContent = w == null ? 'Shared glory — both teams travelled brilliantly together.' : pick(CHAMPION_LINES);
      $('#final-scores').innerHTML = [0, 1].map((i) => `<div class="final-score t${i + 1}${w === i || (w == null && outcome.method === 'joint') ? ' win' : ''}"><div class="fs-name">${i === 0 ? '●' : '◆'} ${esc(teamName(i))}</div><div class="fs-pts">${t[i]}</div><div>points</div></div>`).join('');
      $('#method-note').textContent = 'How the winner was determined: ' + outcome.note;
    }
    renderJourney(outcome);
    goTo('end');
    Sound.play('confettiPop');
    if (Sound.prefs.mode === 'professional') Sound.play('applause', { delay: 0.3 });
    else { Sound.play('fanfare', { major: true, delay: 0.25 }); Sound.play('applause', { delay: 1.2 }); if (Sound.prefs.mode === 'chaotic') Sound.play('cheer', { delay: 1.6 }); }
    confetti();
    announce($('#end-title').textContent + ' ' + $('#method-note').textContent);
  }

  function renderJourney(outcome) {
    const rounds = game.rounds;
    const items = [];
    const countries = [...new Set(rounds.map((r) => r.q.correctCountry.split(' (')[0]))];
    const continents = [...new Set(rounds.map((r) => continentOf(r.q)))];
    items.push(['Countries explored', countries.length ? `${countries.length}: ${countries.join(', ')}` : 'No rounds completed']);
    items.push(['Continents represented', continents.length ? `${continents.length}: ${continents.join(', ')}` : '—']);
    const correct = [0, 0];
    rounds.forEach((r) => r.result.info.forEach((i, t) => { if (i && i.correct) correct[t]++; }));
    items.push(['Correct-country guesses', game.solo ? `${correct[0]} of ${rounds.length}` : `${teamName(0)}: ${correct[0]} · ${teamName(1)}: ${correct[1]}`]);
    let closest = null;
    rounds.forEach((r) => r.result.info.forEach((i, t) => { if (i && (!closest || i.km < closest.km)) closest = { km: i.km, t, q: r.q }; }));
    items.push(['Closest guess of the game', closest ? `${teamName(closest.t)} — ${fmtKm(closest.km)} from ${closest.q.answerName}` : '—']);
    const best = (wantCorrect) => {
      let b = null;
      rounds.forEach((r) => r.result.info.forEach((i, t) => {
        if (!i || i.correct !== wantCorrect) return;
        const rank = CONFIDENCE_RANK[r.conf[t]] || 0;
        if (!b || rank > b.rank) b = { rank, t, r, conf: r.conf[t] };
      }));
      return b;
    };
    const mc = best(true); const mi = best(false);
    items.push(['Most confident correct answer', mc && mc.rank ? `${teamName(mc.t)} — ${mc.conf} about ${mc.r.q.answerName}, and right!` : mc ? `${teamName(mc.t)} found ${mc.r.q.answerName}` : 'No correct countries this time — plenty of new discoveries!']);
    items.push(['Most confident incorrect answer', mi && mi.rank >= 3 ? `${teamName(mi.t)} — ${mi.conf} on ${mi.r.q.answerName} (it was ${mi.r.q.correctCountry.split(' (')[0]})` : 'No overconfident misses — well judged!']);
    if (game.solo) {
      const near = rounds.filter((r) => r.result.info[0] && !r.result.info[0].correct && r.result.info[0].km <= SOLO_NEAR_KM).length;
      items.push(['Near misses (within 1,000 km)', String(near)]);
    } else if (outcome.winner != null && rounds.length) {
      let run = [0, 0]; let deficit = 0; const w = outcome.winner;
      rounds.forEach((r) => { run = [run[0] + r.result.points[0], run[1] + r.result.points[1]]; deficit = Math.max(deficit, run[1 - w] - run[w]); });
      items.push(['Biggest comeback', deficit > 0 ? `${teamName(w)} came back from ${deficit} point${deficit === 1 ? '' : 's'} behind!` : `${teamName(w)} were never behind after a completed round.`]);
    } else items.push(['Biggest comeback', 'No single comeback — it was neck and neck.']);
    let surprise = null;
    rounds.forEach((r) => { const ks = r.result.info.filter(Boolean).map((i) => i.km); if (!ks.length) return; const avg = ks.reduce((a, b) => a + b, 0) / ks.length; if (!surprise || avg > surprise.avg) surprise = { avg, r }; });
    items.push(['Most surprising Cultural Spotlight', surprise && surprise.avg > 0 ? `${surprise.r.q.answerName} (${surprise.r.q.correctCountry.split(' (')[0]}) — guesses averaged ${fmtKm(surprise.avg)} away` : '—']);
    const t = totals();
    if (game.solo) items.push(['Final score', `${t[0]} out of ${rounds.length * 3}`]);
    else {
      items.push(['Winning team', outcome.winner == null ? (outcome.method === 'joint' ? 'Joint winners' : 'Draw') : teamName(outcome.winner)]);
      items.push(['Final scores', `${teamName(0)} ${t[0]} – ${t[1]} ${teamName(1)}`]);
    }
    $('#journey-grid').innerHTML = items.map(([h, p]) => `<div class="journey-item"><h4>${esc(h)}</h4><p>${esc(p)}</p></div>`).join('');
  }

  function bindTiebreak() {
    $('#btn-tb-begin').addEventListener('click', () => {
      if (!game || !game.current || !game.current.tiebreak || game.current.phase !== 'handover') return;
      Sound.play('mystery', { major: true });
      goTo('game');
      beginRoundUI();
    });
  }

  function bindEnd() {
    $('#btn-again').addEventListener('click', () => { Sound.play('click'); Sound.stopAll(); game = null; buildStartScreen(); goTo('start'); });
    $('#btn-new-setup').addEventListener('click', () => { Sound.play('click'); Sound.stopAll(); game = null; settingsToForm(); goTo('setup'); });
    $('#btn-highlights').addEventListener('click', openHighlights);
    $('#btn-end-credits').addEventListener('click', openCredits);
    $('#btn-end-mute').addEventListener('click', () => toggleMute());
    $('#btn-restart').addEventListener('click', async () => {
      const v = await confirmDialog({ title: 'Restart the entire game?', body: '<p>This clears team names, scores, round history, guesses, timers and the question sequence, and returns to the introduction. Sound preferences are kept.</p>', buttons: [{ label: 'Restart Everything', value: 'yes', cls: 'btn-primary' }, { label: 'Cancel', value: 'no', cls: 'btn-ghost' }] });
      if (v === 'yes') restartEverything();
    });
  }

  function restartEverything() {
    Timer.kill(); Session.stop(); Sound.stopAll();
    MapView.clearReveal(); MapView.resetView();
    game = null; teams = ['', '']; solo = false;
    $('#solo-toggle').checked = false; $('#sb-team-2').hidden = false;
    settings = Object.assign({}, DEFAULT_SETTINGS);
    $('#team1-name').value = ''; $('#team2-name').value = '';
    $('#sb-score-1').textContent = '0'; $('#sb-score-2').textContent = '0';
    $('#map-overlay').hidden = true;
    stopConfetti();
    settingsToForm();
    goTo('intro');
    toast('Game fully reset.');
  }

  /* =================================================================
   * 12. DIALOGS
   * ================================================================= */
  /** Generic modal used for every confirmation. Pauses the turn timer while open. */
  function openDialog(dlg, { pauseTimer = true } = {}) {
    if (pauseTimer && Timer.isActive()) { Timer.pause('modal:' + dlg.id); dlg.addEventListener('close', () => Timer.resume('modal:' + dlg.id), { once: true }); }
    if (typeof dlg.showModal === 'function') { if (!dlg.open) dlg.showModal(); } else dlg.setAttribute('open', '');
  }
  function confirmDialog({ title, body, buttons, pauseTimer = true }) {
    const dlg = $('#dlg-confirm');
    if (dlg.open) dlg.close('superseded');
    $('#dlg-confirm-title').textContent = title;
    $('#dlg-confirm-body').innerHTML = body;
    $('#dlg-confirm-actions').innerHTML = buttons.map((b) => `<button type="submit" class="btn ${b.cls || 'btn-secondary'}" value="${esc(b.value)}">${esc(b.label)}</button>`).join('');
    dlg.returnValue = '';
    return new Promise((resolve) => {
      // Resolve straight from the button press (the dialog 'close' event can be delayed in background tabs);
      // the 'close' event still covers Esc / cancel.
      let settled = false;
      const onClose = () => { if (!dlg.open) done(dlg.returnValue); }; // ignore a late close event from an earlier dialog
      const done = (v) => { if (settled) return; settled = true; dlg.removeEventListener('close', onClose); resolve(v || 'cancel'); };
      $('#dlg-confirm-actions').onclick = (e) => {
        const b = e.target.closest('button[value]'); if (!b) return;
        e.preventDefault(); done(b.value); dlg.close(b.value);
      };
      dlg.addEventListener('close', onClose);
      openDialog(dlg, { pauseTimer });
      const first = dlg.querySelector('.dialog-actions button'); if (first) first.focus();
    });
  }
  function bindDialogs() {
    $$('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
    $$('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d && d.id !== 'dlg-confirm') d.close(); })); // backdrop click
    $('#btn-top-info').addEventListener('click', () => openDialog($('#dlg-info')));
    $('#btn-top-credits').addEventListener('click', openCredits);
    $('#btn-top-audio').addEventListener('click', openSettings);
    $('#btn-top-mute').addEventListener('click', () => toggleMute());
  }

  function openCredits() {
    const imgs = DATA.MAIN.concat(DATA.TIEBREAKERS).filter((q) => q.imagePath);
    const rows = imgs.map((q) => `<tr><td>${esc(q.id)}</td><td>${esc(q.imageTitle)}</td><td>${esc(q.imageCreator)}</td><td>${esc(q.imageSource)}</td><td>${q.imageLicenceUrl ? `<a href="${esc(q.imageLicenceUrl)}" target="_blank" rel="noopener noreferrer">${esc(q.imageLicence)}</a>` : esc(q.imageLicence)}</td><td><a href="${esc(q.imageSourcePage)}" target="_blank" rel="noopener noreferrer">Source page</a></td><td>${esc(q.imageAttribution)}</td></tr>`).join('');
    $('#credits-body').innerHTML = `
      <h3>Map data</h3>
      <p><strong>Natural Earth</strong> — Admin 0 Countries, 1:50m, version 5.1.2. Public domain. “Made with Natural Earth. Free vector and raster map data @ naturalearthdata.com.” Boundaries follow Natural Earth’s de facto policy and may differ from other legal or political perspectives.</p>
      <h3>Software</h3>
      <p><strong>Leaflet 1.9.4</strong> — © Volodymyr Agafonkin and contributors, BSD 2-Clause licence. Stored locally in <code>assets/vendor/leaflet/</code>.</p>
      <h3>Audio</h3>
      <p>All sound effects, music stings, soundboard sounds and audio-clue impressions are original and synthesised in the browser with the Web Audio API. No recorded, sampled, voice, television or branded audio is used.</p>
      <h3>Clue images (${imgs.length})</h3>
      <p class="spoiler-note">Spoiler warning: image titles can reveal answers.</p>
      <details><summary>Show image credits</summary><div class="table-scroll"><table><thead><tr><th>Question</th><th>Asset title</th><th>Creator</th><th>Platform</th><th>Licence</th><th>Source</th><th>Required attribution</th></tr></thead><tbody>${rows}</tbody></table></div></details>
      <h3>Factual sources</h3>
      <p>Every answer screen lists the sources behind its explanation. The full factual-source register is in <code>SOURCES.md</code>; the asset register is in <code>ATTRIBUTION.md</code> and <code>asset-register.json</code>.</p>
      <p>No creator, community, culture, brand or person listed here endorses this game.</p>`;
    openDialog($('#dlg-credits'));
  }

  function openHighlights() {
    const list = [];
    if (game) {
      game.rounds.forEach((r) => list.push({ label: `Round ${r.no}`, q: r.q }));
      if (game.tb) game.tb.log.forEach((e, i) => list.push({ label: `Sudden Death ${i + 1}`, q: e.q }));
    }
    $('#highlights-body').innerHTML = list.length ? list.map(({ label, q }) => `<div class="highlight-item"><h3>${esc(label)}: ${esc(q.answerName)} — ${esc(q.correctCountry)}</h3><p>${esc(q.answerExplanation)}</p><p><strong>Why it matters:</strong> ${esc(q.culturalSignificance)}</p><p><strong>Memorable fact:</strong> ${esc(q.surprisingFact)}</p>${q.originNuance ? `<p><em>${esc(q.originNuance)}</em></p>` : ''}<p class="help">Sources: ${q.factualSources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a>`).join(' · ')}</p></div>`).join('') : '<p>Play some rounds to collect Cultural Highlights.</p>';
    openDialog($('#dlg-highlights'));
  }

  /* ---------- Sound & display settings ---------- */
  function openSettings() {
    syncSoundUI();
    openDialog($('#dlg-settings'), { pauseTimer: !ui.keepTimerInSettings });
  }
  function buildCustomCats() {
    const fs = $('#custom-cats');
    fs.insertAdjacentHTML('beforeend', Object.entries(Sound.CATS).map(([k, label]) => `<label class="toggle small"><input type="checkbox" data-cat="${k}"><span>${esc(label)}</span></label>`).join(''));
    fs.addEventListener('change', (e) => { const c = e.target.dataset.cat; if (c) { Sound.setCustom(c, e.target.checked); } });
  }
  function syncSoundUI() {
    const p = Sound.prefs;
    ['master', 'music', 'sfx'].forEach((k) => { $('#vol-' + k).value = p[k]; $('#vol-' + k + '-out').textContent = p[k] + '%'; });
    $('#set-mute').checked = p.muted; $('#set-lobby').checked = p.lobby; $('#set-mode').value = p.mode; $('#intro-sound-mode').value = p.mode;
    const sm = $(`#setup-form input[name="soundmode"][value="${p.mode}"]`); if (sm) sm.checked = true;
    $('#custom-cats').disabled = p.mode !== 'custom';
    $$('#custom-cats input[data-cat]').forEach((i) => { i.checked = !!p.custom[i.dataset.cat]; });
    $('#set-reduced').checked = ui.reducedMotion; $('#set-keep-timer').checked = ui.keepTimerInSettings;
    const muteLabel = p.muted ? 'Unmute' : 'Mute';
    const topMute = $('#btn-top-mute');
    topMute.setAttribute('aria-pressed', String(p.muted)); topMute.setAttribute('aria-label', p.muted ? 'Unmute sound' : 'Mute sound');
    topMute.querySelector('use').setAttribute('href', p.muted ? '#i-mute' : '#i-sound'); topMute.querySelector('.btn-label').textContent = muteLabel;
    [['#btn-intro-mute', p.muted ? 'Unmute sound' : 'Mute sound'], ['#btn-end-mute', muteLabel]].forEach(([s, l]) => { $(s).textContent = l; $(s).setAttribute('aria-pressed', String(p.muted)); });
    $('#sbd-mode').textContent = '· ' + { professional: 'Professional', fun: 'Fun', chaotic: 'Chaotic', custom: 'Custom' }[p.mode];
    buildBoard();
  }
  function toggleMute() {
    Sound.setMuted(!Sound.prefs.muted);
    if (!Sound.prefs.muted) { Sound.play('click'); if (MENU_SCREENS.includes(ui.screen)) Sound.lobbyStart(); }
    announce(Sound.prefs.muted ? 'Sound muted.' : 'Sound on.');
  }
  function bindSettings() {
    buildCustomCats();
    ['master', 'music', 'sfx'].forEach((k) => $('#vol-' + k).addEventListener('input', (e) => { Sound.setVolume(k, Number(e.target.value)); $('#vol-' + k + '-out').textContent = e.target.value + '%'; }));
    $('#vol-sfx').addEventListener('change', () => Sound.play('click'));
    $('#set-mute').addEventListener('change', (e) => { if (e.target.checked !== Sound.prefs.muted) toggleMute(); });
    $('#set-lobby').addEventListener('change', (e) => { Sound.setLobby(e.target.checked); if (e.target.checked && MENU_SCREENS.includes(ui.screen)) Sound.lobbyStart(); });
    $('#set-mode').addEventListener('change', (e) => { Sound.setMode(e.target.value); });
    $('#set-stop').addEventListener('click', () => { Sound.stopAll(); toast('All sounds stopped.'); });
    $('#set-reduced').addEventListener('change', (e) => setReducedMotion(e.target.checked));
    $('#set-keep-timer').addEventListener('change', (e) => { ui.keepTimerInSettings = e.target.checked; store.set('session', 'keepTimer', ui.keepTimerInSettings); });
    $('#set-close').addEventListener('click', () => $('#dlg-settings').close());
    Sound.onChange(() => syncSoundUI());
  }
  function setReducedMotion(on) {
    ui.reducedMotion = !!on; document.body.classList.toggle('reduced-motion', ui.reducedMotion);
    store.set('session', 'reducedMotion', ui.reducedMotion);
    if (on) stopConfetti();
  }

  /* =================================================================
   * 13. SOUNDBOARD
   * ================================================================= */
  const BOARD = [
    ['badumtss', 'Ba-dum-tss'], ['crickets', 'Crickets'], ['drumroll', 'Drum roll', true], ['cheer', 'Crowd cheer'],
    ['applause', 'Applause', true], ['airhorn', 'Air horn'], ['suspense', 'Suspense sting'], ['sadTrombone', 'Sad trombone'],
    ['gentleBuzzer', 'Gentle wrong buzzer'], ['recordScratch', 'Record scratch'], ['gasp', 'Crowd gasp'], ['ooh', '“Ooooh” (crowd)'],
    ['wow', '“Wow” (crowd)'], ['mindBlown', 'Mind blown'], ['micDrop', 'Mic drop'], ['awkward', 'Awkward silence'],
    ['victory', 'Victory flourish'], ['confettiPop', 'Confetti pop'], ['quack', 'Comical quack'], ['mystery', 'Mystery reveal'],
    ['chime', 'Chime', true], ['countdown', 'Countdown 3-2-1', true],
  ];
  const boardPrefs = Object.assign({ fav: [], hidden: [], shortcuts: false, x: null, y: null }, store.get('session', 'board', {}));
  const saveBoard = () => store.set('session', 'board', boardPrefs);
  let boardKeys = []; let boardEdit = false;

  function boardItems() {
    const pro = Sound.prefs.mode === 'professional';
    let items = BOARD.filter(([, , p]) => !pro || p);
    if (!pro) items = items.filter(([k]) => k !== 'chime' && k !== 'countdown').concat(BOARD.filter(([k]) => k === 'chime' || k === 'countdown'));
    items = items.slice().sort((a, b) => (boardPrefs.fav.includes(b[0]) ? 1 : 0) - (boardPrefs.fav.includes(a[0]) ? 1 : 0));
    return items;
  }
  function buildBoard() {
    const grid = $('#sbd-grid'); if (!grid) return;
    const items = boardItems().filter(([k]) => boardEdit || !boardPrefs.hidden.includes(k));
    boardKeys = items.filter(([k]) => !boardPrefs.hidden.includes(k)).map(([k]) => k).slice(0, 10);
    grid.innerHTML = items.map(([k, label]) => {
      const idx = boardKeys.indexOf(k); const sc = boardPrefs.shortcuts && idx >= 0 ? `<span class="kbd" aria-hidden="true">⇧${(idx + 1) % 10}</span>` : '';
      const fav = boardPrefs.fav.includes(k); const hid = boardPrefs.hidden.includes(k);
      const edit = boardEdit ? `<div class="sbd-edit-row"><button type="button" data-fav="${k}" aria-pressed="${fav}" aria-label="Favourite ${esc(label)}">★ Fav</button><button type="button" data-hide="${k}" aria-pressed="${hid}" aria-label="Hide ${esc(label)}">Hide</button></div>` : '';
      return `<div><button type="button" class="sbd-btn${fav ? ' fav' : ''}${hid ? ' is-hidden' : ''}" data-snd="${k}" aria-keyshortcuts="${sc ? 'Shift+' + ((idx + 1) % 10) : ''}">${fav ? '★ ' : ''}${esc(label)}${sc}</button>${edit}</div>`;
    }).join('');
  }
  function playBoard(k) {
    if (Sound.prefs.muted) { toast('Sound is muted — unmute to use the soundboard.'); return; }
    const h = Sound.play(k, { board: true, force: true });
    const btn = $(`#sbd-grid [data-snd="${k}"]`);
    $$('#sbd-grid .sbd-btn.playing').forEach((b) => b.classList.remove('playing'));
    if (h && btn) { btn.classList.add('playing'); const iv = window.setInterval(() => { if (!Sound.isBoardPlaying(h)) { btn.classList.remove('playing'); window.clearInterval(iv); } }, 200); }
  }
  function toggleBoard(force) {
    const b = $('#soundboard'); const show = force != null ? force : b.hidden;
    b.hidden = !show; $('#btn-top-soundboard').setAttribute('aria-expanded', String(show));
    if (show) { buildBoard(); placeBoard(); $('#sbd-close').focus(); }
  }
  function placeBoard() {
    const b = $('#soundboard');
    if (boardPrefs.x == null) { b.style.left = ''; b.style.top = ''; b.style.right = '16px'; b.style.bottom = '16px'; return; }
    const r = b.getBoundingClientRect();
    b.style.right = 'auto'; b.style.bottom = 'auto';
    b.style.left = clamp(boardPrefs.x, 0, window.innerWidth - Math.min(r.width, window.innerWidth)) + 'px';
    b.style.top = clamp(boardPrefs.y, 56, window.innerHeight - 50) + 'px';
  }
  function bindSoundboard() {
    $('#btn-top-soundboard').addEventListener('click', () => toggleBoard());
    $('#sbd-close').addEventListener('click', () => { toggleBoard(false); $('#btn-top-soundboard').focus(); });
    $('#sbd-collapse').addEventListener('click', (e) => { const body = $('#sbd-body'); body.hidden = !body.hidden; e.currentTarget.setAttribute('aria-expanded', String(!body.hidden)); e.currentTarget.textContent = body.hidden ? 'Expand' : 'Collapse'; });
    $('#sbd-stop').addEventListener('click', () => { Sound.stopAll(); $$('#sbd-grid .playing').forEach((b) => b.classList.remove('playing')); toast('All sounds stopped.'); });
    $('#sbd-edit').addEventListener('change', (e) => { boardEdit = e.target.checked; buildBoard(); });
    $('#sbd-shortcuts').checked = boardPrefs.shortcuts;
    $('#sbd-shortcuts').addEventListener('change', (e) => { boardPrefs.shortcuts = e.target.checked; saveBoard(); buildBoard(); });
    $('#sbd-grid').addEventListener('click', (e) => {
      const f = e.target.closest('[data-fav]'); const hd = e.target.closest('[data-hide]'); const s = e.target.closest('[data-snd]');
      if (f) { const k = f.dataset.fav; boardPrefs.fav = boardPrefs.fav.includes(k) ? boardPrefs.fav.filter((x) => x !== k) : boardPrefs.fav.concat(k); saveBoard(); buildBoard(); return; }
      if (hd) { const k = hd.dataset.hide; boardPrefs.hidden = boardPrefs.hidden.includes(k) ? boardPrefs.hidden.filter((x) => x !== k) : boardPrefs.hidden.concat(k); saveBoard(); buildBoard(); return; }
      if (s) playBoard(s.dataset.snd);
    });
    // Dragging (mouse + touch via pointer events)
    const head = $('#sbd-head'); let drag = null;
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const r = $('#soundboard').getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top }; head.setPointerCapture(e.pointerId);
    });
    head.addEventListener('pointermove', (e) => { if (!drag) return; boardPrefs.x = e.clientX - drag.dx; boardPrefs.y = e.clientY - drag.dy; placeBoard(); });
    const end = () => { if (drag) { drag = null; saveBoard(); } };
    head.addEventListener('pointerup', end); head.addEventListener('pointercancel', end);
    window.addEventListener('resize', () => { if (!$('#soundboard').hidden) placeBoard(); });
  }

  /* =================================================================
   * 14. CONFETTI, KEYBOARD SHORTCUTS & INITIALISATION
   * ================================================================= */
  let confettiRaf = null;
  function stopConfetti() { if (confettiRaf) cancelAnimationFrame(confettiRaf); confettiRaf = null; const c = $('#confetti'); c.getContext('2d').clearRect(0, 0, c.width, c.height); }
  function confetti() {
    if (ui.reducedMotion) return;
    stopConfetti();
    const c = $('#confetti'); const ctx = c.getContext('2d');
    c.width = window.innerWidth; c.height = window.innerHeight;
    const colours = ['#ffc23d', '#e4572e', '#0b8a8f', '#2f80ed', '#7b2d8b', '#1f9d55', '#ffffff'];
    const parts = Array.from({ length: 220 }, () => ({ x: rand(0, c.width), y: rand(-c.height, -10), vx: rand(-1.5, 1.5), vy: rand(2, 5.5), s: rand(6, 12), r: rand(0, Math.PI), vr: rand(-0.2, 0.2), col: pick(colours), shape: Math.random() < 0.3 ? 'c' : 'r' }));
    const start = performance.now();
    const frame = (now) => {
      const el = now - start; ctx.clearRect(0, 0, c.width, c.height);
      ctx.globalAlpha = el > 4200 ? Math.max(0, 1 - (el - 4200) / 800) : 1;
      parts.forEach((p) => {
        p.x += p.vx + Math.sin((now / 400) + p.s) * 0.6; p.y += p.vy; p.r += p.vr;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.col;
        if (p.shape === 'c') { ctx.beginPath(); ctx.arc(0, 0, p.s / 2.5, 0, Math.PI * 2); ctx.fill(); } else ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
        ctx.restore();
      });
      if (el < 5000) confettiRaf = requestAnimationFrame(frame); else stopConfetti();
    };
    confettiRaf = requestAnimationFrame(frame);
  }

  function bindKeyboard() {
    document.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (['input', 'textarea', 'select'].includes(tag) || e.target.isContentEditable) return;
      if (document.querySelector('dialog[open]')) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // Soundboard: Shift + digit (never clashes with Leaflet arrow / +/- keys)
      if (e.shiftKey && /^Digit\d$/.test(e.code) && boardPrefs.shortcuts && !$('#soundboard').hidden) {
        const d = Number(e.code.slice(5)); const k = boardKeys[(d + 9) % 10];
        if (k) { e.preventDefault(); playBoard(k); }
        return;
      }
      if (e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (key === 'm') { e.preventDefault(); toggleMute(); return; }
      if (ui.screen !== 'game' || !game || !game.current) return;
      const r = game.current;
      if (key === 'l' && r.phase === 'turn') { e.preventDefault(); lockIn(); }
      if (key === 'p' && r.phase === 'turn') { e.preventDefault(); if (Timer.isPaused('manual')) Timer.resume('manual'); else Timer.pause('manual'); announce(Timer.isPaused('manual') ? 'Timer paused.' : 'Timer resumed.'); }
    });
  }

  function init() {
    // Restore session display preferences
    const prm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setReducedMotion(store.get('session', 'reducedMotion', prm));
    ui.keepTimerInSettings = !!store.get('session', 'keepTimer', false);

    bindIntro(); bindSetup(); bindRules(); bindTeams(); bindStart(); bindGameControls(); bindTiebreak(); bindEnd();
    bindDialogs(); bindSettings(); bindSoundboard(); bindKeyboard();
    settingsToForm();
    syncSoundUI();
    setMode('local');

    // Generic Back buttons
    $$('[data-nav]').forEach((b) => b.addEventListener('click', () => { Sound.play('click'); if (b.dataset.nav === 'teams') prepareTeamsScreen(); goTo(b.dataset.nav); }));
    // Pause the turn timer when the tab is hidden; resume automatically when visible again
    document.addEventListener('visibilitychange', () => { if (document.hidden) Timer.pause('hidden'); else Timer.resume('hidden'); });
    window.addEventListener('resize', () => { if (ui.screen === 'game') MapView.invalidate(); });

    // Public helpers for the online (multi-device) module in online.js
    window.WITW_API = {
      DATA, Sound, Geo, esc, fmtKm, fmtClock, toast, announce, confirmDialog, openDialog, goTo, setMode,
      pickQuestion, pickTiebreaker, History, shuffle, pick, rand, clamp, confetti, stopConfetti,
      getSettings: () => settings, minutesSelected, TEAM_NAMES, CHAMPION_LINES, CAT_ICON, CONFIDENCE_RANK,
      SEA_TOLERANCE_KM, COAST_SNAP_KM, SOLO_NEAR_KM, TURN_SECONDS, ui, settingsToForm, isLocalGameActive: () => !!(game && !game.ended),
    };

    if (!DATA.MAIN.length) toast('Question bank failed to load — check that questions.js is present.', 'warn');
    if (!window.L) console.warn('Leaflet failed to load; the country list fallback will be used.');
    goTo('intro', { focus: false });
  }

  init();
})();
