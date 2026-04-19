(function () {
  "use strict";

  // ── State ────────────────────────────────────────────────────
  let results = [];
  let gameIdx = 0;
  let currentPly = 0;
  let noveltyPly = 0;
  let moves = [];   // SAN array for current game
  let board = null; // chessboard2 instance
  let chess = null; // chess.js instance for replaying positions
  let sfWorker = null;
  let abortCtrl = { aborted: false };

  // ── DOM refs ─────────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);

  const uploadSec = $("#upload-section");
  const analyzeSec = $("#analyzing-section");
  const viewerSec = $("#viewer-section");

  // Upload
  const dropzone = $("#dropzone");
  const fileInput = $("#file-input");
  const fileName = $("#file-name");
  const analyzeBtn = $("#analyze-btn");

  // Analyzing
  const progressFill = $("#progress-fill");
  const progressText = $("#progress-text");
  const foundMoves = $("#found-moves");
  const stopBtn = $("#stop-btn");

  // Viewer
  const gameLabel = $("#game-label");
  const moveLabel = $("#move-label");

  let pgnText = null;

  // ── App state switching ──────────────────────────────────────
  function showState(section) {
    [uploadSec, analyzeSec, viewerSec].forEach(s => s.classList.remove("active"));
    section.classList.add("active");
  }

  // ── Upload state logic ───────────────────────────────────────
  function handleFile(file) {
    if (!file || !file.name.toLowerCase().endsWith(".pgn")) return;
    fileName.textContent = file.name;
    const reader = new FileReader();
    reader.onload = () => {
      pgnText = reader.result;
      analyzeBtn.disabled = false;
    };
    reader.readAsText(file);
  }

  // Grey out depth input when engine is disabled
  const stockfishToggle = $("#stockfish-toggle");
  const sfDepthInput = $("#sf-depth");
  stockfishToggle.addEventListener("change", () => {
    sfDepthInput.disabled = !stockfishToggle.checked;
  });

  // Dynamic keyword inputs
  const keywordsContainer = $("#exclude-keywords");
  const MAX_KEYWORDS = 6;
  keywordsContainer.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const inputs = keywordsContainer.querySelectorAll(".exclude-keyword");
    if (inputs.length >= MAX_KEYWORDS) { e.target.blur(); return; }
    if (!e.target.value.trim()) return;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "exclude-keyword";
    keywordsContainer.appendChild(input);
    input.focus();
  });

  // More settings toggle
  $("#more-settings-btn").addEventListener("click", () => {
    const panel = $("#more-settings");
    const hidden = panel.hasAttribute("hidden");
    const btn = $("#more-settings-btn");
    if (hidden) {
      panel.removeAttribute("hidden");
      btn.innerHTML = 'Less settings <span class="more-settings-arrow">▴</span>';
    } else {
      panel.setAttribute("hidden", "");
      btn.innerHTML = 'More settings <span class="more-settings-arrow">▾</span>';
    }
  });

  dropzone.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => handleFile(fileInput.files[0]));

  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("drag-over");
  });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag-over"));
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("drag-over");
    handleFile(e.dataTransfer.files[0]);
  });

  // ── Analyze ──────────────────────────────────────────────────
  analyzeBtn.addEventListener("click", async () => {
    if (!pgnText) return;

    const token = $("#lichess-token").value.trim();
    if (!token) {
      alert("Please enter your Lichess API token.");
      return;
    }

    const minElo = parseInt($("#min-elo").value, 10) || 2400;
    const target = Infinity;
    const useSf = $("#stockfish-toggle").checked;
    const sfDepth = parseInt($("#sf-depth").value, 10) || 10;
    const excludeKeywords = Array.from(document.querySelectorAll(".exclude-keyword"))
      .map(el => el.value.trim().toLowerCase())
      .filter(k => k.length > 0);
    // Save token to localStorage so user doesn't need to re-enter it
    try { localStorage.setItem("nh_lichess_token", token); } catch { }

    showState(analyzeSec);
    progressFill.style.width = "0%";
    progressText.textContent = "Preparing...";
    foundMoves.innerHTML = "";
    abortCtrl = { aborted: false };

    // Init Stockfish if requested
    sfWorker = null;
    if (useSf) {
      progressText.textContent = "Loading Stockfish engine...";
      sfWorker = createStockfishWorker();
      try {
        await sfWorker.init();
      } catch (err) {
        console.error("[App] Stockfish initialization failed:", err);
        progressText.textContent = "Warning: Engine analysis unavailable. Continuing without Stockfish...";
        await sleep(2000);
        sfWorker = null;
      }
    }

    const onProgress = (done, total, currentResults) => {
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      progressFill.style.width = pct + "%";
      progressText.textContent =
        `Analyzing game ${done} / ${total}...  Found ${currentResults.length} rare move${currentResults.length !== 1 ? "s" : ""}`;

      // Show found moves as they come in
      foundMoves.innerHTML = "";
      for (const r of currentResults) {
        const div = document.createElement("div");
        div.className = "found-move-item";
        const prefix = r.white_to_move ? "" : "...";
        div.textContent = `${r.white} vs ${r.black} — ${r.move_number}.${prefix}${r.move} (interest: ${r.interest_score.toFixed(2)})`;
        foundMoves.appendChild(div);
      }
    };

    try {
      results = await analyzeGames(pgnText, { minElo, target, token, sfDepth, excludeKeywords }, onProgress, abortCtrl, sfWorker);
    } catch (err) {
      progressText.textContent = "Error: " + err.message;
      return;
    }

    if (sfWorker) sfWorker.terminate();

    if (results.length === 0) {
      progressText.textContent = "No rare moves found. Try a different PGN or lower settings.";
      return;
    }

    initViewer();
  });

  stopBtn.addEventListener("click", () => {
    abortCtrl.aborted = true;
    // Show whatever we found so far
    if (results.length > 0) {
      initViewer();
    } else {
      progressText.textContent = "Stopped. No rare moves found yet.";
    }
  });

  // ── Viewer ───────────────────────────────────────────────────
  function initViewer() {
    showState(viewerSec);

    // Create Chessground instance (only once)
    if (!board) {
      try {
        board = Chessground(document.getElementById("board"), {
          fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
          coordinates: true,
          animation: { enabled: true, duration: 150 },
          drawable: { enabled: false },
          movable: {
            free: false,
            color: "white",
            events: {
              after: (orig, dest) => {
                // If the user's move matches the next game move, advance
                if (currentPly < moves.length) {
                  const tmpChess = new Chess(chess.fen());
                  const moveObj = tmpChess.move(moves[currentPly]);
                  if (moveObj && moveObj.from === orig && moveObj.to === dest) {
                    currentPly++;
                    updateBoard();
                    return;
                  }
                }
                // Otherwise snap back
                updateBoard();
              },
            },
          },
        });
      } catch (err) {
        console.error("[Chessground] Failed to initialize:", err);
        throw err;
      }
    }

    chess = new Chess();
    loadGame(0);
  }

  function loadGame(idx) {
    gameIdx = idx;
    const r = results[idx];
    moves = r.moves;
    noveltyPly = r.novelty_ply;

    // Start right after the novelty so the highlight shows immediately
    currentPly = Math.min(noveltyPly + 1, moves.length);

    gameLabel.textContent = `Game ${idx + 1} / ${results.length}`;

    // Sidebar
    const resultMap = {
      "1-0": "White wins (1-0)",
      "0-1": "Black wins (0-1)",
      "1/2-1/2": "Draw (\u00bd-\u00bd)",
      "*": "Ongoing / unknown"
    };

    const prefix = r.white_to_move ? "" : "...";
    const rareStr = `${r.move_number}.${prefix}${r.move}`;

    $("#info-event").textContent = r.event;
    $("#info-white").textContent = `${r.white} (${r.white_elo})`;
    $("#info-black").textContent = `${r.black} (${r.black_elo})`;
    $("#info-result").textContent = resultMap[r.result] || r.result;
    $("#info-rare-move").textContent = rareStr;
    $("#info-frequency").textContent = (r.frequency * 100).toFixed(0) + "%";
    $("#info-games-before").textContent = r.games_before ?? "N/A";
    $("#info-games-after").textContent = r.games_after ?? "Not in DB";
    $("#info-rarity-score").textContent = r.rarity_score.toFixed(2);
    $("#info-efficiency-score").textContent = r.efficiency_score.toFixed(2);
    $("#info-early-nov-score").textContent = r.early_nov_score.toFixed(2);
    $("#info-interest-score").textContent = r.interest_score.toFixed(2);

    updateBoard();
  }

  function getLegalDests() {
    const dests = new Map();
    const validMoves = chess.moves({ verbose: true });
    for (const m of validMoves) {
      if (!dests.has(m.from)) dests.set(m.from, []);
      dests.get(m.from).push(m.to);
    }
    return dests;
  }

  function updateBoard() {
    // Replay moves to current ply
    chess.reset();
    for (let i = 0; i < currentPly; i++) {
      chess.move(moves[i]);
    }
    const turn = chess.turn() === "w" ? "white" : "black";
    board.set({
      fen: chess.fen(),
      turnColor: turn,
      movable: {
        free: false,
        color: turn,
        dests: getLegalDests(),
      },
    });

    // Highlight novelty squares (if at novelty ply)
    if (currentPly === noveltyPly + 1 && noveltyPly < moves.length) {
      // Get the from/to squares of the novelty move
      const tmpChess = new Chess();
      for (let i = 0; i < noveltyPly; i++) {
        tmpChess.move(moves[i]);
      }
      const moveObj = tmpChess.move(moves[noveltyPly]);
      if (moveObj) {
        board.set({ lastMove: [moveObj.from, moveObj.to] });
      }
    } else {
      board.set({ lastMove: null });
    }

    updateMoveLabel();
  }

  function plyToNotation(ply, movesArr) {
    const san = movesArr[ply - 1];
    const moveNum = Math.ceil(ply / 2);
    const prefix = ply % 2 === 1 ? `${moveNum}.` : `${moveNum}...`;
    return `${prefix}${san}`;
  }

  function updateMoveLabel() {
    if (currentPly === 0) {
      moveLabel.textContent = "Start position";
      return;
    }

    const marker = currentPly === noveltyPly + 1 ? "  \u2605" : "";
    moveLabel.textContent = `Move ${plyToNotation(currentPly, moves)}${marker}`;
  }

  // ── Navigation ───────────────────────────────────────────────
  function nextMove() {
    if (currentPly < moves.length) { currentPly++; updateBoard(); }
  }
  function prevMove() {
    if (currentPly > 0) { currentPly--; updateBoard(); }
  }
  function nextGame() {
    if (gameIdx < results.length - 1) loadGame(gameIdx + 1);
  }
  function prevGame() {
    if (gameIdx > 0) loadGame(gameIdx - 1);
  }

  // Navigation via keyboard only (arrow keys handled below)

  document.addEventListener("keydown", (e) => {
    // Only handle keys when viewer is active
    if (!viewerSec.classList.contains("active")) return;
    if (e.key === "ArrowRight") { e.preventDefault(); nextMove(); }
    if (e.key === "ArrowLeft") { e.preventDefault(); prevMove(); }
    if (e.key === "ArrowDown") { e.preventDefault(); nextGame(); }
    if (e.key === "ArrowUp") { e.preventDefault(); prevGame(); }
  });

  // ── Beforeunload warning during analysis ─────────────────────
  window.addEventListener("beforeunload", (e) => {
    if (analyzeSec.classList.contains("active")) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  // ── Restore saved token ────────────────────────────────────────
  try {
    const saved = localStorage.getItem("nh_lichess_token");
    if (saved) $("#lichess-token").value = saved;
  } catch { }

})();
