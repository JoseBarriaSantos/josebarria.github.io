/**
 * Split a multi-game PGN string into individual game strings.
 */
function splitPgn(pgnText) {
  const text = pgnText.replace(/\r\n/g, "\n").trim();
  const games = text.split(/\n\n(?=\[Event )/);
  return games.filter(g => g.trim().length > 0);
}

/**
 * Extract a header value from a PGN game string.
 */
function pgnHeader(pgn, key) {
  const re = new RegExp('\\[' + key + '\\s+"([^"]*)"\\]');
  const m = pgn.match(re);
  return m ? m[1] : null;
}

/**
 * Strip comments { ... }, NAGs ($1, $2 etc), variations ( ... ),
 * and numeric annotation from PGN movetext so chess.js can parse it.
 */
function cleanPgnMovetext(pgn) {
  // Separate headers from movetext
  const lines = pgn.split("\n");
  const headerLines = [];
  let moveTextStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      headerLines.push(lines[i]);
      moveTextStart = i + 1;
    } else if (line === "") {
      // Blank line between headers and movetext
      if (moveTextStart === i) moveTextStart = i + 1;
    } else {
      break;
    }
  }

  let moveText = lines.slice(moveTextStart).join("\n");

  // Strip comments { ... } (including nested)
  moveText = moveText.replace(/\{[^}]*\}/g, "");
  // Strip variations ( ... ) — handle one level of nesting
  moveText = moveText.replace(/\([^()]*\)/g, "");
  moveText = moveText.replace(/\([^()]*\)/g, ""); // second pass for nested
  // Strip NAGs like $1, $2, etc.
  moveText = moveText.replace(/\$\d+/g, "");
  // Collapse whitespace
  moveText = moveText.replace(/\s+/g, " ").trim();

  return headerLines.join("\n") + "\n\n" + moveText;
}

/**
 * Parse a single PGN game into a list of SAN moves.
 * Uses chess.js load_pgn with fallback to manual move-by-move parsing.
 */
function parsePgnMoves(pgnString) {
  const cleaned = cleanPgnMovetext(pgnString);
  const chess = new Chess();

  // Try load_pgn first
  try {
    chess.load_pgn(cleaned, { sloppy: true });
    const h = chess.history();
    if (h && h.length > 0) {
      return h;
    }
  } catch (e) {
    // load_pgn threw — fall through to manual parsing
  }

  // Fallback: manually extract moves from movetext
  chess.reset();
  const lines = cleaned.split("\n");
  let moveText = "";
  let inHeaders = true;
  for (const line of lines) {
    const trimmed = line.trim();
    if (inHeaders && (trimmed.startsWith("[") || trimmed === "")) {
      if (!trimmed.startsWith("[")) continue;
      continue;
    }
    inHeaders = false;
    moveText += " " + trimmed;
  }

  // Remove result markers at the end
  moveText = moveText.replace(/\s*(1-0|0-1|1\/2-1\/2|\*)\s*$/, "");

  // Split into tokens and try each as a move
  const tokens = moveText.trim().split(/\s+/);
  const moves = [];
  for (const token of tokens) {
    // Skip move numbers like "1.", "12.", "1..."
    if (/^\d+\./.test(token)) {
      // Could be "1.e4" — extract move part after dots
      const afterDots = token.replace(/^\d+\.+/, "");
      if (afterDots) {
        try {
          chess.move(afterDots, { sloppy: true });
          moves.push(afterDots);
        } catch (e) { /* not a valid move */ }
      }
      continue;
    }
    // Skip result tokens
    if (token === "1-0" || token === "0-1" || token === "1/2-1/2" || token === "*") continue;
    // Try as a move
    try {
      const result = chess.move(token, { sloppy: true });
      if (result) {
        moves.push(result.san);
      }
    } catch (e) { /* skip invalid tokens */ }
  }

  return moves;
}

/**
 * Fetch Lichess Masters opening explorer data for a FEN.
 * Returns null on failure. Retries with exponential backoff on 429.
 *
 * @param {string} fen
 * @param {string} token  Lichess API token (required)
 */
