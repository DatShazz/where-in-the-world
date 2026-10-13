# Where in the World?
### The Global Culture and Connection Challenge

A two-team, game-show-style activity for workplace groups. Teams study a clue (text, photo or sound), share what they know from home, family, travel, food, music or pure deduction, and drop a pin on a real world map. Each round ends with a reveal and a short **Cultural Spotlight**.

It works for a 5-minute meeting opener up to a 30-minute (or custom) culture and connection session, in person or screen-shared in Teams or Zoom.

---

## 1. Quick start — works fully offline

1. Copy the whole `where-in-the-world` folder (keep the structure intact).
2. Double-click **`index.html`**. It opens in your default browser (current Chrome, Edge, Firefox or Safari).
3. Press **Play**.

**No internet connection is needed.** Everything is stored locally:

| What | Where | Notes |
|---|---|---|
| Map library | `assets/vendor/leaflet/` | Leaflet 1.9.4 |
| Country boundaries | `assets/map/countries.js` | Natural Earth 1:50m v5.1.2 |
| Clue photos (31) | `assets/images/` | Licence-checked, saved locally |
| All sounds | generated in `game.js` | Web Audio synthesis, so there are no audio files |
| Fonts and icons | system fonts + inline SVG clip art | No web fonts |

Only the optional “Sources” links on reveal screens need the internet.

**If your organisation blocks pages opened from files**, run the optional local server (needs Node.js):

```bash
node tools/serve.js
```

Then open http://localhost:8080.

---

## 1b. Online play — 2 to 6 teams on their own devices (needs internet)

Live at **https://datshazz.github.io/where-in-the-world/**.

**Host (facilitator)**
1. Open the game, then click **Host an online game**.
2. Choose the session length and options, and set **Teams to start with (1–6)**.
3. Continue past the rules. You'll get a 4-letter room code and a join link to share in your meeting chat.
4. In the lobby you can:
   - **+ Add team** or **Remove team**. A removed team's players move to "Not in a team".
   - Rename teams, and move or remove players.
   - **Shuffle players into teams**, appoint a leader, or use **Let fate pick missing leaders**.
   - **Play on this device too**, which opens your own player screen in a new tab, so you can play solo or join a team yourself.
5. Click **Start Game** once at least one team has a player and every team with players has a leader. Empty teams are removed automatically.
6. Mid-game, **Teams & Players** on the toolbar lets you add or remove teams, move players and appoint leaders. New teams join from the next round; a removed team's points are removed.
7. Screen-share the host screen. It shows the clue, the timer, each team's status (*Thinking…*, *Pin placed…*, *Locked ✓*) and the reveal.

**Players**
1. Open the join link, or the website, then **Join a game**. Enter the code and a name.
2. Pick a team.
3. Choose a leader in one of three ways:
   - **Unanimous vote:** everyone votes for the same teammate.
   - **Volunteer:** "I'll lead"; a teammate can object.
   - **Let fate decide:** the game picks someone at random.
4. Each round, everyone sees the clue on their own device. Teammates tap the map to drop **suggestion pins** that only their team sees. The **leader** places the official pin, picks a confidence rating and locks in.

**How it differs from the one-screen game**
- All teams guess **at the same time** during the 60 seconds, and pins stay hidden until the reveal.
- **Scoring:**
  - 3 points for the correct country.
  - If any team is correct, the incorrect guesses score 1.
  - Otherwise the closest guess scores 2 (ties share it) and the others score 1.
  - No pin scores 0.
  - With two teams this matches the House Rules exactly.
  - **One team (solo):** 3 for the correct country, 2 within 1,000 km of the answer, 1 further away. The final score is shown out of the maximum possible.
- **When the timer ends,** a leader's placed pin is locked automatically.
- **A tie for first** sends only the tied teams to Expert Sudden Death, with the same tie-break chain as the one-screen game.
- **If the host's page reloads,** use **Resume hosting room XXXX** on the start screen. Players who reload rejoin automatically.
- **Closing the room** deletes it from the database. Players are told the game has ended.

**Solo on one screen (offline):** press **Play**, and on the Teams screen tick **Play solo**. One person or one group plays every round with the same solo scoring.

**Behind the scenes:** online play uses a free Google Firebase project (`where-in-the-world-44d5d`) for live syncing:
- **Realtime Database in Singapore:** carries the game between devices.
- **Anonymous sign-in:** players join without accounts.
- **Settings:** connection settings are in `online-config.js`, and the access rules are in `database.rules.json`, already published. For example, only a team's leader can write that team's pin, and other teams can't read it.
- **Data stored:** only player first names or nicknames and game moves, and only until the host closes the room.
- **Network:** players' networks must allow `*.firebasedatabase.app` and `*.googleapis.com`.

