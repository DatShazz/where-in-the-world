/* =====================================================================
 * WHERE IN THE WORLD? — Online play (multi-device, 2–6 teams)
 * ---------------------------------------------------------------------
 * Architecture: the HOST's browser is the referee. It owns the game
 * state (rounds, timer, scoring, leader selection, Sudden Death) and
 * publishes it to Firebase Realtime Database at rooms/<CODE>/state.
 * Players write only their own records:
 *   players/<uid>      name, team, online
 *   lead/<uid>         leader votes and requests (claim / fate / object / step down)
 *   suggest/<team>/<uid>  suggestion pins (visible to that team only)
 *   guesses/<team>     the official pin — writable only by that team's leader
 * Security rules (database.rules.json) enforce who may write what.
 *
 *  1. Setup & helpers     4. Host: lobby & leaders     7. Player
 *  2. Network             5. Host: rounds & scoring    8. Final results
 *  3. Map & clue views    6. Host: Sudden Death        9. Wiring
 * ===================================================================== */
(function () {
  'use strict';

  /* =================================================================
   * 1. SETUP & HELPERS
   * ================================================================= */
  const A = window.WITW_API;
  if (!A) return;
  const { DATA, Sound, Geo, esc, fmtKm, fmtClock, toast, announce, confirmDialog, openDialog, goTo } = A;
  const $ = (s, r = document) => r.querySelector(s);
  const CFG = window.WITW_FIREBASE_CONFIG;
  const TURN_MS = A.TURN_SECONDS * 1000;
  const READY_MS = 3000;
  const MAX_TEAMS = 6;
  const TEAM_STYLES = [
    { col: '#d1432b', soft: '#fde4dd', shape: 'circle', sym: '●' },
    { col: '#1f5fbf', soft: '#dde8fb', shape: 'diamond', sym: '◆' },
    { col: '#1d7f45', soft: '#dcf2e4', shape: 'square', sym: '■' },
    { col: '#7b2d8b', soft: '#f1e1f5', shape: 'triangle', sym: '▲' },
    { col: '#a85300', soft: '#fbe8d4', shape: 'hexagon', sym: '⬢' },
    { col: '#0f6f78', soft: '#d8f0f1', shape: 'pentagon', sym: '⬟' },
  ];
  const HOW_LABEL = { vote: 'chosen by unanimous vote', volunteer: 'volunteered', fate: 'chosen by fate', host: 'appointed by the host' };

  const qById = (id) => DATA.MAIN.find((q) => q.id === id) || DATA.TIEBREAKERS.find((q) => q.id === id) || null;
  const styleOf = (key) => TEAM_STYLES[Number(String(key).slice(1))] || TEAM_STYLES[0];
  const keysOf = (teams) => Object.keys(teams || {}).sort();
  const clean = (o) => JSON.parse(JSON.stringify(o)); // drops undefined, Infinity → null (Firebase rejects undefined)
  const initials = (n) => String(n || '?').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const baseUrl = () => location.origin + location.pathname;
  const membersOf = (players, key) => Object.keys(players || {}).filter((u) => players[u] && players[u].team === key);
  function badge(key, size = '') { const s = styleOf(key); return `<span class="tbadge shape-${s.shape} ${size}" style="--tc:${s.col}" aria-hidden="true"></span>`; }
  function randomCode() { const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; let c = ''; for (let i = 0; i < 4; i++) c += L[Math.floor(Math.random() * L.length)]; return c; }

  /* =================================================================
   * 2. NETWORK (Firebase)
   * ================================================================= */
  const Net = {
    db: null, auth: null, uid: null, offset: 0,
    async connect() {
      if (this.db) return;
      if (!window.firebase || !CFG) throw new Error('Online play needs an internet connection — the online service could not load.');
      const app = firebase.apps.length ? firebase.app() : firebase.initializeApp(CFG);
      this.auth = app.auth(); this.db = app.database();
      try { await this.auth.setPersistence(firebase.auth.Auth.Persistence.SESSION); } catch (e) { /* default persistence is fine */ }
      let user = await new Promise((res) => { const off = this.auth.onAuthStateChanged((u) => { off(); res(u); }); });
      try { if (!user) user = (await this.auth.signInAnonymously()).user; } catch (e) {
        this.db = null;
        throw new Error('Could not reach the online game service. Check your internet connection, or ask IT whether googleapis.com and firebasedatabase.app are allowed.');
      }
      this.uid = user.uid;
      this.db.ref('.info/serverTimeOffset').on('value', (s) => { this.offset = s.val() || 0; });
    },
    now() { return Date.now() + this.offset; },
    ref(code, path) { return this.db.ref('rooms/' + code + (path ? '/' + path : '')); },
    ts() { return firebase.database.ServerValue.TIMESTAMP; },
  };
  const subs = []; // active listeners for clean detaching
  function listen(ref, fn) { ref.on('value', fn, (err) => toast('Connection problem: ' + err.message, 'warn')); subs.push(() => ref.off('value', fn)); }
  function detachAll() { while (subs.length) subs.pop()(); }

  /* =================================================================
   * 3. MAP & CLUE VIEWS (shared by host and players)
   * ================================================================= */
  function makeMap(el) {
    if (!window.L || !Geo.ok) { el.innerHTML = '<div class="map-error">The map could not load. Use the country list instead.</div>'; return null; }
    const BASE = { color: '#8c98ad', weight: 0.6, fillColor: '#f4ecd8', fillOpacity: 1 };
    const HI = { color: '#a86b00', weight: 2.2, fillColor: '#ffd25e', fillOpacity: 1 };
    const m = L.map(el, { preferCanvas: true, zoomSnap: 0.25, zoomDelta: 0.5, minZoom: 1, maxZoom: 9, worldCopyJump: false, maxBounds: [[-89, -250], [89, 250]], maxBoundsViscosity: 0.7 });
    m.attributionControl.setPrefix(false);
    m.attributionControl.addAttribution('Boundaries: Natural Earth 1:50m v5.1.2 · Leaflet');
    const byCode = new Map(); let lit = [];
    L.geoJSON(window.WORLD_GEOJSON, { style: () => BASE, interactive: false, onEachFeature: (f, l) => { const c = f.properties.code; if (!byCode.has(c)) byCode.set(c, []); byCode.get(c).push(l); } }).addTo(m);
    const lines = L.layerGroup().addTo(m); const pins = L.layerGroup().addTo(m);
    let clickFn = null;
    m.on('click', (e) => { if (clickFn) { const ll = e.latlng.wrap(); clickFn(ll.lat, ll.lng); } });
    const fitWorld = () => m.fitBounds([[-56, -168], [76, 190]], { animate: false });
    fitWorld();
    function icon(p) {
      if (p.kind === 'answer') return L.divIcon({ className: 'pin pin-ans', html: '<div class="pin-shape"><svg aria-hidden="true"><use href="#i-star"/></svg></div><div class="pin-label">Answer</div>', iconSize: [0, 0] });
      if (p.kind === 'suggest') return L.divIcon({ className: 'pin opin osug', html: `<div class="pin-shape" style="--tc:${styleOf(p.team).col}"><span>${esc(initials(p.label))}</span></div><div class="pin-label" style="--tc:${styleOf(p.team).col}">${esc(p.label)}</div>`, iconSize: [0, 0] });
      const s = styleOf(p.team);
      return L.divIcon({ className: 'pin opin' + (p.animate ? ' drop' : ''), html: `<div class="pin-shape shape-${s.shape}" style="--tc:${s.col}"><span>${Number(String(p.team).slice(1)) + 1}</span></div><div class="pin-label" style="--tc:${s.col}">${esc(p.label)}</div>`, iconSize: [0, 0] });
    }
    return {
      m,
      onClick(fn) { clickFn = fn; },
      reset: fitWorld,
      invalidate() { setTimeout(() => m.invalidateSize(), 60); },
      centre() { const c = m.getCenter().wrap(); return [c.lat, c.lng]; },
      clear() { lit.forEach((l) => l.setStyle(BASE)); lit = []; lines.clearLayers(); pins.clearLayers(); },
      setPins(list) {
        pins.clearLayers();
        list.forEach((p) => L.marker([p.lat, p.lng], { icon: icon(p), keyboard: false, title: p.title || p.label, alt: p.title || p.label, zIndexOffset: p.kind === 'answer' ? 1000 : p.kind === 'suggest' ? -100 : 0 }).addTo(pins));
      },
      reveal({ codes, answer, items, showDist }) {
        this.clear();
        codes.forEach((c) => (byCode.get(c) || []).forEach((l) => { l.setStyle(HI); lit.push(l); }));
        const b = [[answer.lat, answer.lng]];
        items.forEach((it) => {
          const line = L.polyline(Geo.greatCircle([it.lat, it.lng], [answer.lat, answer.lng]), { color: styleOf(it.team).col, weight: 3.5, opacity: 0.95, dashArray: Number(String(it.team).slice(1)) % 2 ? '10 7' : null }).addTo(lines);
          if (showDist) line.bindTooltip(fmtKm(it.km), { permanent: true, direction: 'center', className: 'dist-tip' });
          b.push([it.lat, it.lng]);
        });
        this.setPins(items.map((it) => ({ team: it.team, lat: it.lat, lng: it.lng, label: it.label })).concat([{ kind: 'answer', lat: answer.lat, lng: answer.lng, label: 'Answer' }]));
        if (b.length > 1) m.fitBounds(b, { padding: [60, 60], maxZoom: 5 }); else m.setView([answer.lat, answer.lng], 4);
      },
    };
  }

  /** Renders a clue (chips, title, media, text, hints) into `el`. */
  function renderClue(el, q, { mystery, hints, tb, settings }) {
    const icon = mystery ? 'c-mystery' : A.CAT_ICON[q.category];
    el.innerHTML = `
      <div class="chip-row">
        <span class="chip chip-cat"><svg aria-hidden="true"><use href="#${icon}"/></svg>${esc(mystery ? 'Mystery category' : q.category)}</span>
        <span class="chip chip-diff${q.difficulty === 'Expert' ? ' expert' : ''}">${tb ? 'Expert · Sudden Death' : esc(q.difficulty)}</span>
        <span class="chip chip-type">${{ text: 'Text clue', image: 'Picture clue', audio: 'Sound clue' }[q.clueType] || 'Clue'}</span>
      </div>
      <h3 class="clue-title">${esc(q.title)}</h3>
      <div class="clue-media"></div>
      <p class="clue-text">${esc(q.clueText)}</p>
      ${hints > 0 ? `<ol class="hint-list">${q.hints.slice(0, hints).map((h) => `<li>${esc(h)}</li>`).join('')}</ol>` : ''}`;
    const media = el.querySelector('.clue-media');
    const card = (label, text) => { const d = document.createElement('div'); d.className = 'fallback-card'; d.innerHTML = `<svg aria-hidden="true"><use href="#${icon}"/></svg><p><span class="fc-label">${esc(label)}</span>${esc(text)}</p>`; return d; };
    if (q.clueType === 'image') {
      if (settings.images && q.imagePath) {
        const img = document.createElement('img'); img.src = q.imagePath; img.alt = q.imageAltText || 'Clue image'; img.title = 'Click to enlarge';
        img.addEventListener('click', () => img.classList.toggle('zoomed'));
        img.addEventListener('error', () => img.replaceWith(card('Picture this (image unavailable)', q.imageAltText)), { once: true });
        media.appendChild(img);
      } else media.appendChild(card('Picture this', q.imageAltText || 'Imagine the object described in the clue.'));
    }
    if (q.audioDescription || q.audioSynth || q.audioPath) {
      const box = document.createElement('div'); box.className = 'audio-clue';
      box.innerHTML = `<span class="ac-label">Sound clue — description</span><p>${esc(q.audioDescription || 'Listen carefully.')}</p>`;
      if (settings.audioClues && (q.audioSynth || q.audioPath)) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-secondary btn-small'; b.textContent = '▶ Play sound clue';
        b.addEventListener('click', () => Sound.playClue(q, (msg) => toast(msg)));
        const n = document.createElement('p'); n.className = 'help'; n.textContent = 'Synthesised impression created for this game — not a field recording.';
        box.append(b, n);
      }
      media.appendChild(box);
    }
  }

  function spotlightHTML(q, settings) {
    const src = `<p class="sources"><strong>Sources:</strong> ${q.factualSources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a>`).join(' · ')}</p>`;
    return settings.spotlights
      ? `<div class="spotlight"><h4>Cultural Spotlight</h4><dl><dt>What it is</dt><dd>${esc(q.answerExplanation)}</dd><dt>Why it matters</dt><dd>${esc(q.culturalSignificance)}</dd><dt>Memorable fact</dt><dd>${esc(q.surprisingFact)}</dd>${q.originNuance ? `<dt>Origins &amp; nuance</dt><dd>${esc(q.originNuance)}</dd>` : ''}</dl>${src}</div>`
      : `<div class="spotlight"><p>${esc(q.answerExplanation)}</p>${src}</div>`;
  }

  /** Result cards for every team in a reveal, best first. */
  function resultsHTML(st, highlightKey) {
    const res = st.reveal.results || {};
    const keys = Object.keys(res).sort((a, b) => (res[b].points || 0) - (res[a].points || 0) || (res[a].km ?? 1e9) - (res[b].km ?? 1e9));
    return keys.map((k) => {
      const r = res[k]; const s = styleOf(k); const t = (st.teams || {})[k] || { name: k };
      const where = r.none ? 'No pin placed' : `Pin: ${esc(r.name)}${st.s.distance ? ` · ${fmtKm(r.km)} from the answer` : ''}${r.auto ? ' · auto-locked' : ''}`;
      const conf = r.conf && !st.reveal.tb ? ` · Confidence: ${esc(r.conf)}` : '';
      const pts = st.reveal.tb ? '' : `<span class="rc-points">+${r.points || 0}</span>`;
      return `<div class="result-card${k === highlightKey ? ' mine' : ''}" style="border-left-color:${s.col}"><div class="rc-head"><span class="rc-name">${badge(k)} ${esc(t.name)}</span>${pts}</div><p class="rc-detail">${where}${conf}</p><p class="rc-reason">${esc(r.reason || '')}</p></div>`;
    }).join('');
  }
  function revealMapItems(st) {
    const res = st.reveal.results || {};
    return Object.keys(res).filter((k) => !res[k].none).map((k) => ({ team: k, lat: res[k].lat, lng: res[k].lng, km: res[k].km, label: ((st.teams || {})[k] || {}).name || k }));
  }
  function populateCountryList() {
    const dl = $('#country-list');
    if (dl && !dl.children.length) dl.innerHTML = Geo.index.slice().sort((a, b) => a.name.localeCompare(b.name)).map((c) => `<option value="${esc(c.name)}"></option>`).join('');
  }
  function locate(lat, lng, forced) {
    let c = forced || Geo.countryAt(lat, lng); let snapped = false;
    if (!c) { const n = Geo.nearestCountry(lat, lng, A.COAST_SNAP_KM); if (n) { c = n.country; snapped = true; } }
    return { lat: +lat.toFixed(4), lng: +lng.toFixed(4), code: c ? c.code : null, name: c ? c.name + (snapped ? ' (coast)' : '') : 'Open water' };
  }

  /* =================================================================
   * 4. HOST — room, lobby and team leaders
   * ================================================================= */
  let H = null;          // host state (authoritative)
  let hostMap = null;
  let hostTick = null;
  let revealTimer = null;

  function freshHost(code, teamsCount) {
    const set = A.getSettings();
    const names = A.shuffle(A.TEAM_NAMES);
    const teams = {};
    for (let i = 0; i < teamsCount; i++) teams['t' + i] = { name: names[i], leader: null, how: '', since: 0, cleared: 0, score: 0 };
    return {
      code, phase: 'lobby',
      s: {
        teamsCount, planned: set.rounds, minutes: A.minutesSelected(), spotlights: set.spotlights, confidence: set.confidence,
        distance: set.distance, hints: set.hints, images: set.images, audioClues: set.audioClues, mystery: set.category === 'mystery',
        tiebreaker: set.tiebreaker, warnings: set.warnings,
      },
      teams, players: {}, lead: {}, guesses: {}, round: null, reveal: null, history: [], sequence: [], tbUsed: [],
      sd: null, sdNext: null, final: null, sessionEndsAt: null, finishAfter: false, timeUpHandled: false, warned: {}, lastWhole: null, renderedKey: '',
    };
  }
  function serialize() {
    return clean({
      phase: H.phase, s: H.s, teams: H.teams, round: H.round, reveal: H.reveal, history: H.history, sequence: H.sequence,
      tbUsed: H.tbUsed, sd: H.sd, final: H.final, sessionEndsAt: H.sessionEndsAt, finishAfter: H.finishAfter, updated: Net.now(),
    });
  }
  function push() { if (!H) return Promise.resolve(); return Net.ref(H.code, 'state').set(serialize()).catch((e) => toast('Could not update the game: ' + e.message, 'warn')); }
  function computeScores() {
    keysOf(H.teams).forEach((k) => { H.teams[k].score = H.history.reduce((a, h) => a + ((h.points || {})[k] || 0), 0); });
  }

  async function createRoom() {
    const btn = $('#btn-rules-continue'); btn.disabled = true; btn.textContent = 'Creating room…';
    try {
      await Net.connect();
      const teamsCount = A.clamp(parseInt($('#online-teams').value, 10) || 3, 2, MAX_TEAMS);
      let code = null;
      for (let i = 0; i < 10 && !code; i++) {
        const c = randomCode();
        const res = await Net.ref(c, 'meta').transaction((cur) => (cur ? undefined : { host: Net.uid, created: Date.now() }));
        if (res.committed && res.snapshot.val() && res.snapshot.val().host === Net.uid) code = c;
      }
      if (!code) throw new Error('Could not create a room — please try again.');
      H = freshHost(code, teamsCount);
      await push();
      startHosting();
      Sound.play('confirm', { major: true });
      goTo('host-lobby');
      renderHostLobby();
    } catch (e) {
      toast(e.message, 'warn');
    } finally { btn.disabled = false; btn.textContent = 'Continue'; }
  }

  /** Re-opens a room this browser tab was hosting (e.g. after a page reload). */
  async function resumeHosting(code) {
    try {
      await Net.connect();
      const meta = (await Net.ref(code, 'meta').once('value')).val();
      const st = (await Net.ref(code, 'state').once('value')).val();
      if (!meta || meta.host !== Net.uid || !st) { sessionStorage.removeItem('witw.hostRoom'); toast('That room has closed.'); return; }
      H = freshHost(code, st.s.teamsCount);
      Object.assign(H, { phase: st.phase, s: st.s, teams: st.teams || {}, round: st.round || null, reveal: st.reveal || null, history: st.history || [], sequence: st.sequence || [], tbUsed: st.tbUsed || [], sd: st.sd || null, final: st.final || null, sessionEndsAt: st.sessionEndsAt || null, finishAfter: !!st.finishAfter });
      keysOf(H.teams).forEach((k) => { H.teams[k] = Object.assign({ leader: null, how: '', since: 0, cleared: 0, score: 0 }, H.teams[k]); });
      if (H.round && H.round.revealed === undefined) H.round.revealed = H.phase !== 'question';
      startHosting();
      if (H.phase === 'lobby') { goTo('host-lobby'); renderHostLobby(); }
      else if (H.phase === 'end') { goTo('online-end'); renderEnd(serialize(), true); }
      else if (H.phase === 'sdIntro') showSdIntro();
      else { goTo('host-game'); ensureHostMap(); renderHostGame(true); }
      toast(`Resumed hosting room ${code}.`);
    } catch (e) { toast(e.message, 'warn'); }
  }

  function startHosting() {
    sessionStorage.setItem('witw.hostRoom', H.code);
    detachAll();
    listen(Net.ref(H.code, 'players'), (s) => { H.players = s.val() || {}; onHostData(); });
    listen(Net.ref(H.code, 'lead'), (s) => { H.lead = s.val() || {}; onHostData(); });
    listen(Net.ref(H.code, 'guesses'), (s) => { H.guesses = s.val() || {}; onHostGuesses(); });
    if (!hostTick) hostTick = setInterval(onHostTick, 250);
  }

  function onHostData() {
    if (!H) return;
    if (resolveLeaders()) push();
    if (H.phase === 'lobby') renderHostLobby();
    else if (H.phase === 'question' || H.phase === 'reveal') { renderHostScorebar(); }
    if ($('#dlg-teams').open) renderTeamsDialog();
  }

  /**
   * Leader rules, applied by the host whenever players act:
   *  • fate     – any member asks the game to choose: random member becomes leader
   *  • volunteer – first member to claim becomes leader, unless a teammate then objects
   *  • vote     – every member votes for the same teammate (unanimous)
   *  • a leader who leaves the team or steps down is cleared
   * Returns true if anything changed.
   */
  function resolveLeaders() {
    let changed = false;
    keysOf(H.teams).forEach((k) => {
      const t = H.teams[k]; const mem = membersOf(H.players, k);
      const rec = (u) => { const r = H.lead[u]; return r && r.team === k ? r : null; };
      const fresh = (r) => r && r.ts > Math.max(t.cleared || 0, t.since || 0);
      if (t.leader && !mem.includes(t.leader)) { clearLeader(k, 'left the team'); changed = true; }
      if (t.leader) {
        const r = rec(t.leader);
        if (r && r.req === 'stepdown' && fresh(r)) { clearLeader(k, 'stepped down'); changed = true; }
      }
      if (t.leader && t.how === 'volunteer') {
        const objector = mem.find((u) => u !== t.leader && fresh(rec(u)) && rec(u).req === 'object');
        if (objector) { clearLeader(k, `${(H.players[objector] || {}).name || 'A teammate'} objected`); changed = true; }
      }
      if (t.leader || !mem.length) return;
      const fateReq = mem.find((u) => fresh(rec(u)) && rec(u).req === 'fate');
      if (fateReq) { setLeader(k, A.pick(mem), 'fate'); changed = true; return; }
      const claims = mem.filter((u) => fresh(rec(u)) && rec(u).req === 'claim').sort((a, b) => rec(a).ts - rec(b).ts);
      if (claims.length) { setLeader(k, claims[0], 'volunteer'); changed = true; return; }
      const votes = mem.map((u) => (rec(u) && rec(u).vote) || null);
      if (votes.every((v) => v && v === votes[0]) && mem.includes(votes[0])) { setLeader(k, votes[0], 'vote'); changed = true; }
    });
    return changed;
  }
  function setLeader(k, uid, how) {
    const t = H.teams[k]; t.leader = uid; t.how = how; t.since = Net.now();
    const n = (H.players[uid] || {}).name || 'Someone';
    toast(`${n} leads ${t.name} (${HOW_LABEL[how]}).`);
    Sound.play('confirm');
  }
  function clearLeader(k, why) {
    const t = H.teams[k]; const n = (H.players[t.leader] || {}).name || 'The leader';
    t.leader = null; t.how = ''; t.cleared = Net.now();
    if (why) toast(`${t.name}: ${why === 'left the team' ? n + ' left the team' : why === 'stepped down' ? n + ' stepped down' : why} — the team needs a new leader.`);
  }

  function renderHostLobby() {
    const box = $('#host-lobby'); if (!box || !H) return;
    const link = `${baseUrl()}?join=${H.code}`;
    const unassigned = Object.keys(H.players).filter((u) => !H.players[u].team || !H.teams[H.players[u].team]);
    const teamOpts = (sel) => `<option value="">Move to…</option>${keysOf(H.teams).map((k) => `<option value="${k}"${sel === k ? ' disabled' : ''}>${esc(H.teams[k].name)}</option>`).join('')}<option value="__none">No team</option>`;
    const member = (u, k) => {
      const p = H.players[u]; const lead = k && H.teams[k].leader === u;
      return `<li class="member"><span class="dot ${p.online ? 'on' : 'off'}" title="${p.online ? 'Online' : 'Offline'}"></span><span class="mname">${lead ? '⭐ ' : ''}${esc(p.name)}</span>
        <span class="mactions">${k && !lead ? `<button type="button" class="btn btn-ghost btn-tiny" data-act="lead" data-uid="${u}" data-team="${k}">Make leader</button>` : ''}
        <label class="visually-hidden" for="mv-${u}">Move ${esc(p.name)}</label><select id="mv-${u}" data-act="move" data-uid="${u}">${teamOpts(k)}</select>
        <button type="button" class="btn btn-ghost btn-tiny" data-act="kick" data-uid="${u}" aria-label="Remove ${esc(p.name)}">Remove</button></span></li>`;
    };
    const ready = []; const waiting = [];
    keysOf(H.teams).forEach((k) => { const n = membersOf(H.players, k).length; if (n && H.teams[k].leader) ready.push(k); else if (n) waiting.push(k); });
    box.innerHTML = `
      <p class="eyebrow">Online lobby</p>
      <h2 id="hl-title" class="screen-title">Room <span class="room-code">${H.code}</span></h2>
      <div class="join-box">
        <p>Players open <strong>${esc(baseUrl())}</strong>, choose <strong>Join a game</strong> and enter code <strong>${H.code}</strong>. Or share this link:</p>
        <div class="input-row"><label class="visually-hidden" for="hl-link">Join link</label><input type="text" id="hl-link" readonly value="${esc(link)}"><button type="button" class="btn btn-secondary btn-small" data-act="copy">Copy link</button></div>
      </div>
      <div class="lobby-teams">
        ${keysOf(H.teams).map((k) => {
          const t = H.teams[k]; const mem = membersOf(H.players, k); const s = styleOf(k);
          const lname = t.leader ? (H.players[t.leader] || {}).name : null;
          return `<section class="lteam" style="--tc:${s.col};--tsoft:${s.soft}" aria-label="${esc(t.name)}">
            <header>${badge(k, 'lg')}<h3>${esc(t.name)}</h3><button type="button" class="btn btn-ghost btn-tiny" data-act="rename" data-team="${k}">Rename</button></header>
            <p class="lleader">${lname ? `⭐ Leader: <strong>${esc(lname)}</strong> <span class="how">(${HOW_LABEL[t.how] || ''})</span>` : mem.length ? 'Choosing a leader…' : 'No players yet'}</p>
            <ul class="mlist">${mem.map((u) => member(u, k)).join('') || '<li class="empty">Empty</li>'}</ul>
          </section>`;
        }).join('')}
        <section class="lteam lteam-none" aria-label="Players without a team">
          <header><h3>Not in a team yet (${unassigned.length})</h3></header>
          <ul class="mlist">${unassigned.map((u) => member(u, null)).join('') || '<li class="empty">Everyone has a team</li>'}</ul>
        </section>
      </div>
      <p class="lobby-status" role="status">${Object.keys(H.players).length} player${Object.keys(H.players).length === 1 ? '' : 's'} joined · ${ready.length} team${ready.length === 1 ? '' : 's'} ready${waiting.length ? ` · waiting for a leader in ${waiting.map((k) => esc(H.teams[k].name)).join(', ')}` : ''}</p>
      <div class="lobby-actions">
        <button type="button" class="btn btn-secondary" data-act="shuffle">Shuffle players into teams</button>
        <button type="button" class="btn btn-secondary" data-act="fateall">Let fate pick missing leaders</button>
        <button type="button" class="btn btn-ghost tool-danger" data-act="close">Close room</button>
        <button type="button" class="btn btn-primary btn-big" data-act="start">Start Game</button>
      </div>`;
  }

  async function hostLobbyAction(e) {
    const el = e.target.closest('[data-act]'); if (!el || !H) return;
    const act = el.dataset.act; const uid = el.dataset.uid; const k = el.dataset.team;
    if (e.type === 'change' && act !== 'move') return;
    if (e.type === 'click' && act === 'move') return;
    if (act === 'copy') {
      const inp = $('#hl-link'); inp.select();
      try { await navigator.clipboard.writeText(inp.value); toast('Join link copied.'); } catch (err) { document.execCommand && document.execCommand('copy'); toast('Link selected — press Ctrl+C to copy.'); }
    } else if (act === 'rename') {
      const v = await confirmDialog({ title: 'Rename team', body: `<label for="rename-input">Team name</label><input type="text" id="rename-input" maxlength="30" value="${esc(H.teams[k].name)}" class="wide-input">`, buttons: [{ label: 'Save', value: 'save', cls: 'btn-primary' }, { label: 'Cancel', value: 'no', cls: 'btn-ghost' }], pauseTimer: false });
      const name = ($('#rename-input') || {}).value;
      if (v === 'save' && name && name.trim()) { H.teams[k].name = name.trim().replace(/\s+/g, ' ').slice(0, 30); await push(); renderHostLobby(); }
    } else if (act === 'lead') { setLeader(k, uid, 'host'); await push(); renderAny(); }
    else if (act === 'move') {
      const to = el.value; if (!to) return;
      await Net.ref(H.code, 'players/' + uid + '/team').set(to === '__none' ? null : to);
    } else if (act === 'kick') {
      const v = await confirmDialog({ title: 'Remove player?', body: `<p>Remove ${esc((H.players[uid] || {}).name)} from this room? They can rejoin with the code.</p>`, buttons: [{ label: 'Remove', value: 'yes', cls: 'btn-primary' }, { label: 'Cancel', value: 'no', cls: 'btn-ghost' }], pauseTimer: false });
      if (v === 'yes') { await Net.ref(H.code, 'players/' + uid).remove(); await Net.ref(H.code, 'lead/' + uid).remove(); }
    } else if (act === 'shuffle') {
      const all = A.shuffle(Object.keys(H.players)); const ks = keysOf(H.teams);
      const upd = {}; all.forEach((u, i) => { upd[u + '/team'] = ks[i % ks.length]; });
      keysOf(H.teams).forEach((key) => { if (H.teams[key].leader) clearLeader(key); });
      await push();
      await Net.ref(H.code, 'players').update(upd);
      Sound.play('shuffle');
    } else if (act === 'fateall') {
      let n = 0;
      keysOf(H.teams).forEach((key) => { const mem = membersOf(H.players, key); if (!H.teams[key].leader && mem.length) { setLeader(key, A.pick(mem), 'fate'); n++; } });
      if (n) { await push(); renderAny(); } else toast('Every team with players already has a leader.');
    } else if (act === 'close') {
      const v = await confirmDialog({ title: 'Close this room?', body: '<p>Everyone will be disconnected and the room deleted.</p>', buttons: [{ label: 'Close Room', value: 'yes', cls: 'btn-primary' }, { label: 'Cancel', value: 'no', cls: 'btn-ghost' }], pauseTimer: false });
      if (v === 'yes') closeRoom();
    } else if (act === 'start') startGameFromLobby();
  }
  function renderAny() {
    if (!H) return;
    if (H.phase === 'lobby') renderHostLobby(); else renderHostScorebar();
    if ($('#dlg-teams').open) renderTeamsDialog();
  }

  async function startGameFromLobby() {
    const active = keysOf(H.teams).filter((k) => membersOf(H.players, k).length);
    if (active.length < 2) { toast('At least two teams need players before you can start.', 'warn'); return; }
    const noLeader = active.filter((k) => !H.teams[k].leader);
    if (noLeader.length) { toast(`Still waiting for a leader in: ${noLeader.map((k) => H.teams[k].name).join(', ')}. You can use “Let fate pick missing leaders”.`, 'warn'); return; }
    const loose = Object.keys(H.players).filter((u) => !H.players[u].team || !H.teams[H.players[u].team]).length;
    if (loose) {
      const v = await confirmDialog({ title: 'Some players have no team', body: `<p>${loose} player${loose === 1 ? ' has' : 's have'} not joined a team and will only be able to watch. Start anyway?</p>`, buttons: [{ label: 'Start Anyway', value: 'yes', cls: 'btn-primary' }, { label: 'Go Back', value: 'no', cls: 'btn-ghost' }], pauseTimer: false });
      if (v !== 'yes') return;
    }
    keysOf(H.teams).forEach((k) => { if (!active.includes(k)) delete H.teams[k]; });
    startGame();
  }

  function startGame() {
    H.history = []; H.sd = null; H.sdNext = null; H.final = null; H.finishAfter = false; H.timeUpHandled = false; H.warned = {};
    computeScores();
    H.sessionEndsAt = Net.now() + H.s.minutes * 60000;
    [300, 120, 60].forEach((th) => { if (H.s.minutes * 60 <= th + 30) H.warned[th] = true; });
    goTo('host-game');
    ensureHostMap();
    Sound.play('flourish', { major: true });
    nextRound(1);
  }

  function closeRoom() {
    const code = H && H.code;
    detachAll();
    if (hostTick) { clearInterval(hostTick); hostTick = null; }
    H = null; sessionStorage.removeItem('witw.hostRoom');
    if (code) Net.ref(code).remove().catch(() => {});
    A.setMode('local');
    goTo('intro');
    toast('Room closed.');
  }

  /* =================================================================
   * 5. HOST — rounds, timer and scoring
   * ================================================================= */
  function ensureHostMap() {
    if (!hostMap) { hostMap = makeMap($('#host-map')); }
    if (hostMap) hostMap.invalidate();
  }

  function nextRound(no) {
    const q = A.pickQuestion({ usedIds: new Set(H.sequence), sequence: H.sequence });
    if (!q) { toast('No unused questions remain for these settings — showing results.'); finish(false); return; }
    H.sequence.push(q.id);
    beginQuestion(q, { no, tb: false, eligible: keysOf(H.teams) });
  }

  function beginQuestion(q, { no, tb, eligible }) {
    clearTimeout(revealTimer);
    H.guesses = {};
    Net.ref(H.code, 'guesses').remove(); Net.ref(H.code, 'suggest').remove();
    const t = Net.now();
    H.round = { no, qid: q.id, tb, eligible, startsAt: t + READY_MS, endsAt: t + READY_MS + TURN_MS, pausedLeft: null, hints: 0, revealed: false };
    H.reveal = null; H.phase = 'question'; H.lastWhole = null;
    push();
    if (!tb) Sound.play('roundSting', { major: true });
    goTo('host-game'); ensureHostMap();
    renderHostGame(true);
    announce(`Round ${no}. ${q.title}. All teams have 60 seconds.`);
  }

  function timeLeftMs() {
    const r = H.round; if (!r) return TURN_MS;
    if (r.pausedLeft != null) return r.pausedLeft;
    return Math.max(0, r.endsAt - Net.now());
  }

  function onHostTick() {
    if (!H) return;
    sessionTick();
    if (H.phase !== 'question' || !H.round || H.round.revealed) return;
    const r = H.round; const left = timeLeftMs();
    const ready = r.pausedLeft == null && Net.now() < r.startsAt;
    const el = $('#hg-timer');
    if (el) {
      const n = ready ? 'Get ready' : String(Math.ceil(Math.min(left, TURN_MS) / 1000));
      el.textContent = r.pausedLeft != null ? 'Paused' : n;
      el.parentElement.classList.toggle('danger', !ready && left <= 10000);
    }
    if (r.pausedLeft != null) return;
    const whole = Math.ceil(left / 1000);
    if (whole !== H.lastWhole && !ready) {
      H.lastWhole = whole;
      if (whole === 10) Sound.play('warn10'); else if (whole <= 9 && whole >= 4) Sound.play('tick'); else if (whole <= 3 && whole >= 1) Sound.play('beep');
    }
    if (left <= 0) { Sound.play('buzzer'); revealRound(); }
  }

  function onHostGuesses() {
    if (!H) return;
    renderHostScorebar();
    if (H.phase !== 'question' || !H.round || H.round.revealed) return;
    const allLocked = H.round.eligible.every((k) => H.guesses[k] && H.guesses[k].locked);
    clearTimeout(revealTimer);
    if (allLocked) { Sound.play('lockChime'); revealTimer = setTimeout(revealRound, 1200); }
    else if (Object.values(H.guesses).some((g) => g && g.locked)) Sound.play('pinDrop');
  }

  /**
   * Multi-team scoring (identical to the two-team House Rules when there are two teams):
   * 3 = correct country (or sea within 50 km of the answer). If any team is correct, every
   * incorrect pin scores 1. Otherwise the closest incorrect pin(s) score 2 and the rest 1.
   * No pin = 0.
   */
  function scoreTeams(q, keys, gm) {
    const results = {}; const points = {};
    const info = {};
    keys.forEach((k) => {
      const g = gm[k];
      if (!g) { info[k] = null; return; }
      const km = Math.round(Geo.haversine(g.lat, g.lng, q.correctLatitude, q.correctLongitude));
      const correct = (!!g.code && q.acceptedCountryCodes.includes(g.code)) || (!g.code && km <= A.SEA_TOLERANCE_KM);
      info[k] = { km, correct };
    });
    const anyCorrect = keys.some((k) => info[k] && info[k].correct);
    const wrong = keys.filter((k) => info[k] && !info[k].correct);
    const minKm = wrong.length ? Math.min(...wrong.map((k) => info[k].km)) : null;
    const tiedClosest = wrong.filter((k) => info[k].km === minKm).length;
    keys.forEach((k) => {
      const g = gm[k]; const i = info[k];
      if (!i) { points[k] = 0; results[k] = { none: true, points: 0, reason: 'No pin was placed before time ran out.' }; return; }
      let p; let reason;
      if (i.correct) { p = 3; reason = g.code ? 'Pin is inside the correct country!' : 'Pin in the sea within 50 km of the answer — counts as correct.'; }
      else if (anyCorrect) { p = 1; reason = 'Incorrect — another team found the correct country.'; }
      else if (i.km === minKm) { p = 2; reason = wrong.length === 1 ? 'Incorrect, but the only submitted guess — it counts as the closest.' : tiedClosest > 1 ? 'Incorrect — tied for the closest guess.' : 'Incorrect, but the closest guess.'; }
      else { p = 1; reason = 'Incorrect and further away than the closest guess.'; }
      points[k] = p;
      results[k] = { lat: g.lat, lng: g.lng, name: g.name, code: g.code || null, km: i.km, correct: i.correct, points: p, reason, conf: g.conf || 'Not stated', auto: !g.locked };
    });
    return { results, points };
  }

  function revealRound() {
    const r = H.round; if (!r || r.revealed) return;
    clearTimeout(revealTimer);
    r.revealed = true; r.pausedLeft = null;
    const q = qById(r.qid);
    const gm = {};
    r.eligible.forEach((k) => { const g = H.guesses[k]; if (g && typeof g.lat === 'number') gm[k] = g; });
    if (!r.tb) {
      const res = scoreTeams(q, r.eligible, gm);
      H.history = H.history.filter((h) => h.no !== r.no);
      H.history.push({ no: r.no, qid: q.id, points: res.points, results: res.results });
      computeScores();
      A.History.add(q.id);
      H.reveal = { qid: q.id, tb: false, results: res.results };
      hostRevealSounds(res.results);
    } else {
      revealSuddenDeath(q, gm);
    }
    H.phase = 'reveal';
    push();
    renderHostGame(true);
  }

  function hostRevealSounds(results) {
    const vals = Object.values(results).filter((v) => !v.none); const mode = Sound.prefs.mode;
    Sound.play('drumroll', { major: true });
    setTimeout(() => {
      Sound.play('impact');
      const any = vals.some((v) => v.correct); const lucky = vals.some((v) => v.correct && v.conf === 'Total Guess');
      const near = vals.some((v) => !v.correct && v.km <= 400); const bold = vals.some((v) => !v.correct && v.conf === 'Very Confident');
      let seq;
      if (mode === 'professional') seq = [any ? 'success' : 'softTone'];
      else if (lucky) seq = ['jackpot', 'cheer'];
      else if (any) seq = ['success', mode === 'chaotic' ? 'cheer' : 'applause'];
      else if (near) seq = ['ooh', 'nearMiss'];
      else if (bold) seq = ['recordScratch'];
      else seq = [A.pick(['sadTrombone', 'wahwah', 'quack', 'gentleBuzzer'])];
      seq.forEach((n, i) => setTimeout(() => Sound.play(n, { major: i === 0 }), 250 + i * 650));
    }, 1650);
  }

  function renderHostScorebar() {
    const bar = $('#hg-scorebar'); if (!bar || !H) return;
    const r = H.round;
    const statusOf = (k) => {
      const t = H.teams[k]; const leadOnline = t.leader && H.players[t.leader] && H.players[t.leader].online;
      if (!t.leader) return '<span class="tstat warn">No leader</span>';
      if (H.phase !== 'question' || !r) return leadOnline ? '' : '<span class="tstat warn">Leader offline</span>';
      if (!r.eligible.includes(k)) return '<span class="tstat">Watching</span>';
      const g = H.guesses[k];
      if (g && g.locked) return '<span class="tstat ok">Locked ✓</span>';
      if (g) return '<span class="tstat">Pin placed…</span>';
      return `<span class="tstat">${leadOnline ? 'Thinking…' : 'Leader offline'}</span>`;
    };
    const sessLeft = H.sessionEndsAt ? (H.sessionEndsAt - Net.now()) / 1000 : 0;
    bar.innerHTML = `
      <div class="ochip ometa"><span class="sb-label">Round</span><span class="sb-value">${r ? (r.tb ? 'Sudden Death' : `${r.no} / ${H.s.planned}`) : '—'}</span></div>
      <div class="ochip otimer"><span class="sb-label">Time</span><span class="sb-value" id="hg-timer">${H.phase === 'question' ? '' : '—'}</span></div>
      ${keysOf(H.teams).map((k) => `<div class="ochip oteam" style="--tc:${styleOf(k).col};--tsoft:${styleOf(k).soft}">${badge(k)}<span class="oname" title="${esc(H.teams[k].name)}">${esc(H.teams[k].name)}</span><span class="oscore">${H.teams[k].score || 0}</span>${statusOf(k)}</div>`).join('')}
      <div class="ochip ometa"><span class="sb-label">Session left</span><span class="sb-value" id="hg-session">${sessLeft >= 0 ? fmtClock(sessLeft) : 'Over +' + fmtClock(-sessLeft)}</span></div>`;
    onHostTick();
  }

  function renderHostGame(force) {
    if (!H) return;
    renderHostScorebar();
    const r = H.round; const q = r && qById(r.qid);
    const key = [H.phase, r && r.no, r && r.qid, r && r.hints].join('|');
    const panel = $('#hg-panel');
    if (force || key !== H.renderedKey) {
      H.renderedKey = key;
      if (H.phase === 'question' && q) {
        renderClue(panel, q, { mystery: H.s.mystery && !r.tb, hints: r.hints, tb: r.tb, settings: H.s });
        panel.insertAdjacentHTML('afterbegin', `<div class="turn-banner ${r.tb ? 'tb' : 't1'}">${r.tb ? 'Sudden Death — ' + r.eligible.map((k) => esc(H.teams[k].name)).join(' vs ') : 'All teams: 60 seconds on your own devices'}</div>`);
        panel.insertAdjacentHTML('beforeend', '<p class="help">Team pins stay hidden until the reveal. Teammates can suggest spots; only each team’s leader can lock in.</p>');
        if (hostMap) { hostMap.clear(); hostMap.reset(); }
      } else if (H.phase === 'reveal' && q) {
        const st = serialize();
        const verdict = H.reveal.verdict ? `<div class="result-card"><p class="rc-detail"><strong>${esc(H.reveal.verdict)}</strong></p></div>` : '';
        panel.innerHTML = `<p class="eyebrow">${r.tb ? 'Sudden Death reveal' : `Answer reveal — Round ${r.no}${H.s.mystery ? ' · ' + esc(q.category) : ''}`}</p>
          <h3 class="reveal-answer" tabindex="-1">${esc(q.answerName)}</h3>
          <p class="reveal-country"><svg aria-hidden="true"><use href="#i-star"/></svg>${esc(q.correctCountry)}</p>
          <div class="result-cards">${resultsHTML(st)}${verdict}</div>
          ${spotlightHTML(q, H.s)}
          <div class="reveal-actions"><button type="button" class="btn btn-primary btn-big" id="hg-next">${nextLabel()}</button></div>`;
        if (hostMap) hostMap.reveal({ codes: q.acceptedCountryCodes, answer: { lat: q.correctLatitude, lng: q.correctLongitude }, items: revealMapItems(st), showDist: H.s.distance });
        setTimeout(() => { const h = panel.querySelector('.reveal-answer'); if (h) h.focus({ preventScroll: true }); }, 60);
      }
    }
    $('#hg-legend').innerHTML = keysOf(H.teams).map((k) => `<span style="color:${styleOf(k).col}">${styleOf(k).sym} ${esc(H.teams[k].name)}</span>`).join('') + '<span class="lg-c">★ Answer</span>';
    const q2 = H.phase === 'question'; const paused = r && r.pausedLeft != null;
    $('#hg-pause').disabled = !q2 || paused; $('#hg-resume').disabled = !q2 || !paused;
    $('#hg-hint').disabled = !q2 || !H.s.hints || !q || r.hints >= q.hints.length;
    $('#hg-skip').disabled = !q2 || (r && r.tb); $('#hg-reveal').disabled = !q2;
  }
  function nextLabel() {
    const r = H.round;
    if (r.tb) return H.sdNext && H.sdNext.type === 'win' ? 'See the Winner' : H.sdNext && H.sdNext.type === 'again' ? 'Next Expert Question' : 'Apply Tie-Break Rules';
    return H.finishAfter || r.no >= H.s.planned ? 'See Final Results' : `Next Round (${r.no + 1} of ${H.s.planned})`;
  }

  /* host toolbar */
  function bindHostTools() {
    $('#hg-reset-view').addEventListener('click', () => { if (hostMap) hostMap.reset(); });
    $('#hg-pause').addEventListener('click', () => { const r = H.round; if (r && r.pausedLeft == null) { r.pausedLeft = timeLeftMs(); r.endsAt = null; push(); renderHostGame(); announce('Timer paused.'); } });
    $('#hg-resume').addEventListener('click', () => { const r = H.round; if (r && r.pausedLeft != null) { const t = Net.now(); r.endsAt = t + r.pausedLeft; r.startsAt = Math.min(r.startsAt, t); r.pausedLeft = null; push(); renderHostGame(); announce('Timer resumed.'); } });
    $('#hg-hint').addEventListener('click', () => { const r = H.round; const q = qById(r.qid); if (r.hints < q.hints.length) { r.hints++; push(); renderHostGame(); Sound.play('click'); } });
    $('#hg-reveal').addEventListener('click', async () => {
      const pending = H.round.eligible.filter((k) => !(H.guesses[k] && H.guesses[k].locked));
      if (pending.length) {
        const v = await confirmDialog({ title: 'Reveal the answer now?', body: `<p>${pending.map((k) => esc(H.teams[k].name)).join(', ')} ${pending.length > 1 ? 'have' : 'has'} not locked in. Placed pins will be locked automatically; teams with no pin score 0.</p>`, buttons: [{ label: 'Reveal Answer', value: 'yes', cls: 'btn-primary' }, { label: 'Cancel', value: 'no', cls: 'btn-ghost' }], pauseTimer: false });
        if (v !== 'yes') return;
      }
      revealRound();
    });
    $('#hg-skip').addEventListener('click', async () => {
      const v = await confirmDialog({ title: 'Skip this question?', body: '<p>A new question replaces this one and the timer restarts. Pins placed so far are cleared.</p>', buttons: [{ label: 'Skip Question', value: 'yes', cls: 'btn-primary' }, { label: 'Cancel', value: 'no', cls: 'btn-ghost' }], pauseTimer: false });
      if (v !== 'yes' || !H || H.phase !== 'question') return;
      A.History.add(H.round.qid);
      const q = A.pickQuestion({ usedIds: new Set(H.sequence), sequence: H.sequence });
      if (!q) { toast('No other unused questions are available.'); return; }
      H.sequence.push(q.id);
      beginQuestion(q, { no: H.round.no, tb: false, eligible: H.round.eligible });
      Sound.play('mystery', { major: true });
    });
    $('#hg-reset-round').addEventListener('click', async () => {
      const v = await confirmDialog({ title: 'Reset the current round?', body: '<p>All pins for this round are cleared, any points awarded this round are removed, and the timer restarts with the same question.</p>', buttons: [{ label: 'Reset Round', value: 'yes', cls: 'btn-primary' }, { label: 'Cancel', value: 'no', cls: 'btn-ghost' }], pauseTimer: false });
      if (v !== 'yes' || !H || !H.round) return;
      const r = H.round;
      if (!r.tb) { H.history = H.history.filter((h) => h.no !== r.no); computeScores(); }
      beginQuestion(qById(r.qid), { no: r.no, tb: r.tb, eligible: r.eligible });
      toast('Round reset.');
    });
    $('#hg-teams').addEventListener('click', () => { renderTeamsDialog(); openDialog($('#dlg-teams'), { pauseTimer: false }); });
    $('#dlg-teams').addEventListener('click', hostLobbyAction);
    $('#dlg-teams').addEventListener('change', hostLobbyAction);
    $('#hg-end').addEventListener('click', async () => {
      const counts = H.phase === 'reveal' && !H.round.tb;
      const v = await confirmDialog({ title: 'End the game early?', body: `<p>Scores are calculated from completed rounds only${counts ? ' (including this one)' : '. The current unfinished round will not count'}.</p>`, buttons: [{ label: 'End Game Now', value: 'yes', cls: 'btn-primary' }, { label: 'Keep Playing', value: 'no', cls: 'btn-ghost' }], pauseTimer: false });
      if (v === 'yes' && H) { clearTimeout(revealTimer); if (H.round) H.round.revealed = true; finish(true); }
    });
    $('#hg-panel').addEventListener('click', (e) => { if (e.target.id === 'hg-next') onHostNext(); });
    $('#btn-tb-begin').addEventListener('click', () => { if (H && H.phase === 'sdIntro') beginQuestion(qById(H.sd.qid), { no: 'SD', tb: true, eligible: H.sd.contenders }); });
  }

  function renderTeamsDialog() {
    if (!H) return;
    const body = $('#dlg-teams-body');
    body.innerHTML = keysOf(H.teams).map((k) => {
      const t = H.teams[k];
      return `<section class="lteam" style="--tc:${styleOf(k).col};--tsoft:${styleOf(k).soft}"><header>${badge(k, 'lg')}<h3>${esc(t.name)}</h3></header>
        <ul class="mlist">${membersOf(H.players, k).map((u) => `<li class="member"><span class="dot ${H.players[u].online ? 'on' : 'off'}"></span><span class="mname">${t.leader === u ? '⭐ ' : ''}${esc(H.players[u].name)}</span><span class="mactions">${t.leader === u ? '' : `<button type="button" class="btn btn-ghost btn-tiny" data-act="lead" data-uid="${u}" data-team="${k}">Make leader</button>`}<label class="visually-hidden" for="dmv-${u}">Move</label><select id="dmv-${u}" data-act="move" data-uid="${u}"><option value="">Move to…</option>${keysOf(H.teams).filter((x) => x !== k).map((x) => `<option value="${x}">${esc(H.teams[x].name)}</option>`).join('')}</select></span></li>`).join('') || '<li class="empty">No players</li>'}</ul></section>`;
    }).join('') + (() => {
      const loose = Object.keys(H.players).filter((u) => !H.players[u].team || !H.teams[H.players[u].team]);
      return loose.length ? `<section class="lteam lteam-none"><header><h3>Not in a team</h3></header><ul class="mlist">${loose.map((u) => `<li class="member"><span class="dot ${H.players[u].online ? 'on' : 'off'}"></span><span class="mname">${esc(H.players[u].name)}</span><span class="mactions"><label class="visually-hidden" for="dmv-${u}">Move</label><select id="dmv-${u}" data-act="move" data-uid="${u}"><option value="">Add to team…</option>${keysOf(H.teams).map((x) => `<option value="${x}">${esc(H.teams[x].name)}</option>`).join('')}</select></span></li>`).join('')}</ul></section>` : '';
    })();
    body.className = 'lobby-teams';
  }

  /* session clock & time-up */
  function sessionTick() {
    if (!H || !H.sessionEndsAt || H.phase === 'lobby' || H.phase === 'end') return;
    const left = (H.sessionEndsAt - Net.now()) / 1000;
    const el = $('#hg-session'); if (el) el.textContent = left >= 0 ? fmtClock(left) : 'Over +' + fmtClock(-left);
    if (H.s.warnings) [[300, '5 minutes left in the session.'], [120, '2 minutes left in the session.'], [60, '1 minute left in the session.']].forEach(([th, msg]) => {
      if (!H.warned[th] && left <= th && left > 0) { H.warned[th] = true; toast(msg, th <= 60 ? 'warn' : ''); Sound.play('warn10'); }
    });
    if (left <= 0 && !H.timeUpHandled && !(H.round && H.round.tb)) { H.timeUpHandled = true; hostTimeUp(); }
  }
  async function hostTimeUp() {
    if (H.phase === 'question') {
      const v = await confirmDialog({ title: 'Scheduled session time is up', body: '<p>Finish this round, or end the game now? If you end now, only completed rounds count.</p>', buttons: [{ label: 'Finish This Round', value: 'finish', cls: 'btn-primary' }, { label: 'End Game Now', value: 'end', cls: 'btn-secondary' }], pauseTimer: false });
      if (!H) return;
      if (v === 'end') { if (H.round) H.round.revealed = true; finish(true); } else { H.finishAfter = true; push(); toast('This will be the final round.'); }
    } else if (H.phase === 'reveal') {
      const v = await confirmDialog({ title: 'Scheduled session time is up', body: '<p>See the final results now, or keep playing your planned rounds?</p>', buttons: [{ label: 'See Final Results', value: 'end', cls: 'btn-primary' }, { label: 'Keep Playing', value: 'keep', cls: 'btn-secondary' }], pauseTimer: false });
      if (v === 'end' && H) finish(false, true);
    }
  }

  /* =================================================================
   * 6. HOST — finishing, Sudden Death & tie-break chain
   * ================================================================= */
  function onHostNext() {
    const r = H.round;
    if (r.tb) {
      const n = H.sdNext;
      if (n.type === 'win') endGame({ winners: [n.winner], method: 'suddenDeath', note: n.note });
      else if (n.type === 'again') startSuddenDeath(n.contenders);
      else tieFallback(n.contenders);
      return;
    }
    if (H.finishAfter || r.no >= H.s.planned) finish(false); else nextRound(r.no + 1);
  }

  async function finish(early, timeUp) {
    computeScores();
    const ks = keysOf(H.teams);
    const top = Math.max(...ks.map((k) => H.teams[k].score || 0));
    const tied = ks.filter((k) => (H.teams[k].score || 0) === top);
    const n = H.history.length;
    if (tied.length === 1) { endGame({ winners: tied, method: 'score', note: `Decided on total score from ${n} completed round${n === 1 ? '' : 's'}${early ? ' (game ended early)' : ''}.` }); return; }
    const canTB = DATA.TIEBREAKERS.some((q) => !H.tbUsed.includes(q.id));
    if (!H.s.tiebreaker || !canTB) { endGame({ winners: tied, method: 'draw', note: `${tied.map((k) => H.teams[k].name).join(' and ')} are level on ${top} points, so the game is a draw.` }); return; }
    if (early || timeUp) {
      const v = await confirmDialog({ title: 'Scores are level!', body: `<p>${tied.map((k) => esc(H.teams[k].name)).join(' and ')} are tied on ${top}. Play an Expert Sudden Death question, or declare a draw?</p>`, buttons: [{ label: 'Sudden Death', value: 'tb', cls: 'btn-primary' }, { label: 'Declare a Draw', value: 'draw', cls: 'btn-secondary' }], pauseTimer: false });
      if (!H) return;
      if (v !== 'tb') { endGame({ winners: tied, method: 'draw', note: `Tied on ${top}; the host declared a draw.` }); return; }
    }
    startSuddenDeath(tied);
  }

  function startSuddenDeath(contenders) {
    const q = A.pickTiebreaker(new Set(H.tbUsed));
    if (!q) { tieFallback(contenders); return; }
    H.tbUsed.push(q.id);
    H.sd = { contenders, attempt: ((H.sd && H.sd.attempt) || 0) + 1, qid: q.id };
    H.phase = 'sdIntro';
    push();
    showSdIntro();
  }
  function showSdIntro() {
    $('#tb-kicker').textContent = H.sd.attempt === 1 ? 'IT’S A TIE!' : 'STILL TIED — EXACTLY!';
    $('#tb-score').textContent = H.sd.contenders.map((k) => `${H.teams[k].name} ${H.teams[k].score || 0}`).join('  ·  ');
    goTo('tiebreak');
    Sound.play('suddenDeath', { major: true });
    Sound.play('heartbeat', { delay: 2.2 });
  }

  function revealSuddenDeath(q, gm) {
    const km = {}; const results = {};
    H.round.eligible.forEach((k) => {
      const g = gm[k];
      if (!g) { km[k] = Infinity; results[k] = { none: true, reason: 'No guess submitted.' }; return; }
      km[k] = Math.round(Geo.haversine(g.lat, g.lng, q.correctLatitude, q.correctLongitude));
      results[k] = { lat: g.lat, lng: g.lng, name: g.name, km: km[k], reason: `${fmtKm(km[k])} from the answer.`, auto: !g.locked };
    });
    const min = Math.min(...Object.values(km));
    const best = H.round.eligible.filter((k) => km[k] === min);
    let verdict;
    if (best.length === 1) {
      const w = best[0];
      const others = H.round.eligible.filter((k) => k !== w).map((k) => `${H.teams[k].name}: ${Number.isFinite(km[k]) ? fmtKm(km[k]) : 'no guess'}`).join('; ');
      verdict = `${H.teams[w].name}’s pin was closest (${fmtKm(km[w])}).`;
      H.sdNext = { type: 'win', winner: w, note: `Won in Expert Sudden Death — ${H.teams[w].name} was ${fmtKm(km[w])} from the answer (${others}).` };
      Sound.play('drumroll', { major: true }); setTimeout(() => Sound.play('fanfare', { major: true }), 1700);
    } else {
      verdict = Number.isFinite(min) ? `Exact tie: ${best.map((k) => H.teams[k].name).join(' and ')} are all ${fmtKm(min)} away!` : 'Nobody submitted a guess.';
      const more = DATA.TIEBREAKERS.some((x) => !H.tbUsed.includes(x.id));
      H.sdNext = H.sd.attempt === 1 && more ? { type: 'again', contenders: best } : { type: 'fallback', contenders: best };
      Sound.play('drumroll', { major: true }); setTimeout(() => Sound.play('suspense', { major: true }), 1700);
    }
    H.reveal = { qid: q.id, tb: true, results, verdict };
  }

  async function tieFallback(contenders) {
    const correct = {}; const kms = {};
    contenders.forEach((k) => { correct[k] = 0; kms[k] = []; });
    H.history.forEach((h) => contenders.forEach((k) => { const r = (h.results || {})[k]; if (r && !r.none) { if (r.correct) correct[k]++; kms[k].push(r.km); } }));
    const maxC = Math.max(...contenders.map((k) => correct[k]));
    let left = contenders.filter((k) => correct[k] === maxC);
    if (left.length === 1) { endGame({ winners: left, method: 'correctCount', note: `Still tied after Sudden Death, so the winner was decided by correct-country answers in the main game (${maxC}).` }); return; }
    const avg = {}; left.forEach((k) => { avg[k] = kms[k].length ? Math.round(kms[k].reduce((a, b) => a + b, 0) / kms[k].length) : Infinity; });
    const minA = Math.min(...left.map((k) => avg[k]));
    const left2 = left.filter((k) => avg[k] === minA);
    if (left2.length === 1) { endGame({ winners: left2, method: 'avgProximity', note: `Still tied after Sudden Death and on correct countries (${maxC} each), so the winner was decided by average distance across main-game guesses: ${fmtKm(minA)}.` }); return; }
    const more = DATA.TIEBREAKERS.some((x) => !H.tbUsed.includes(x.id));
    const v = await confirmDialog({ title: 'A truly perfect tie!', body: `<p>${left2.map((k) => esc(H.teams[k].name)).join(' and ')} are level on every tie-break measure. How would you like to finish?</p>`, buttons: [{ label: 'Declare Joint Winners', value: 'joint', cls: 'btn-primary' }].concat(more ? [{ label: 'Another Expert Question', value: 'again', cls: 'btn-secondary' }] : []), pauseTimer: false });
    if (!H) return;
    if (v === 'again' && more) { startSuddenDeath(left2); return; }
    endGame({ winners: left2, method: 'joint', note: 'Level on every tie-break measure — the host declared joint winners.' });
  }

  function endGame({ winners, method, note }) {
    computeScores();
    const ranking = keysOf(H.teams).sort((a, b) => (H.teams[b].score || 0) - (H.teams[a].score || 0)).map((k) => ({ key: k, name: H.teams[k].name, score: H.teams[k].score || 0 }));
    H.final = { winners, method, note, ranking };
    H.phase = 'end';
    if (H.round) H.round.revealed = true;
    push();
    goTo('online-end');
    renderEnd(serialize(), true);
    Sound.play('confettiPop');
    if (Sound.prefs.mode === 'professional') Sound.play('applause', { delay: 0.3 });
    else { Sound.play('fanfare', { major: true, delay: 0.25 }); Sound.play('applause', { delay: 1.2 }); }
    A.confetti();
  }

  /* =================================================================
   * 7. PLAYER
   * ================================================================= */
  let P = null;          // player state
  let playerMap = null;
  let playerTick = null;

  async function joinGame(code, name) {
    await Net.connect();
    const meta = (await Net.ref(code, 'meta').once('value')).val();
    if (!meta) throw new Error(`No game found with code ${code}. Check the code with your host.`);
    const me = Net.ref(code, 'players/' + Net.uid);
    const existing = (await me.once('value')).val();
    await me.update({ name, online: true, joined: existing && existing.joined ? existing.joined : Date.now() });
    me.child('online').onDisconnect().set(false);
    P = { code, name, state: null, players: {}, lead: {}, team: existing ? existing.team || null : null, guess: null, suggest: {}, conf: null, seen: false, teamSubs: [], renderedKey: '', lastPhase: null };
    sessionStorage.setItem('witw.player', JSON.stringify({ code, name }));
    detachAll();
    listen(Net.ref(code, 'state'), (s) => {
      const v = s.val();
      if (!v && P.state) { leaveGame('The host has closed this game. Thanks for playing!'); return; }
      P.state = v; renderPlayer();
    });
    listen(Net.ref(code, 'players'), (s) => {
      P.players = s.val() || {};
      const mine = P.players[Net.uid];
      if (!mine && P.seen) {
        const code = P.code;
        const bye = (msg) => { if (P && P.code === code) leaveGame(msg); };
        Net.ref(code, 'meta').once('value').then((m) => bye(m.val() ? 'You were removed from the room by the host.' : 'The host has closed this game. Thanks for playing!'))
          .catch(() => bye('The host has closed this game. Thanks for playing!'));
        P.seen = false;
        return;
      }
      if (mine) P.seen = true;
      const team = mine ? mine.team || null : null;
      if (team !== P.team) { P.team = team; subscribeTeam(); }
      renderPlayer();
    });
    listen(Net.ref(code, 'lead'), (s) => { P.lead = s.val() || {}; renderPlayer(); });
    subscribeTeam();
    if (!playerTick) playerTick = setInterval(playerTimerTick, 250);
    goTo('player');
    renderPlayer();
  }

  function subscribeTeam() {
    P.teamSubs.forEach((off) => off()); P.teamSubs = [];
    P.guess = null; P.suggest = {};
    if (!P.team) return;
    const g = Net.ref(P.code, 'guesses/' + P.team); const s = Net.ref(P.code, 'suggest/' + P.team);
    const gf = (snap) => { P.guess = snap.val(); renderPlayerGameParts(); };
    const sf = (snap) => { P.suggest = snap.val() || {}; renderPlayerGameParts(); };
    g.on('value', gf, () => {}); s.on('value', sf, () => {});
    P.teamSubs.push(() => g.off('value', gf), () => s.off('value', sf));
  }

  function leaveGame(msg) {
    if (P) { P.teamSubs.forEach((off) => off()); Net.ref(P.code, 'players/' + Net.uid + '/online').set(false).catch(() => {}); }
    detachAll(); P = null;
    sessionStorage.removeItem('witw.player');
    if (playerTick) { clearInterval(playerTick); playerTick = null; }
    A.setMode('local');
    goTo('intro');
    if (msg) toast(msg);
  }

  const amLeader = () => P && P.state && P.team && P.state.teams && P.state.teams[P.team] && P.state.teams[P.team].leader === Net.uid;
  const leadRef = () => Net.ref(P.code, 'lead/' + Net.uid);
  const leadReq = (req) => leadRef().update({ req, team: P.team, ts: Net.now() }).catch((e) => toast(e.message, 'warn'));

  function renderPlayer() {
    if (!P) return;
    const st = P.state; const me = P.players[Net.uid] || { name: P.name };
    const team = st && P.team && st.teams ? st.teams[P.team] : null;
    $('#pl-head').innerHTML = `<span class="room-pill">Room ${esc(P.code)}</span><span class="pl-me">${esc(me.name)}</span>${team ? `<span class="pl-team" style="--tc:${styleOf(P.team).col};--tsoft:${styleOf(P.team).soft}">${badge(P.team)} ${esc(team.name)}${amLeader() ? ' · ⭐ Leader' : ''}</span>` : '<span class="pl-team none">No team yet</span>'}
      <button type="button" class="btn btn-ghost btn-tiny" id="pl-leave">Leave</button>`;
    if (!st) { $('#pl-body').innerHTML = '<p class="pl-wait">Connecting…</p>'; $('#pl-game').hidden = true; return; }
    if (st.phase !== P.lastPhase) { P.lastPhase = st.phase; P.renderedKey = ''; }
    if (st.phase === 'end') {
      if (A.ui.screen !== 'online-end') { goTo('online-end'); renderEnd(st, false); A.confetti(); }
      return;
    }
    if (A.ui.screen !== 'player') goTo('player');
    if (st.phase === 'lobby') { $('#pl-game').hidden = true; $('#pl-body').innerHTML = playerLobbyHTML(st); return; }
    if (st.phase === 'sdIntro') {
      $('#pl-game').hidden = true;
      const mine = st.sd && st.sd.contenders.includes(P.team);
      $('#pl-body').innerHTML = `<div class="pl-card sudden-mini"><p class="sudden-small">IT’S A TIE!</p><h2>Sudden Death</h2><p>${st.sd.contenders.map((k) => esc(st.teams[k].name)).join(' vs ')}</p><p>${mine ? 'Your team is in! One secret guess — the closest pin wins. Get ready…' : 'Your team is watching this one. Cheer them on!'}</p></div>`;
      return;
    }
    // question or reveal
    const r = st.round;
    if (!P.team || !st.teams[P.team]) { $('#pl-game').hidden = true; $('#pl-body').innerHTML = '<div class="pl-card"><h2>You’re watching</h2><p>You are not in a team for this game. Ask the host to add you via Teams &amp; Players.</p></div>'; return; }
    const playing = r && r.eligible && r.eligible.includes(P.team);
    if (st.phase === 'question' && !playing) { $('#pl-game').hidden = true; $('#pl-body').innerHTML = `<div class="pl-card"><h2>Sudden Death in progress</h2><p>${r.eligible.map((k) => esc(st.teams[k].name)).join(' vs ')} are guessing. Watch the host’s screen!</p></div>`; return; }
    $('#pl-body').innerHTML = '';
    const wasHidden = $('#pl-game').hidden;
    $('#pl-game').hidden = false;
    if (!playerMap) { playerMap = makeMap($('#player-map')); if (playerMap) playerMap.onClick(onPlayerMapClick); }
    if (playerMap && wasHidden) playerMap.invalidate();
    renderPlayerGameParts();
  }

  function playerLobbyHTML(st) {
    const ks = keysOf(st.teams);
    const myTeam = P.team && st.teams[P.team] ? P.team : null;
    const teamBtns = ks.map((k) => {
      const n = membersOf(P.players, k).length; const s = styleOf(k);
      return `<button type="button" class="team-pick${k === myTeam ? ' chosen' : ''}" data-pact="team" data-team="${k}" style="--tc:${s.col};--tsoft:${s.soft}" aria-pressed="${k === myTeam}">${badge(k, 'lg')}<span class="tp-name">${esc(st.teams[k].name)}</span><span class="tp-count">${n} player${n === 1 ? '' : 's'}</span></button>`;
    }).join('');
    let leaderPanel = '<p class="help">Pick a team to see your team-leader options.</p>';
    if (myTeam) {
      const t = st.teams[myTeam]; const mem = membersOf(P.players, myTeam);
      const myRec = P.lead[Net.uid] && P.lead[Net.uid].team === myTeam ? P.lead[Net.uid] : {};
      if (t.leader) {
        const ln = (P.players[t.leader] || {}).name || 'Your leader';
        leaderPanel = t.leader === Net.uid
          ? `<p class="lead-now">⭐ You are the team leader (${HOW_LABEL[t.how] || ''}). You’ll place and lock your team’s pin.</p><button type="button" class="btn btn-ghost btn-small" data-pact="stepdown">Step down</button>`
          : `<p class="lead-now">⭐ Your leader is <strong>${esc(ln)}</strong> (${HOW_LABEL[t.how] || ''}).</p>${t.how === 'volunteer' ? '<button type="button" class="btn btn-ghost btn-small" data-pact="object">Object — choose another way</button>' : ''}`;
      } else {
        const tally = {}; mem.forEach((u) => { const r = P.lead[u]; if (r && r.team === myTeam && r.vote && mem.includes(r.vote)) tally[r.vote] = (tally[r.vote] || 0) + 1; });
        leaderPanel = `<p class="lead-now">Your team needs a leader. Choose one way:</p>
          <div class="lead-ways">
            <div class="lead-way"><h4>1. Unanimous vote</h4><p class="help">Everyone votes; the leader is chosen when all ${mem.length} vote for the same person.</p>
              <ul class="vote-list">${mem.map((u) => `<li><button type="button" class="btn btn-small ${myRec.vote === u ? 'btn-primary' : 'btn-ghost'}" data-pact="vote" data-uid="${u}" aria-pressed="${myRec.vote === u}">${myRec.vote === u ? '✓ ' : ''}${esc(P.players[u].name)}${u === Net.uid ? ' (me)' : ''}</button><span class="vote-count">${tally[u] ? `${tally[u]}/${mem.length}` : ''}</span></li>`).join('')}</ul></div>
            <div class="lead-way"><h4>2. Volunteer</h4><p class="help">Become leader now. A teammate can object.</p><button type="button" class="btn btn-secondary btn-small" data-pact="claim">I’ll lead</button></div>
            <div class="lead-way"><h4>3. Let fate decide</h4><p class="help">The game picks someone at random.</p><button type="button" class="btn btn-secondary btn-small" data-pact="fate">Spin for a leader</button></div>
          </div>`;
      }
    }
    return `<div class="pl-card"><h2>Welcome, ${esc((P.players[Net.uid] || { name: P.name }).name)}!</h2><p>Choose your team${myTeam ? ' (you can switch until the game starts)' : ''}:</p><div class="team-picks">${teamBtns}</div></div>
      ${myTeam ? `<div class="pl-card"><h3>Team leader — ${esc(st.teams[myTeam].name)}</h3>${leaderPanel}<p class="help">Team: ${membersOf(P.players, myTeam).map((u) => esc(P.players[u].name) + (P.players[u].online ? '' : ' (offline)')).join(', ')}</p></div>` : ''}
      <p class="pl-wait" role="status">Waiting for the host to start the game…</p>`;
  }

  /** Updates clue/reveal, controls and map for the player's game view. */
  function renderPlayerGameParts() {
    if (!P || !P.state || $('#pl-game').hidden) return;
    const st = P.state; const r = st.round; const q = r && qById(r.qid);
    if (!q) return;
    const key = [st.phase, r.no, r.qid, r.hints].join('|');
    const clue = $('#pl-clue');
    if (key !== P.renderedKey) {
      const phaseChanged = !P.renderedKey || P.renderedKey.split('|')[0] !== st.phase || P.renderedKey.split('|')[2] !== r.qid;
      P.renderedKey = key;
      if (st.phase === 'question') {
        renderClue(clue, q, { mystery: st.s.mystery && !r.tb, hints: r.hints || 0, tb: r.tb, settings: st.s });
        if (phaseChanged) { P.conf = null; if (playerMap) { playerMap.clear(); playerMap.reset(); } }
      } else if (st.phase === 'reveal' && st.reveal) {
        clue.innerHTML = `<p class="eyebrow">${r.tb ? 'Sudden Death reveal' : `Answer — Round ${r.no}`}</p><h3 class="reveal-answer">${esc(q.answerName)}</h3><p class="reveal-country"><svg aria-hidden="true"><use href="#i-star"/></svg>${esc(q.correctCountry)}</p>
          <div class="result-cards">${resultsHTML(st, P.team)}${st.reveal.verdict ? `<div class="result-card"><p class="rc-detail"><strong>${esc(st.reveal.verdict)}</strong></p></div>` : ''}</div>${spotlightHTML(q, st.s)}`;
        if (playerMap) playerMap.reveal({ codes: q.acceptedCountryCodes, answer: { lat: q.correctLatitude, lng: q.correctLongitude }, items: revealMapItems(st), showDist: st.s.distance });
      }
    }
    // controls
    const ctr = $('#pl-controls');
    if (st.phase === 'reveal') {
      const mine = st.reveal.results && st.reveal.results[P.team];
      ctr.innerHTML = `<div class="pl-status">${mine && !st.reveal.tb ? `Your team scored <strong>+${mine.points || 0}</strong>. ` : ''}Scores: ${keysOf(st.teams).map((k) => `${badge(k)} ${esc(st.teams[k].name)} <strong>${st.teams[k].score || 0}</strong>`).join(' · ')}</div><p class="pl-wait">Waiting for the host…</p>`;
      return;
    }
    const leader = amLeader(); const g = P.guess; const locked = g && g.locked;
    const sugg = Object.entries(P.suggest || {}).filter(([u]) => u !== Net.uid || !leader);
    const ln = (P.players[st.teams[P.team].leader] || {}).name || 'your leader';
    ctr.innerHTML = `
      <div class="pl-timerline"><span class="pl-timer" id="pl-timer">—</span><span class="pl-role">${leader ? '⭐ You are the leader: place and lock your team’s pin.' : `Tap the map to suggest a spot to ${esc(ln)}.`}</span></div>
      ${locked ? `<p class="pl-locked">✓ ${esc(st.teams[P.team].name)} locked in: ${esc(g.name)}${g.conf ? ` (${esc(g.conf)})` : ''}. Waiting for the other teams…</p>` : ''}
      ${!locked ? `<div class="country-picker"><label for="pl-country">Or choose a country</label><div class="input-row"><input type="text" id="pl-country" list="country-list" autocomplete="off" placeholder="Start typing…"><button type="button" class="btn btn-ghost btn-small" data-pact="country">${leader ? 'Place pin' : 'Suggest'}</button><button type="button" class="btn btn-ghost btn-small" data-pact="centre">Pin map centre</button></div></div>` : ''}
      ${leader && !locked ? `
        ${sugg.length ? `<div class="sugg"><p class="help">Team suggestions:</p>${sugg.map(([u, s]) => `<button type="button" class="btn btn-ghost btn-tiny" data-pact="use" data-uid="${u}">Use ${esc((P.players[u] || {}).name || s.by)}’s: ${esc(s.name)}</button>`).join(' ')}</div>` : ''}
        <p class="pin-status">${g ? `Team pin: <strong>${esc(g.name)}</strong>` : 'No team pin yet.'}</p>
        ${st.s.confidence && !r.tb ? `<div class="confidence-options" role="radiogroup" aria-label="How confident is your team?">${['Very Confident', 'Fairly Confident', 'Unsure', 'Total Guess'].map((c) => `<button type="button" role="radio" aria-checked="${(g && g.conf) === c}" data-pact="conf" data-conf="${c}">${c}</button>`).join('')}</div>` : ''}
        <button type="button" class="btn btn-primary btn-lock" data-pact="lock" ${g ? '' : 'disabled'}>Lock In Team Guess</button>` : ''}
      ${!leader && !locked ? `<p class="pin-status">${P.suggest[Net.uid] ? `Your suggestion: <strong>${esc(P.suggest[Net.uid].name)}</strong>` : 'No suggestion yet.'}${g ? ` · Leader’s pin: <strong>${esc(g.name)}</strong>` : ''}</p>` : ''}`;
    playerTimerTick();
    // pins: team suggestions + the team's pin
    if (playerMap && st.phase === 'question') {
      const pins = Object.entries(P.suggest || {}).map(([u, s]) => ({ kind: 'suggest', team: P.team, lat: s.lat, lng: s.lng, label: (P.players[u] || {}).name || s.by || '?' }));
      if (g) pins.push({ team: P.team, lat: g.lat, lng: g.lng, label: locked ? 'Team pin ✓' : 'Team pin', title: 'Your team’s pin' });
      playerMap.setPins(pins);
    }
  }

  function playerTimerTick() {
    if (!P || !P.state || P.state.phase !== 'question') return;
    const el = $('#pl-timer'); if (!el) return;
    const r = P.state.round;
    if (r.pausedLeft != null) { el.textContent = 'Paused'; return; }
    const now = Net.now();
    if (now < r.startsAt) { el.textContent = 'Get ready…'; return; }
    const s = Math.max(0, Math.ceil((r.endsAt - now) / 1000));
    el.textContent = s + 's';
    el.classList.toggle('danger', s <= 10);
  }

  function onPlayerMapClick(lat, lng, forced) {
    if (!P || !P.state || P.state.phase !== 'question' || !P.team) return;
    const r = P.state.round; if (!r.eligible.includes(P.team) || r.pausedLeft != null) return;
    if (Net.now() < r.startsAt) { toast('Get ready — the timer is about to start.'); return; }
    const spot = locate(lat, lng, forced);
    if (amLeader()) {
      if (P.guess && P.guess.locked) return;
      const conf = P.guess && P.guess.conf ? P.guess.conf : null;
      Net.ref(P.code, 'guesses/' + P.team).set(Object.assign({}, spot, { conf, locked: false, by: Net.uid })).catch((e) => toast('Could not place the pin: ' + e.message, 'warn'));
    } else {
      Net.ref(P.code, 'suggest/' + P.team + '/' + Net.uid).set(Object.assign({}, spot, { by: P.name })).catch((e) => toast('Could not suggest: ' + e.message, 'warn'));
    }
  }

  async function playerAction(e) {
    const el = e.target.closest('[data-pact]'); if (!el || !P) return;
    const act = el.dataset.pact;
    try {
      if (act === 'team') {
        if (P.state && P.state.phase !== 'lobby') return;
        await leadRef().remove();
        await Net.ref(P.code, 'players/' + Net.uid + '/team').set(el.dataset.team);
      } else if (act === 'vote') await leadRef().update({ vote: el.dataset.uid, team: P.team });
      else if (['claim', 'fate', 'object', 'stepdown'].includes(act)) { await leadReq(act); if (act === 'fate') toast('Spinning for a leader…'); }
      else if (act === 'country') {
        const c = Geo.findByName(($('#pl-country') || {}).value);
        if (!c) { toast('Country not found — choose a name from the list.'); return; }
        onPlayerMapClick(c.labelLat, c.labelLng, c);
        if (playerMap) playerMap.m.panTo([c.labelLat, c.labelLng]);
      } else if (act === 'centre') { if (playerMap) { const c = playerMap.centre(); onPlayerMapClick(c[0], c[1]); } }
      else if (act === 'use') { const s = P.suggest[el.dataset.uid]; if (s) onPlayerMapClick(s.lat, s.lng, s.code ? Geo.byCode.get(s.code) : null); }
      else if (act === 'conf') { if (P.guess) await Net.ref(P.code, 'guesses/' + P.team).update({ conf: el.dataset.conf }); }
      else if (act === 'lock') {
        if (!P.guess) return;
        if (P.state.s.confidence && !P.state.round.tb && !P.guess.conf) { toast('Choose a confidence rating before locking in.'); return; }
        await Net.ref(P.code, 'guesses/' + P.team).update({ locked: true });
        announce('Locked in.');
      }
    } catch (err) { toast('That didn’t work: ' + err.message, 'warn'); }
  }

  /* =================================================================
   * 8. FINAL RESULTS (host and players)
   * ================================================================= */
  function renderEnd(st, isHost) {
    const f = st.final; if (!f) return;
    const names = f.winners.map((k) => st.teams[k] ? st.teams[k].name : k);
    const title = f.winners.length === 1 ? `${names[0]} win!` : (f.method === 'draw' ? 'It’s a draw!' : `Joint winners: ${names.join(' & ')}!`);
    // Winners are always placed 1st (a Sudden Death winner ranks above the team it tied with); others rank by score.
    const ordered = f.ranking.filter((r) => f.winners.includes(r.key)).concat(f.ranking.filter((r) => !f.winners.includes(r.key)));
    let place = 0; let prev = null;
    const rows = ordered.map((r, i) => {
      const win = f.winners.includes(r.key);
      if (win) place = 1; else if (r.score !== prev || i === f.winners.length) { place = i + 1; }
      prev = win ? null : r.score;
      return `<tr${win ? ' class="win"' : ''}><td>${place}</td><td>${badge(r.key)} ${esc(r.name)}${win && f.method === 'suddenDeath' ? ' <span class="help">(won Sudden Death)</span>' : ''}</td><td class="num">${r.score}</td></tr>`;
    }).join('');
    const hist = st.history || [];
    const countries = [...new Set(hist.map((h) => (qById(h.qid) || {}).correctCountry).filter(Boolean).map((c) => c.split(' (')[0]))];
    const correct = {}; let closest = null;
    hist.forEach((h) => Object.entries(h.results || {}).forEach(([k, r]) => { if (r.none) return; if (r.correct) correct[k] = (correct[k] || 0) + 1; if (!closest || r.km < closest.km) closest = { k, km: r.km, q: qById(h.qid) }; }));
    const items = [
      ['Countries explored', countries.length ? `${countries.length}: ${countries.join(', ')}` : '—'],
      ['Correct-country guesses', keysOf(st.teams).map((k) => `${st.teams[k].name}: ${correct[k] || 0}`).join(' · ')],
      ['Closest guess of the game', closest ? `${(st.teams[closest.k] || {}).name} — ${fmtKm(closest.km)} from ${closest.q ? closest.q.answerName : ''}` : '—'],
    ];
    const mine = !isHost && P && P.team && f.winners.includes(P.team);
    $('#online-end').innerHTML = `
      <p class="eyebrow">Final destination</p>
      <h2 id="oe-title" class="winner-title" tabindex="-1">${esc(title)}</h2>
      <p class="champion-msg">${mine ? 'That’s your team — congratulations!' : esc(A.pick(A.CHAMPION_LINES))}</p>
      <div class="table-scroll"><table class="rank-table"><thead><tr><th>Place</th><th>Team</th><th class="num">Points</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="method-note">How the winner was determined: ${esc(f.note)}</p>
      <h3 class="journey-title">Your World Journey</h3>
      <div class="journey-grid">${items.map(([h, p]) => `<div class="journey-item"><h4>${esc(h)}</h4><p>${esc(p)}</p></div>`).join('')}</div>
      <div class="end-actions">${isHost
        ? '<button type="button" class="btn btn-primary" data-eact="again">Play Again (same teams)</button><button type="button" class="btn btn-secondary" data-eact="lobby">Back to Lobby</button><button type="button" class="btn btn-secondary" data-eact="highlights">View Cultural Highlights</button><button type="button" class="btn btn-ghost tool-danger" data-eact="close">Close Room</button>'
        : '<button type="button" class="btn btn-secondary" data-eact="highlights">View Cultural Highlights</button><button type="button" class="btn btn-ghost" data-eact="leave">Leave Game</button>'}</div>`;
    setTimeout(() => { const h = $('#oe-title'); if (h) h.focus({ preventScroll: true }); }, 60);
  }

  function showHighlights(st) {
    const hist = (st && st.history) || [];
    $('#highlights-body').innerHTML = hist.length ? hist.map((h) => { const q = qById(h.qid); return q ? `<div class="highlight-item"><h3>Round ${h.no}: ${esc(q.answerName)} — ${esc(q.correctCountry)}</h3><p>${esc(q.answerExplanation)}</p><p><strong>Why it matters:</strong> ${esc(q.culturalSignificance)}</p><p><strong>Memorable fact:</strong> ${esc(q.surprisingFact)}</p></div>` : ''; }).join('') : '<p>No rounds were completed.</p>';
    openDialog($('#dlg-highlights'), { pauseTimer: false });
  }

  async function endAction(e) {
    const el = e.target.closest('[data-eact]'); if (!el) return;
    const act = el.dataset.eact;
    if (act === 'highlights') showHighlights(H ? serialize() : P && P.state);
    else if (act === 'leave') leaveGame();
    else if (act === 'close') { const v = await confirmDialog({ title: 'Close this room?', body: '<p>Everyone will be disconnected and the room deleted.</p>', buttons: [{ label: 'Close Room', value: 'yes', cls: 'btn-primary' }, { label: 'Cancel', value: 'no', cls: 'btn-ghost' }], pauseTimer: false }); if (v === 'yes') closeRoom(); }
    else if (act === 'again' && H) { A.stopConfetti(); keysOf(H.teams).forEach((k) => { H.teams[k].score = 0; }); startGame(); }
    else if (act === 'lobby' && H) { A.stopConfetti(); H.phase = 'lobby'; H.round = null; H.reveal = null; H.final = null; H.history = []; computeScores(); push(); goTo('host-lobby'); renderHostLobby(); }
  }

  /* =================================================================
   * 9. WIRING
   * ================================================================= */
  function openJoin(code) {
    A.setMode('online');
    $('#join-code').value = code || $('#join-code').value || '';
    const saved = (() => { try { return JSON.parse(sessionStorage.getItem('witw.playerName') || 'null'); } catch (e) { return null; } })();
    if (saved && !$('#join-name').value) $('#join-name').value = saved;
    $('#join-error').textContent = '';
    goTo('join');
    setTimeout(() => ($('#join-code').value ? $('#join-name') : $('#join-code')).focus(), 60);
  }

  function init() {
    $('#btn-host-online').addEventListener('click', () => {
      Sound.ensure(); Sound.play('click');
      A.setMode('online');
      goTo('setup');
      toast('Set up your online game, then continue to the lobby.');
    });
    $('#btn-join-online').addEventListener('click', () => { Sound.play('click'); openJoin(); });
    $('#join-code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4); });
    $('#join-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = $('#join-code').value.trim().toUpperCase(); const name = $('#join-name').value.trim().replace(/\s+/g, ' ').slice(0, 24);
      const err = $('#join-error');
      if (!/^[A-Z]{4}$/.test(code)) { err.textContent = 'Enter the 4-letter room code from your host.'; $('#join-code').focus(); return; }
      if (!name) { err.textContent = 'Enter your name so your team knows who you are.'; $('#join-name').focus(); return; }
      err.textContent = '';
      const btn = $('#btn-join-submit'); btn.disabled = true; btn.textContent = 'Joining…';
      try { sessionStorage.setItem('witw.playerName', JSON.stringify(name)); await joinGame(code, name); }
      catch (ex) { err.textContent = ex.message; }
      finally { btn.disabled = false; btn.textContent = 'Join Game'; }
    });
    $('#host-lobby').addEventListener('click', hostLobbyAction);
    $('#host-lobby').addEventListener('change', hostLobbyAction);
    $('#screen-player').addEventListener('click', (e) => { if (e.target.id === 'pl-leave') { confirmDialog({ title: 'Leave this game?', body: '<p>You can rejoin later with the same code.</p>', buttons: [{ label: 'Leave', value: 'yes', cls: 'btn-primary' }, { label: 'Stay', value: 'no', cls: 'btn-ghost' }], pauseTimer: false }).then((v) => { if (v === 'yes') leaveGame(); }); return; } playerAction(e); });
    $('#screen-player').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'pl-country') { e.preventDefault(); playerAction({ target: $('[data-pact="country"]') }); } });
    $('#online-end').addEventListener('click', endAction);
    bindHostTools();
    populateCountryList();
    window.addEventListener('resize', () => { if (hostMap) hostMap.invalidate(); if (playerMap) playerMap.invalidate(); });

    // Deep links and resuming after a page reload
    const params = new URLSearchParams(location.search);
    const joinCode = (params.get('join') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    const savedPlayer = (() => { try { return JSON.parse(sessionStorage.getItem('witw.player') || 'null'); } catch (e) { return null; } })();
    const hostRoom = sessionStorage.getItem('witw.hostRoom');
    if (hostRoom) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-hero-alt'; b.textContent = `Resume hosting room ${hostRoom}`;
      b.addEventListener('click', () => { A.setMode('online'); resumeHosting(hostRoom); });
      $('.online-entry-actions').prepend(b);
    }
    if (savedPlayer && (!joinCode || joinCode === savedPlayer.code)) {
      A.setMode('online');
      joinGame(savedPlayer.code, savedPlayer.name).catch(() => { sessionStorage.removeItem('witw.player'); openJoin(joinCode); });
    } else if (joinCode) openJoin(joinCode);
  }

  window.WITW_ONLINE = { createRoom, joinGame, resumeHosting };
  init();
})();