async function fetchLichessMoves(fen, token) {
  const url = "https://explorer.lichess.ovh/masters?fen="
    + encodeURIComponent(fen)
    + "&topGames=0&recentGames=0";

  const headers = { "Authorization": "Bearer " + token };

  let delay = 10;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const resp = await fetch(url, { headers });
      if (resp.status === 429) {
        await sleep(delay);
        delay *= 2;
        continue;
      }
      if (!resp.ok) {
        console.warn(`API error ${resp.status} for FEN: ${fen}`);
        return null;
      }
      return await resp.json();
    } catch {
      return null;
    }
  }
  return null;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Evaluate a position using the Stockfish Web Worker.
 * Returns centipawn score (from white's POV) or null on failure.
 */
async function stockfishEval(fen, depth, sfWorker) {
  if (!sfWorker) {
    console.warn("[Stockfish] No worker provided, eval skipped");
    return null;
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      console.error(`[Stockfish] Evaluation timeout (120000ms) for fen: ${fen.substring(0, 40)}...`);
      resolve(null);
    }, 120000);

    sfWorker.onResult = (cp) => {
      clearTimeout(timeout);
      if (cp === null) {
        console.warn("[Stockfish] Evaluation returned null");
      }
      resolve(cp);
    };

    try {
      sfWorker.evaluate(fen, depth);
    } catch (err) {
      console.error("[Stockfish] Error during evaluation:", err);
      clearTimeout(timeout);
      resolve(null);
    }
  });
}

async function getStockfishScore(moves, noveltyPly, whiteToMove, sfWorker, depth = 10) {
  if (!sfWorker) {
    return { bonus: 0.0, cpAfter: null, cpLater: null };
  }

  const afterPly = noveltyPly + 1;
  const laterPly = Math.min(afterPly + 10, moves.length);
  if (laterPly === afterPly) {
    return { bonus: 0.0, cpAfter: null, cpLater: null };
  }

  try {
    // Build FEN after novelty
    const chessAfter = new Chess();
    for (let i = 0; i < afterPly; i++) {
      chessAfter.move(moves[i], { sloppy: true });
    }

    // Build FEN 10 plies later
    const chessLater = new Chess();
    for (let i = 0; i < laterPly; i++) {
      chessLater.move(moves[i], { sloppy: true });
    }

    const cpAfter = await stockfishEval(chessAfter.fen(), depth, sfWorker);
    const cpLater = await stockfishEval(chessLater.fen(), depth, sfWorker);

    if (cpAfter === null || cpLater === null) {
      console.warn("[Analysis] One of the evaluations failed, bonus = 0. After:", cpAfter, "Later:", cpLater);
      return 0.0;
    }

    // Stockfish scores are from side-to-move's perspective; normalize both to white's perspective
    const cpAfterWhite = chessAfter.turn() === 'w' ? cpAfter : -cpAfter;
    const cpLaterWhite = chessLater.turn() === 'w' ? cpLater : -cpLater;

    console.log(`cpAfter (raw): ${cpAfter}, side to move: ${chessAfter.turn()}, cpAfterWhite: ${cpAfterWhite}`)
    console.log(`cpLater (raw): ${cpLater}, side to move: ${chessLater.turn()}, cpLaterWhite: ${cpLaterWhite}`)
    console.log(`whiteToMove: ${whiteToMove}`)
    const diff = (cpLaterWhite - cpAfterWhite) / 100.0;
    const bonus = whiteToMove ? diff : -diff;
    return { bonus: Math.round(bonus * 100) / 100, cpAfter, cpLater };
  } catch (err) {
    console.error("[Analysis] Error computing Stockfish score:", err);
    return { bonus: 0.0, cpAfter: null, cpLater: null };
  }
}

/**
 * Main analysis function.
 *
 * @param {string}   pgnText    Full PGN file content
 * @param {object}   options    { minElo, target, useStockfish, token }
 * @param {function} onProgress Called with (gamesProcessed, totalGames, results)
 * @param {object}   abortCtrl  { aborted: boolean } — set aborted=true to stop
 * @param {object|null} sfWorker  Stockfish worker wrapper (or null)
 * @returns {Promise<Array>} sorted results array
 */