---

## 2. Facilitating

| Session | Pick | Rounds (auto) |
|---|---|---|
| Meeting opener | 5 min — Quick Icebreaker | 2 |
| Icebreaker | 10 min — Team Energiser | 4 |
| Energiser | 15 min — Meeting Challenge | 6 |
| Extended | 20 min — Extended Challenge | 8 |
| Team building | 25 min — Standard Game | 9 |
| Culture session | 30 min — Culture & Connection | 11 |
| Anything else | Custom (3–120 min) | calculated |

**How rounds are calculated:** each round is estimated at 160 seconds (145 without spotlights): two 60-second turns, 10 s clue introduction, 5 s handover, 10 s reveal and 15 s Cultural Spotlight. You can override the number before starting.

**Flow:** Intro → Setup → House Rules → Teams → Starting page → rounds (Team 1 turn → hidden handover → Team 2 turn → reveal) → winner and “Your World Journey”.

**Tips for screen-sharing**
- Share the browser window and use full-screen (F11) for the biggest map.
- In Teams or Zoom, tick *Share sound* / *Share computer audio* so participants hear the effects.
- The handover screen hides the map between turns, so Team 2 never sees Team 1’s pin.
- Invite people with lived experience of a culture to add to the Cultural Spotlight. They are the real experts.

### Facilitator toolbar
Pause / Resume Timer · Reset Timer · End Turn · Reset Team’s Guess (a locked-in team retakes its turn) · Reset Current Round (removes that round’s points, same question) · Skip Question · Reveal Answer · End Game Early. The top bar has About, Credits, Soundboard, Settings (volumes, sound mode, reduced motion) and Mute.

### Keyboard
- Everything is reachable with Tab, Enter and Space.
- On the map: arrow keys pan, `+` / `−` zoom, then press **Drop pin at map centre**.
- Or type a country into the list box and press **Place pin**.
- Shortcuts when not typing: `L` lock in, `P` pause/resume, `M` mute. Optional soundboard shortcuts use `Shift`+number.

---

## 3. Scoring (also shown on the House Rules screen)

| Points | Condition |
|---|---|
| 3 | Pin inside the correct country (all accepted countries for shared traditions) |
| 2 | Incorrect, but the closer of the two guesses; both get 2 at an identical rounded distance |
| 1 | Incorrect and further away, or incorrect when the other team found the correct country |
| 0 | No guess locked in |

- A lone incorrect guess counts as the closer guess (2 points).
- When time runs out, a placed pin is auto-locked.
- Points are recorded once per round and are derived from round history, so they can never be double-awarded. Resetting a round removes its points.
- **Fairness for coasts and islands:** a pin in the sea within 50 km of the answer marker, or within 25 km of the correct coastline, counts as correct.
- **Distance:** great-circle (haversine) distance to the answer marker, rounded to the nearest kilometre.
- **Ties:** a level final score triggers Expert Sudden Death from 12 reserved questions, and the closest pin wins. After a second exact tie, the winner is decided by correct-country count, then by average main-game distance, then by facilitator choice (joint winners or another Expert question). The end screen always explains how the winner was decided.
- **Session time:** warnings show at 5, 2 and 1 minutes. When time is up, the game never cuts off a round: you choose **Finish This Round** or **End Game Now**. Unfinished rounds never count.

---

## 4. Sound

All audio is original and synthesised at runtime. There are no recordings, voices, TV themes or branded sounds. A compressor/limiter, a voice cap and anti-spam protection stop sounds from stacking up loudly.

| Mode | What you get |
|---|---|
| Professional | Timer, lock-in, reveal and applause only; a 4-button soundboard |
| Fun | Crowd and confidence reactions; the full 22-button soundboard |
| Chaotic | Fun plus extra layering (still workplace-safe) |
| Custom | Toggle 8 sound categories in Settings |

Preferences are remembered for the browser session. The game is fully playable muted, and every sound has a visual equivalent (timer ring, toasts, on-screen text).

**Audio clues:** 7 sound rounds have a written description that is always shown. Seven questions offer a *synthesised impression*, clearly labelled as such: kora, valiha, talking drum, đàn bầu, candombe and coquí frog, plus the steelpan photo round. The whistled-language round (Silbo Gomero) is description-only. To use real licensed recordings, put the file in `assets/audio/` and add `audio: 'assets/audio/yourfile.mp3'` to the question. If a file is missing, the game falls back to the impression or the description.

---

## 5. Content

