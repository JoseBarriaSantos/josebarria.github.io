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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const resp = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timer);
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
      clearTimeout(timer);
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
async function stockfishEval(fen, depth, sfWorker, onDepth) {
  if (!sfWorker) {
    console.warn("[Stockfish] No worker provided, eval skipped");
    return null;
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      console.error(`[Stockfish] Evaluation timeout (120000ms) for fen: ${fen.substring(0, 40)}...`);
      resolve(null);
    }, 120000);

    sfWorker.onDepth = onDepth || null;
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

async function getStockfishScore(moves, noveltyPly, whiteToMove, sfWorker, depth = 10, afterLabel, laterLabel, onDepthUpdate, onAfterEvalDone) {
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

    const cpAfter = await stockfishEval(chessAfter.fen(), depth, sfWorker,
      onDepthUpdate && afterLabel ? (d) => onDepthUpdate(afterLabel, d) : null);
    onAfterEvalDone?.();
    const cpLater = await stockfishEval(chessLater.fen(), depth, sfWorker,
      onDepthUpdate && laterLabel ? (d) => onDepthUpdate(laterLabel, d) : null);

    if (cpAfter === null || cpLater === null) {
      console.warn("[Analysis] One of the evaluations failed, bonus = 0. After:", cpAfter, "Later:", cpLater);
      return 0.0;
    }

    // Stockfish scores are from side-to-move's perspective; normalize both to white's perspective
    const cpAfterWhite = chessAfter.turn() === 'w' ? cpAfter : -cpAfter;
    const cpLaterWhite = chessLater.turn() === 'w' ? cpLater : -cpLater;

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
function gameContainsPosition(pgn, fenPrefix, centerPly = 20) {
  const startPly = Math.max(0, centerPly - 20);
  const endPly = centerPly + 20;
  const movetext = pgn
    .replace(/\[.*?\]\s*/gm, "")
    .replace(/\{[^}]*\}/g, "")
    .replace(/\([^()]*\)/g, "").replace(/\([^()]*\)/g, "")
    .replace(/\$\d+/g, "");
  const chess = new Chess();
  let ply = 0;
  for (const token of movetext.split(/\s+/)) {
    if (ply > endPly) break;
    if (!token || /^\d+\.+/.test(token) || token === "1-0" || token === "0-1" || token === "1/2-1/2" || token === "*") continue;
    if (ply >= startPly && chess.fen().split(" ").slice(0, 2).join(" ") === fenPrefix) return true;
    if (chess.move(token, { sloppy: true })) ply++;
  }
  return ply >= startPly && chess.fen().split(" ").slice(0, 2).join(" ") === fenPrefix;
}

