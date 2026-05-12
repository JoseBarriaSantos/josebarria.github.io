# Novelty Hunter

Novelty Hunter is a browser-based tool that takes in a PGN file that you drop, scans it, and identifies rare, (hopefully) interesting opening moves, ranked by an interest score that I designed.

## Initial disclaimers

The idea for this tool was thought of by me, José Bárria. The scoring functions were also designed entirely by me. Almost all the code was written by AI, and then I revised it, following the old 10-80-10 rule. Most of the text in this page was written by me.

## How it works

1. You upload a `.pgn` file containing chess games.
2. First the games are filtered by the desired elo you choose, then it replays moves 5–15 and queries the [Lichess Masters database](https://lichess.org/api#tag/Opening-Explorer) for each position.
3. A move is considered **rare** if gamesAfterRareMove/gamesAfterMostPopularMove < 5% from that position and has fewer than 500 follow-up games in the database. You can see more details about these things later.
4. The engine (stockfish) evaluates the position immediately after the rare move and again 5 moves later to gauge how the evaluation evolved.
5. All rare moves are scored and sorted by **Final Interest Score**, finally being displayed on Lichess' awesome Chessground Board.

---

## File structure

```
novelty-hunter/
├── index.html               # Three states: Upload, Analyzing, Viewer
├── novelty-hunter.css       # All styles
└── js/
    ├── scoring.js           # Scoring functions
    ├── analyzer.js          # PGN parsing, Lichess API, main analysis loop
    ├── ui.js                # DOM, board viewer, navigation, app state
    ├── stockfish-worker.js  # Web Worker wrapper for Stockfish UCI protocol
    ├── stockfish-18-lite-single.js   # Stockfish 18 engine (single-threaded)
    └── stockfish-18-lite-single.wasm # Stockfish 18 WASM binary
```

---

## Scoring

The heart of the tool. Here is how the scores are calculated in `scoring.js`.

### 1. Rarity Score `[0, 1]`

Measures how rare the move is in the database.

```
rarityScore = followUpScore + frequencyScore

followUpScore = min(1, 1/followUpGames)
frequencyScore = 1 − (frequency/threshold)
```

- **followUpScore** — rewards moves with very few follow-up games (approaches 1 as followUpGames → 1).
- **frequencyScore** — rewards moves further below the frequency threshold.
- **followUpGames** — How many games there are with the rare move.
- **frequency** — calculated as followUpGames/mostPopularMoveFollowUpGames as opposed to followUpGames/totalGames. This was done to heavily increase frequency numbers. For example, if we have a position where move A has 35 games, B has 35, C has 30, the normal frequency would say C has 30% frequency, but comparing with the most popular move the frequency would be 86%, thus we could immediately ditch this move.
- **frequencyThreshold** — 10% by default.

### 2. Efficiency Score `[-1, 1]`

Measures whether the rare move was any good in the game.

```
efficiencyScore = normalizedStockfish + 20% resultScore

normalizedStockfish = stockfishScore / 2
```

The **Stockfish score** is the eval change from the side that played the novelty's perspective: `(eval 5 moves later) − (eval after novelty)`. Clamped to `[−2, +2]`, since it is considered that +2 is a completely winning advantage, and normalized to `[−1, 1]`.

The **result score** is a bonus/penalty based on the game outcome:

| Who played rare move | Score | Result
|----------------------|-------|------
| White                | +1.0  | 1-0
| White                | -0.5  | 1/2
| White                | −1.0  | 0-1
| Black                | +1.0  | 0-1
| Black                | +0.5  | 1/2
| Black                | −1.0  | 1-0

Efficiency can be negative, since a rare move that led to a bad position and a loss should penalize the final interest score.

### 3. Early Novelty Score `[0, 1]`

Rewards novelties played earlier in the opening.

```
earlyNovScore = 1.0                      if moveNumber ≤ 5
earlyNovScore = (15 - moveNumber) / 10   if moveNumber > 5
```

### 4. Final Interest Score `[0, 1]`

```
interestScore = 40% earlyNovScore + 40% × efficiencyScore + 20% × rarityScore
```

Clamped to `[0, 1]`. Results are sorted by this score descending. The rarity score is of low importance because the interest score is only being calculated for moves that are already considered rare.

---

## Rarity filter

A move is only analyzed if it passes `isRare()`:

- The position must have **more than 10** total games. E.g: We have a position that has 5 games.
Move A has 3 games, B has 2 and C has 0. C shouldn't be considered rare.
- The move must have **fewer than 100** follow-up games (otherwise it's too well-known).
- The move's frequency compared to the most popular move must be **below frequency_threshold**.

---

## Dependencies

Loaded via CDN, no build step needed.

| Library | Version | Purpose |
|---|---|---|
| [Chessground](https://github.com/lichess-org/chessground) | 8.2.1 | Interactive board rendering |
| [chess.js](https://github.com/jhlywa/chess.js) | 0.10.3 | PGN parsing, move validation, FEN generation |
| [Stockfish 18](https://github.com/official-stockfish/Stockfish) | 18 (lite, single-threaded) | Engine evaluation |

---

## Requirements

### Lichess API Token

Once again kindly provided by Lichess. The Lichess explorer requires authentication. Get a free token at [lichess.org/account/oauth/token](https://lichess.org/account/oauth/token). Leave all permission scopes at their defaults (none needed).

The token is saved to `localStorage` so you only need to enter it once.

---

## Running locally

Any static file server works. For example:

```bash
python -m http.server 5500
```

Then open `http://127.0.0.1:5500/novelty-hunter/`.

> **Note:** Stockfish WASM requires `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers to be set if you want `SharedArrayBuffer` support. The lite single-threaded build used here does not require these headers.

---