- **110 main questions**: 11 per category, 15 Medium / 76 Hard / 19 Expert. Spread across Africa (24), Asia (20), Europe (16), South America (11), Oceania & Pacific (10), Caribbean (8), Middle East (8), Central America (7) and North America (6).
- **12 reserved Expert tie-breakers**, never used in normal rounds.
- **Clue formats**: 30 photo, 7 sound and 73 text rounds. Text rounds use an illustrated clip-art clue card.
- Every question has an explanation, cultural significance, a memorable fact, origin nuance where relevant, and sources. The source URLs were checked automatically (`SOURCES.md`).
- **Shared or disputed origins accept several countries**, for example Ethiopia/Eritrea (injera), Cuba/Mexico (guayabera) and Bolivia/Peru (charango), and the reveal explains why.
- **Question selection**: no repeats within a game, no more than two consecutive questions from the same category, varied regions and countries. Previously played questions are deprioritised using local storage when available; the game works without it.
- **Review status**: internal review against sources. Before high-profile use, we recommend a review by people from the communities represented.

### Images
31 photos come from Wikimedia Commons. Each file’s licence was read from its own page (CC0, public domain, CC BY or CC BY-SA). Each was visually checked for identifiable people, brands, captions and watermarks; one was cropped to remove a product box. Files have neutral names (`q056-clue.jpg`) so they don’t reveal answers.

If an image is missing or images are switched off, the game shows the clip-art card plus a written description, so the round is still playable.

**Using your own clip art or photos:** save the file as `assets/images/<question id>-clue.jpg`, add its details to `tools/image-candidates.json`, set the question’s `type: 'image'` and `alt` text, then run `node tools/build-registers.js`.

---

## 6. Files

```
index.html            Page structure (all screens and dialogs)
styles.css            Visual design, responsive layout, focus and reduced-motion styles
game.js               Game engine (audio, map, scoring, timers, flow, soundboard)
online.js / online.css  Online multi-device play (lobby, leaders, realtime rounds)
online-config.js      Firebase project settings (public identifiers)
database.rules.json   Firebase security rules (published in the Firebase console)
questions.js          Question bank, editable (format documented at the top of the file)
questions.json        Full-schema export of the bank (generated)
assets/map/           Natural Earth country data (generated from tools/)
assets/images/        Clue photos + image-credits.js (generated)
assets/audio/         Optional licensed audio files (empty by default)
assets/vendor/leaflet Leaflet library + licence
ATTRIBUTION.md        Human-readable asset register (generated)
asset-register.json   Machine-readable asset register (generated)
SOURCES.md            Factual-source register (generated)
tools/                build-map.js, build-registers.js, curate-images.js, commons-search.js, serve.js
```

### Adding or editing questions
1. Edit `questions.js`. Add an object to `MAIN` or `TIEBREAKERS`; no game logic changes are needed.
2. Use Natural Earth `ADM0_A3` codes for `codes`. For example, France is `FRA`, Kosovo is `KOS`, and Greenland and Puerto Rico are their own shapes (`GRL`, `PRI`).
3. Run:

```bash
node tools/build-registers.js --check-urls
```

This validates IDs, country codes, that the answer marker lies inside an accepted country, image files and source links, and regenerates the registers.

---

## 7. About the map
Boundaries come from **Natural Earth Admin 0 – Countries, 1:50m, v5.1.2** (public domain). Natural Earth follows a documented de facto policy; boundary and territory representations vary with legal and political perspective, so this map is not presented as neutral or authoritative. Coastlines are simplified at this scale. Some display names were updated to current official short names (e.g., Timor-Leste, Côte d’Ivoire, Czechia, Türkiye, Cabo Verde).

---

## 8. Quality assurance performed
Tested in a Chromium browser:

- **Flow:** intro → setup → rules → teams → start → game → reveal → end.
- **Setup:** duration presets and auto-rounds (2/4/6/8/9/11); custom-duration validation; manual round override.
- **Teams:** random names and rerolls; a very long team name (truncated in the scorebar, wrapped elsewhere).
- **Turns:** Team 1’s pin is hidden from Team 2; confidence is required before locking in; pins can be placed from the map or the country list; Pause/Resume works; a timeout auto-locks a placed pin.
- **Scoring:** correct (3) vs. other team (1); a lone guess (2/0); neither team submitting (0/0, with a replay option).
- **Facilitator tools:** Reset Current Round removes awarded points; Skip Question; Reveal Answer with pending turns; End Game Early with the tie prompt.
- **Sudden Death:** two exact ties lead to the correct-count, then average-proximity tie-breaks, and to joint winners when everything is level.
- **Restarts:** Play Again keeps team names and resets scores; Restart Entire Game clears everything.
- **Sound:** all 22 soundboard sounds, Stop All Sounds, the Professional board and mute.
- **Data:** no console errors; the build validator passes all 122 questions; all 154 source URLs resolve.

Not tested in this build: Safari, touch devices and screen readers beyond structural checks. Please do a dry run on your presentation machine before a live session.