async function analyzeGames(pgnText, options, onProgress, abortCtrl, sfWorker, onStatus) {
  const { minEloWhite = 2400, minEloBlack = 2400, target = 1, token = "", sfDepth = 10, excludeKeywords = [], concurrency = 12, filterFen = null, filterCenterPly = 20, colorFilter = null } = options;

  onStatus?.("Parsing games...");
  await sleep(0);
  const gamePgns = splitPgn(pgnText);

  onStatus?.("Filtering by Elo...");
  await sleep(0);
  let eligibleGames = gamePgns.filter(pgn => {
    const wElo = parseInt(pgnHeader(pgn, "WhiteElo") || "0", 10);
    const bElo = parseInt(pgnHeader(pgn, "BlackElo") || "0", 10);
    if (wElo < minEloWhite || bElo < minEloBlack) return false;
    if (excludeKeywords.length > 0) {
      const event = (pgnHeader(pgn, "Event") || "").toLowerCase();
      if (excludeKeywords.some(k => event.includes(k))) return false;
    }
    return true;
  });

  if (filterFen) {
    const filtered = [];
    const scanStart = performance.now();
    let lastYield = performance.now();
    for (let i = 0; i < eligibleGames.length; i++) {
      if (abortCtrl.aborted) break;
      if (performance.now() - lastYield > 16) {
        await sleep(0);
        lastYield = performance.now();
      }
      const pct = eligibleGames.length > 0 ? Math.round((i / eligibleGames.length) * 100) : 0;
      let eta = "";
      if (i > 5) {
        const elapsed = (performance.now() - scanStart) / 1000;
        const remaining = Math.round((eligibleGames.length - i) * elapsed / i);
        eta = remaining < 60 ? ` ~${remaining}s left` : ` ~${Math.ceil(remaining / 60)} min left`;
      }
      onStatus?.("Filtering by opening... " + i + "/" + eligibleGames.length + eta, pct);
      if (gameContainsPosition(eligibleGames[i], filterFen, filterCenterPly)) filtered.push(eligibleGames[i]);
    }
    eligibleGames = filtered;
  }

  const totalGames = eligibleGames.length;
  const fenCache = new Map();
  const results = [];
  let eligibleDone = 0;
  let skippedParse = 0;
  let cacheHits = 0;
  let cacheMisses = 0;

  async function processGame(pgn) {
    const whiteElo = parseInt(pgnHeader(pgn, "WhiteElo") || "0", 10);
    const blackElo = parseInt(pgnHeader(pgn, "BlackElo") || "0", 10);

    const history = parsePgnMoves(pgn);
    if (!history || history.length === 0) {
      skippedParse++;
      if (skippedParse <= 5) {
        console.warn(`[Novelty Hunter] Failed to parse game: ${pgnHeader(pgn, "White")} vs ${pgnHeader(pgn, "Black")}`);
      }
      return null;
    }

    const chess = new Chess();
    for (let mi = 0; mi < history.length; mi++) {
      if (abortCtrl.aborted) return null;

      const fullMoveNumber = Math.floor(mi / 2) + 1;
      if (fullMoveNumber > 15) break;

      if (fullMoveNumber <= 4) {
        chess.move(history[mi], { sloppy: true });
        continue;
      }

      const fen = chess.fen();
      const whiteToMove = chess.turn() === "w";

      if (colorFilter && ((whiteToMove && !colorFilter.white) || (!whiteToMove && !colorFilter.black))) {
        chess.move(history[mi], { sloppy: true });
        continue;
      }

      if (!fenCache.has(fen)) {
        cacheMisses++;
        fenCache.set(fen, fetchLichessMoves(fen, token));
      } else {
        cacheHits++;
      }
      const movesData = await fenCache.get(fen);

      if (!movesData || !movesData.moves || movesData.moves.length === 0) {
        break;
      }

      const moveSan = history[mi];

      if (isRare(moveSan, movesData, 0.05, 10, 100)) {
        const noveltyPly = mi;

        const sfResult = { bonus: null, cpAfter: null, cpLater: null };

        const info = getAllMoveInfo(
          moveSan, movesData, fullMoveNumber,
          pgnHeader(pgn, "Result") || "*",
          whiteToMove,
          sfResult.bonus
        );

        return {
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
        };
      }

      chess.move(history[mi], { sloppy: true });
    }

    return null;
  }

  onProgress(0, totalGames, []);

  const startTime = performance.now();
  let gameIndex = 0;

  async function worker() {
    while (gameIndex < eligibleGames.length && !abortCtrl.aborted && results.length < target) {
      const pgn = eligibleGames[gameIndex++];
      const result = await processGame(pgn);
      eligibleDone++;
      if (result) results.push(result);
      onProgress(eligibleDone, totalGames, results);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));

  const elapsedMs = performance.now() - startTime;
  const elapsedMin = (elapsedMs / 60000).toFixed(2);
  const msPerGame = (elapsedMs / totalGames).toFixed(0);
  // console.log(`[Timing] Total: ${elapsedMin} min | Per game: ${msPerGame} ms | Games: ${totalGames}`);
  // console.log(`[Cache] Hits: ${cacheHits}, Misses: ${cacheMisses}, Hit rate: ${(cacheHits / (cacheHits + cacheMisses) * 100).toFixed(1)}%`);

  results.sort((a, b) => b.interest_score - a.interest_score);
  return results;
}

async function evaluateWithStockfish(results, sfWorker, sfDepth, onProgress, onDepthUpdate, abortCtrl) {
  const total = results.length * 2;
  for (let i = 0; i < results.length; i++) {
    if (abortCtrl.aborted) break;
    const r = results[i];
    onProgress(i * 2, total, r, false);

    // Compute notation labels for the two positions being evaluated
    const nPly = r.novelty_ply;
    const afterPly = nPly + 1;
    const laterPly = Math.min(afterPly + 10, r.moves.length);
    const nMoveNum = Math.floor(nPly / 2) + 1;
    const nIsWhite = nPly % 2 === 0;
    const afterLabel = `${nMoveNum}.${nIsWhite ? "" : "..."}${r.moves[nPly]}`;
    const lIdx = laterPly - 1;
    const lMoveNum = Math.floor(lIdx / 2) + 1;
    const lIsWhite = lIdx % 2 === 0;
    const laterLabel = lIdx >= 0 && lIdx < r.moves.length
      ? `${lMoveNum}.${lIsWhite ? "" : "..."}${r.moves[lIdx]}`
      : afterLabel;

    const sfResult = await getStockfishScore(
      r.moves, r.novelty_ply, r.white_to_move, sfWorker, sfDepth,
      afterLabel, laterLabel,
      onDepthUpdate ? (label, d) => onDepthUpdate(r, label, d) : null,
      () => onProgress(i * 2 + 1, total, r, false)
    );
    const bonus = sfResult && typeof sfResult === "object" ? sfResult.bonus : null;

    if (bonus !== null && bonus !== undefined) {
      r.stockfish_score = bonus;
      r.eval_after = sfResult.cpAfter;
      r.eval_later = sfResult.cpLater;
      r.efficiency_score = computeEfficiencyScore(r.result, r.white_to_move, bonus);
      r.interest_score = computeInterestScore(r.rarity_score, r.efficiency_score, r.early_nov_score);
    }

    onProgress(i * 2 + 2, total, r, true);
  }

  results.sort((a, b) => b.interest_score - a.interest_score);
  return results;
}