async function analyzeGames(pgnText, options, onProgress, abortCtrl, sfWorker) {
  const { minElo = 2400, target = 1, token = "", sfDepth = 10 } = options;
  const gamePgns = splitPgn(pgnText);
  const fenCache = new Map();
  const results = [];
  // Quick pre-count of Elo-eligible games
  let totalGames = 0;
  for (const pgn of gamePgns) {
    const wElo = parseInt(pgnHeader(pgn, "WhiteElo") || "0", 10);
    const bElo = parseInt(pgnHeader(pgn, "BlackElo") || "0", 10);
    if (wElo >= minElo && bElo >= minElo) totalGames++;
  }

  let skippedParse = 0;
  let eligibleDone = 0;

  for (let gi = 0; gi < gamePgns.length; gi++) {
    if (abortCtrl.aborted) break;
    if (results.length >= target) break;

    const pgn = gamePgns[gi];

    // Filter by Elo
    const whiteElo = parseInt(pgnHeader(pgn, "WhiteElo") || "0", 10);
    const blackElo = parseInt(pgnHeader(pgn, "BlackElo") || "0", 10);
    if (whiteElo < minElo || blackElo < minElo) {
      continue;
    }

    eligibleDone++;

    // Parse game moves (with comment stripping + fallback)
    const history = parsePgnMoves(pgn);
    if (!history || history.length === 0) {
      skippedParse++;
      if (skippedParse <= 5) {
        console.warn(`[Novelty Hunter] Failed to parse game ${gi + 1}: ${pgnHeader(pgn, "White")} vs ${pgnHeader(pgn, "Black")}`);
      }
      onProgress(eligibleDone, totalGames, results);
      continue;
    }

    // Replay the game to query positions
    const chess = new Chess();
    let inCache = true; // stays true while positions are found in cache
    for (let mi = 0; mi < history.length; mi++) {
      if (abortCtrl.aborted) break;

      const fullMoveNumber = Math.floor(mi / 2) + 1;
      if (fullMoveNumber > 15) break;

      if (fullMoveNumber <= 4) {
        chess.move(history[mi], { sloppy: true });
        continue;
      }

      const fen = chess.fen();

      let movesData;
      if (inCache && fenCache.has(fen)) {
        movesData = fenCache.get(fen);
      } else {
        inCache = false;
        await sleep(50); // Polite rate limit
        movesData = await fetchLichessMoves(fen, token);
        fenCache.set(fen, movesData);
      }

      if (!movesData || !movesData.moves || movesData.moves.length === 0) {
        break; // Position not in Masters DB — stop checking this game
      }

      const moveSan = history[mi];
      const whiteToMove = chess.turn() === "w";

      if (isRare(moveSan, movesData, 0.05, 10, 500)) {
        const noveltyPly = mi;

        // Stockfish score (if enabled)
        let sfResult = { bonus: null, cpAfter: null, cpLater: null };
        if (sfWorker) {
          sfResult = await getStockfishScore(history, noveltyPly, whiteToMove, sfWorker, sfDepth);
        }

        const info = getAllMoveInfo(
          moveSan, movesData, fullMoveNumber,
          pgnHeader(pgn, "Result") || "*",
          whiteToMove,
          sfResult.bonus
        );

        results.push({
          event: pgnHeader(pgn, "Event") || "Unknown Event",
          white: pgnHeader(pgn, "White") || "Unknown",
          white_elo: whiteElo,
          black: pgnHeader(pgn, "Black") || "Unknown",
          black_elo: blackElo,
          result: pgnHeader(pgn, "Result") || "*",
          move: moveSan,
          move_number: fullMoveNumber,
          white_to_move: whiteToMove,
          frequency: info.frequency,
          games_before: info.gamesBefore,
          games_after: info.followUpGames,
          rarity_score: info.rarityScore,
          result_score: info.resultScore,
          efficiency_score: info.efficiencyScore,
          early_nov_score: info.earlyNovScore,
          interest_score: info.interestScore,
          stockfish_score: info.stockfishScore,
          eval_after: sfResult.cpAfter,
          eval_later: sfResult.cpLater,
          novelty_ply: noveltyPly,
          game_pgn: pgn,
          moves: history,
        });

        break; // Only first rare move per game
      }

      chess.move(history[mi], { sloppy: true });
    }

    onProgress(eligibleDone, totalGames, results);
  }

  results.sort((a, b) => b.interest_score - a.interest_score);
  return results;
}
