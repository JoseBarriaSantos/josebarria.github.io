# Novelty Hunter — Project Handoff

## What this is

A browser-based chess tool at `josebarria.com/novelty-hunter/`. The user sets up an opening position, selects a time period, and the tool downloads recent top-level tournament games (from TWIC), scans them for rare opening moves in that position, evaluates them with Stockfish, and ranks by interest score. Entirely static — no backend.

## Owner

José Bárria — chess International Master (2374 Elo, working toward GM), MSc Software Engineering at IST Lisbon. GitHub: JoseBarriaSantos. Email: ze.guilherme.santos@gmail.com.

## File structure

```
novelty-hunter/
├── index.html               # All three app states: Upload, Analyzing, Viewer
├── novelty-hunter.css       # All styles
└── js/
    ├── lichess-auth.js      # OAuth 2.0 PKCE flow for Lichess login
    ├── twic-fetcher.js      # Downloads TWIC zip files via Cloudflare Worker proxy
    ├── scoring.js           # Score calculation functions (rarity, efficiency, interest)
    ├── analyzer.js          # PGN parsing, Lichess API queries, main analysis loop, SF phase 2
    ├── ui.js                # All UI logic, state, board viewer, accordion, settings
    ├── stockfish-worker.js  # Web Worker wrapper for Stockfish UCI, includes onDepth callback
    ├── stockfish-18-lite-single.js   # Stockfish 18 engine (single-threaded)
    └── stockfish-18-lite-single.wasm # Stockfish 18 WASM binary
```

## Architecture / flow

1. **Upload screen** — user sets up opening (mini Chessground board), picks time period (stepper: 1–4 weeks or 1–12 months), chooses color (white/black/both), connects Lichess account via OAuth PKCE.
2. **Phase 1 analysis** — downloads TWIC zip(s) via Cloudflare Worker proxy → unzips with JSZip → `splitPgn` → ELO filter → position pre-filter (checks FEN within ±10 moves of setup position) → concurrent Lichess Masters API queries (concurrency=12) to find rare moves → `onProgress` updates progress bar.
3. **Phase 2 (optional, Stockfish)** — if enabled, runs a SEPARATE progress bar. Evaluates each found novelty at the position after the move and 10 plies later. Shows "position after 13.Ne4 (depth 18/30)" in real time. Updates list items with red→yellow→green color based on `efficiency_score`.
4. **Viewer** — Chessground board, arrow key navigation, sidebar with scores, Export PGNs button.

## Key infrastructure

### Cloudflare Worker (proxy)
URL: `https://novelty-hunter-proxy.ze-guilherme-santos.workers.dev`  
Defined in `TWIC_PROXY` constant in `twic-fetcher.js`.  
Serves two endpoints:
- `/{issueNumber}` — proxies `theweekinchess.com/zips/twic{N}g.zip` with CORS headers
- `/latest` — fetches TWIC archive HTML page, parses out the highest issue number, returns `{ issue: N }` as JSON

This worker must exist for downloads to work. The owner has it deployed on their Cloudflare account.

### Lichess OAuth
PKCE flow — no client secret needed. `CLIENT_ID = "novelty-hunter"`. Token stored in `localStorage` under `nh_lichess_token`. Used to query `https://explorer.lichess.ovh/masters`.

## Settings persistence
All user settings saved to `localStorage` under `nh_settings` (JSON):
- `periodAmount`, `periodUnit` (weeks/months)
- `minEloWhite`, `minEloBlack`
- `sfEnabled`, `sfDepth`
- `excludeKeywords`
- `filterMoves`, `filterPly` (opening board position)
- `colorWhite`, `colorBlack`

## Scoring system

- **Rarity score [0,1]**: `followUpScore + frequencyScore` where followUpScore = `min(1, 10/followUpGames)`, frequencyScore = `1 - (freq/threshold)`. threshold=10%, followUpGames < 100.
- **Efficiency score [-1,1]**: based on Stockfish eval change over 10 plies + game result bonus. Negative = bad novelty.
- **Early novelty score [0,1]**: `1.0` if move ≤ 5, `(15-move)/10` otherwise.
- **Interest score [0,1]**: weighted combination. See `scoring.js` and `getAllMoveInfo`.

## UI structure

Settings panel uses an **accordion** system with smooth height-based CSS transitions (not max-height). Each section uses `openAccordion(btn, content, onDone)` / `closeAccordion(btn, content)` in `ui.js`. Only one section open at a time. Opening section initialized lazily (Chessground board created after transition ends so coordinate mapping is correct).

Accordion sections in order:
1. Select opening (optional) — mini Chessground board, notation, ±10 move FEN window filter
2. Select time period — stepper + Weeks/Months unit buttons + Custom PGN button
3. Select color — White/Black checkboxes (both checked by default)
4. Connect Lichess account — OAuth login/logout
5. More options (minor button) — Min White/Black Elo, Stockfish toggle + depth, exclude keywords

## Code style rules (IMPORTANT)
- **No README updates** — the user maintains README.md themselves, never touch it
- **Minimal comments** — one short line max, never multi-line comment blocks
- **No em dashes** (`—`) in text
- Don't change text content when moving it around in the DOM

## Known state / recent work
- Two-phase analysis: Phase 1 finds novelties (fast, no SF), Phase 2 runs Stockfish (separate progress bar with real-time depth counter per position)
- Stockfish worker exposes `onDepth` callback that fires on every `info depth N` UCI line
- `evaluateWithStockfish` computes notation labels for both evaluated positions (`afterLabel`, `laterLabel`) and threads them through to the UI
- Position filter uses ±10 full moves window around the setup position (`filterCenterPly`)
- All settings persisted to localStorage on every change
- Export PGNs button in the viewer (bottom left of board column)
- Score color in phase 2 list: red=−1, yellow=0, green=+1 based on `efficiency_score` (range −1 to 1)

## Deployment
Static site on GitHub Pages. Domain: `josebarria.com`. CNAME file in repo root. Push to `main` branch deploys automatically. `.gitignore` excludes `.claude/` (tooling config, no secrets).

## What is safe to push (open source)
- `TWIC_PROXY` URL — safe, public endpoint, no auth
- `CLIENT_ID = "novelty-hunter"` — safe, PKCE has no client secret
- Web3Forms `access_key` in root `index.html` — safe, client-side form key by design
- Lichess token — never in code, only ever in user's browser localStorage
