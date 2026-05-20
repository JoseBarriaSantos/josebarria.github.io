(async function () {
  "use strict";

  const _cbToken = await lichessAuth.handleCallback();
  if (_cbToken) lichessAuth.saveToken(_cbToken);

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
  let sourceMode = "twic";
  let periodAmount = 1;
  let periodUnit = "weeks";
  let filterMoves = [];
  let filterPly = 0;
  let filterBoardInst = null;
  let sfRunEnabled = false;

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
  const uploadError = $("#upload-error");
  const authLoggedOut = $("#auth-logged-out");
  const authLoggedIn = $("#auth-logged-in");
  const authUsernameDisplay = $("#auth-username-display");

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

  function updateAnalyzeBtn() {
    const hasToken = !!lichessAuth.getToken();
    analyzeBtn.disabled = !hasToken || (sourceMode === "custom" && !pgnText);
  }

  async function updateAuthUI() {
    const token = lichessAuth.getToken();
    const loggedIn = !!token;
    if (authLoggedOut) authLoggedOut.hidden = loggedIn;
    if (authLoggedIn) authLoggedIn.hidden = !loggedIn;
    if (loggedIn && authUsernameDisplay) {
      const username = await lichessAuth.getUsername(token);
      if (username) {
        authUsernameDisplay.textContent = username;
      } else {
        lichessAuth.clearToken();
        if (authLoggedOut) authLoggedOut.hidden = false;
        if (authLoggedIn) authLoggedIn.hidden = true;
      }
    }
    const tokenBtn = document.querySelector('[data-target="acc-token"]');
    if (tokenBtn) tokenBtn.classList.toggle("filter-active", loggedIn);
    updateAnalyzeBtn();
  }

  // ── Period stepper ───────────────────────────────────────────
  function updateStepper() {
    const max = periodUnit === "weeks" ? 4 : 12;
    const valueEl = document.getElementById("period-value");
    const decBtn = document.getElementById("period-dec");
    const incBtn = document.getElementById("period-inc");
    if (valueEl) valueEl.textContent = periodAmount;
    if (decBtn) decBtn.disabled = periodAmount <= 1;
    if (incBtn) incBtn.disabled = periodAmount >= max;
  }

  document.getElementById("period-dec")?.addEventListener("click", () => {
    if (periodAmount > 1) { periodAmount--; updateStepper(); saveSettings(); }
  });

  document.getElementById("period-inc")?.addEventListener("click", () => {
    const max = periodUnit === "weeks" ? 4 : 12;
    if (periodAmount < max) { periodAmount++; updateStepper(); saveSettings(); }
  });

  document.querySelectorAll(".unit-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".unit-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      periodUnit = btn.dataset.unit;
      const max = periodUnit === "weeks" ? 4 : 12;
      periodAmount = Math.min(periodAmount, max);
      updateStepper();
      sourceMode = "twic";
      dropzone.hidden = true;
      document.getElementById("custom-pgn-btn")?.classList.remove("active");
      updateAnalyzeBtn();
      saveSettings();
    });
  });

  document.getElementById("custom-pgn-btn")?.addEventListener("click", () => {
    document.getElementById("custom-pgn-btn").classList.add("active");
    sourceMode = "custom";
    dropzone.hidden = false;
    updateAnalyzeBtn();
    if (uploadError) { uploadError.hidden = true; uploadError.textContent = ""; }
  });

  // ── Upload state logic ───────────────────────────────────────
  function handleFile(file) {
    if (!file || !file.name.toLowerCase().endsWith(".pgn")) return;
    fileName.textContent = file.name;
    const reader = new FileReader();
    reader.onload = () => {
      pgnText = reader.result;
      if (sourceMode === "custom") updateAnalyzeBtn();
    };
    reader.readAsText(file);
  }

  // Grey out depth input when engine is disabled
  const stockfishToggle = $("#stockfish-toggle");
  const sfDepthInput = $("#sf-depth");
  stockfishToggle.addEventListener("change", () => {
    sfDepthInput.disabled = !stockfishToggle.checked;
    saveSettings();
  });
  sfDepthInput.addEventListener("change", () => saveSettings());

  $("#min-elo-white")?.addEventListener("change", () => saveSettings());
  $("#min-elo-black")?.addEventListener("change", () => saveSettings());
  document.getElementById("color-white")?.addEventListener("change", () => saveSettings());
  document.getElementById("color-black")?.addEventListener("change", () => saveSettings());

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
  keywordsContainer.addEventListener("input", () => saveSettings());

  // Auth handlers
  $("#lichess-login-btn")?.addEventListener("click", () => lichessAuth.startLogin());
  $("#lichess-logout-btn")?.addEventListener("click", async () => {
    lichessAuth.clearToken();
    await updateAuthUI();
  });

  // Accordion sections
  function openAccordion(btn, content, onDone) {
    btn.classList.add("open");
    content.style.height = content.scrollHeight + "px";
    content.addEventListener("transitionend", () => {
      if (btn.classList.contains("open")) {
        content.style.height = "auto";
        onDone?.();
      }
    }, { once: true });
  }

  function closeAccordion(btn, content) {
    btn.classList.remove("open");
    content.style.height = content.scrollHeight + "px";
    content.offsetHeight; // force reflow so browser registers the explicit height
    content.style.height = "0";
  }

  document.querySelectorAll(".accordion-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const content = document.getElementById(btn.dataset.target);
      if (!content) return;
      const opening = !btn.classList.contains("open");

      let hadOpen = false;
      document.querySelectorAll(".accordion-btn").forEach(other => {
        if (other === btn || !other.classList.contains("open")) return;
        hadOpen = true;
        closeAccordion(other, document.getElementById(other.dataset.target));
      });

      if (opening) {
        setTimeout(() => {
          openAccordion(btn, content, () => {
            if (btn.dataset.target === "acc-opening") { initFilterBoard(); filterRefresh(); }
          });
        }, hadOpen ? 50 : 0);
      } else {
        closeAccordion(btn, content);
      }
    });
  });

  // ── Position filter board ────────────────────────────────────
  function filterChessAt(ply) {
    const c = new Chess();
    for (let i = 0; i < ply; i++) c.move(filterMoves[i], { sloppy: true });
    return c;
  }

  function filterGetFen() {
    return filterChessAt(filterPly).fen().split(" ").slice(0, 2).join(" ");
  }

  function filterRefresh() {
    if (!filterBoardInst) return;
    const chess = filterChessAt(filterPly);
    const turn = chess.turn() === "w" ? "white" : "black";
    const dests = new Map();
    for (const m of chess.moves({ verbose: true })) {
      if (!dests.has(m.from)) dests.set(m.from, []);
      dests.get(m.from).push(m.to);
    }
    let lastMove = null;
    if (filterPly > 0) {
      const prev = filterChessAt(filterPly - 1);
      const m = prev.move(filterMoves[filterPly - 1]);
      if (m) lastMove = [m.from, m.to];
    }
    filterBoardInst.set({ fen: chess.fen(), turnColor: turn, movable: { free: false, color: "both", dests }, lastMove });

    // Render notation
    const notEl = document.getElementById("filter-notation");
    if (notEl) {
      let html = "";
      for (let i = 0; i < filterMoves.length; i++) {
        if (i % 2 === 0) html += `<span class="filter-mv-num">${i / 2 + 1}. </span>`;
        const cur = i === filterPly - 1 ? " filter-mv-current" : i >= filterPly ? " filter-mv-future" : "";
        html += `<span class="filter-mv${cur}" data-ply="${i + 1}">${filterMoves[i]}</span> `;
      }
      notEl.innerHTML = html;
      notEl.querySelectorAll(".filter-mv").forEach(s =>
        s.addEventListener("click", () => filterGoTo(parseInt(s.dataset.ply)))
      );
    }

    const prevBtn = document.getElementById("filter-prev");
    const nextBtn = document.getElementById("filter-next");
    if (prevBtn) prevBtn.disabled = filterPly <= 0;
    if (nextBtn) nextBtn.disabled = filterPly >= filterMoves.length;

    const toggleBtn = document.querySelector('[data-target="acc-opening"]');
    if (toggleBtn) toggleBtn.classList.toggle("filter-active", filterPly > 0);
    saveSettings();
  }

  function filterGoTo(ply) {
    if (ply < 0 || ply > filterMoves.length) return;
    filterPly = ply;
    filterRefresh();
  }

  function initFilterBoard() {
    if (filterBoardInst) return;
    const chess = new Chess();
    const dests = new Map();
    for (const m of chess.moves({ verbose: true })) {
      if (!dests.has(m.from)) dests.set(m.from, []);
      dests.get(m.from).push(m.to);
    }
    filterBoardInst = Chessground(document.getElementById("filter-board"), {
      movable: {
        free: false,
        color: "both",
        dests,
        events: {
          after: (orig, dest) => {
            const chess = filterChessAt(filterPly);
            const move = chess.move({ from: orig, to: dest, promotion: "q" });
            if (!move) { filterRefresh(); return; }
            filterMoves = filterMoves.slice(0, filterPly);
            filterMoves.push(move.san);
            filterPly++;
            filterRefresh();
          },
        },
      },
      animation: { enabled: true, duration: 100 },
      coordinates: false,
    });
  }

  const filterPrevBtn = document.getElementById("filter-prev");
  const filterNextBtn = document.getElementById("filter-next");
  const filterClearBtn = document.getElementById("filter-clear");
  if (filterPrevBtn) filterPrevBtn.addEventListener("click", () => filterGoTo(filterPly - 1));
  if (filterNextBtn) filterNextBtn.addEventListener("click", () => filterGoTo(filterPly + 1));
  if (filterClearBtn) filterClearBtn.addEventListener("click", () => {
    filterMoves = []; filterPly = 0; filterRefresh();
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
    const token = lichessAuth.getToken();
    if (!token) {
      alert("Please connect your Lichess account first.");
      return;
    }

    const minEloWhite = parseInt($("#min-elo-white").value, 10) || 2400;
    const minEloBlack = parseInt($("#min-elo-black").value, 10) || 2400;
    const target = Infinity;
    const useSf = $("#stockfish-toggle").checked;
    const sfDepth = parseInt($("#sf-depth").value, 10) || 10;
    const excludeKeywords = Array.from(document.querySelectorAll(".exclude-keyword"))
      .map(el => el.value.trim().toLowerCase())
      .filter(k => k.length > 0);

    showState(analyzeSec);
    progressFill.style.width = "0%";
    progressText.textContent = "Preparing...";
    foundMoves.innerHTML = "";
    abortCtrl = { aborted: false };
    const thisRun = abortCtrl;
    results = [];
    sfRunEnabled = false;

    // Step 1: Get PGN text (from TWIC or uploaded file)
    let pgnToAnalyze = pgnText;

    if (sourceMode !== "custom") {
      const issueCount = periodUnit === "weeks" ? periodAmount : periodAmount * 4;
      progressText.textContent = "Fetching games from TWIC...";
      try {
        pgnToAnalyze = await fetchTwicGames(issueCount, (msg, pct) => {
          if (thisRun.aborted) return;
          progressText.textContent = msg;
          if (pct !== undefined) progressFill.style.width = pct + "%";
        });
      } catch (err) {
        showState(uploadSec);
        if (uploadError) {
          uploadError.textContent = err.message;
          uploadError.hidden = false;
        }
        return;
      }
    }

    if (!pgnToAnalyze) return;

    progressFill.style.width = "0%";
    progressText.textContent = "Preparing analysis...";

    // Phase 1: Find novelties (no engine)
    sfWorker = null;
    let analysisStartTime = null;
    const onProgress = (done, total, currentResults) => {
      if (thisRun.aborted) return;
      if (done === 0) analysisStartTime = performance.now();
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      progressFill.style.width = pct + "%";
      let eta = "";
      if (done > 2 && analysisStartTime) {
        const elapsed = (performance.now() - analysisStartTime) / 1000;
        const remaining = Math.round((total - done) * elapsed / done);
        eta = remaining < 60 ? ` ~${remaining}s left` : ` ~${Math.ceil(remaining / 60)} min left`;
      }
      progressText.textContent =
        `Analyzing game ${done} / ${total}...  Found ${currentResults.length} rare move${currentResults.length !== 1 ? "s" : ""}${eta}`;
      foundMoves.innerHTML = "";
      for (const r of currentResults) {
        const div = document.createElement("div");
        div.className = "found-move-item";
        const prefix = r.white_to_move ? "" : "...";
        div.textContent = `${r.white} vs ${r.black} — ${r.move_number}.${prefix}${r.move} (interest: ${r.interest_score.toFixed(2)})`;
        foundMoves.appendChild(div);
      }
    };

    const filterFen = filterPly > 0 ? filterGetFen() : null;
    const filterCenterPly = filterPly;
    const colorWhite = document.getElementById("color-white")?.checked ?? true;
    const colorBlack = document.getElementById("color-black")?.checked ?? true;
    const colorFilter = { white: colorWhite || (!colorWhite && !colorBlack), black: colorBlack || (!colorWhite && !colorBlack) };
    try {
      results = await analyzeGames(pgnToAnalyze, { minEloWhite, minEloBlack, target, token, sfDepth, excludeKeywords, filterFen, filterCenterPly, colorFilter }, onProgress, abortCtrl, null, (msg, pct) => {
        if (thisRun.aborted) return;
        progressText.textContent = msg;
        if (pct !== undefined) progressFill.style.width = pct + "%";
      });
    } catch (err) {
      progressText.textContent = "Error: " + err.message;
      return;
    }

    if (results.length === 0) {
      progressText.textContent = "No novelties found. Try selecting a larger time period or adjust settings.";
      return;
    }

    // Phase 2: Stockfish evaluation
    if (useSf && !thisRun.aborted) {
      progressFill.style.width = "0%";
      progressText.textContent = "Loading Stockfish engine...";
      sfWorker = createStockfishWorker();
      try { await sfWorker.init(); }
      catch (err) {
        console.error("[App] Stockfish init failed:", err);
        sfWorker = null;
        progressText.textContent = "Engine unavailable. Showing results without evaluation.";
        await sleep(1500);
      }

      if (sfWorker && !thisRun.aborted) {
        sfRunEnabled = true;
        progressFill.style.width = "0%";
        foundMoves.innerHTML = "";
        results.forEach((r, idx) => {
          const div = document.createElement("div");
          div.className = "found-move-item";
          div.id = "sf-item-" + idx;
          const prefix = r.white_to_move ? "" : "...";
          div.textContent = `${r.white} vs ${r.black} — ${r.move_number}.${prefix}${r.move} (interest: ${r.interest_score.toFixed(2)})`;
          foundMoves.appendChild(div);
        });

        // ~0.5 * 1.15^depth seconds per position (single-threaded WASM browser benchmark)
        const secsPerPos = Math.max(1, Math.round(0.7 * Math.pow(1.15, sfDepth)));
        let countdownSecs = results.length * 2 * secsPerPos;
        let sfLabel = "";
        const sfPhaseStart = performance.now();

        function fmtEta(s) {
          s = Math.max(0, Math.round(s));
          return s < 60 ? `~${s}s left` : `~${Math.ceil(s / 60)} min left`;
        }
        function updateSfText() {
          progressText.textContent = sfLabel
            ? `${sfLabel} ${fmtEta(countdownSecs)}`
            : `Evaluating ${results.length} novelties with Stockfish ${fmtEta(countdownSecs)}`;
        }

        updateSfText();
        const countdownInterval = setInterval(() => {
          if (thisRun.aborted) { clearInterval(countdownInterval); return; }
          countdownSecs = Math.max(0, countdownSecs - 1);
          updateSfText();
        }, 1000);

        try {
          await evaluateWithStockfish(results, sfWorker, sfDepth,
            (i, total, r, done) => {
              if (!thisRun.aborted) {
                progressFill.style.width = Math.round((i / total) * 100) + "%";
                if (i > 0) {
                  const elapsed = (performance.now() - sfPhaseStart) / 1000;
                  countdownSecs = Math.round((total - i) * (elapsed / i));
                }
              }
              if (done) {
                const completedIdx = i / 2 - 1;
                const div = document.getElementById("sf-item-" + completedIdx);
                if (div) {
                  const prefix = r.white_to_move ? "" : "...";
                  div.textContent = `${r.white} vs ${r.black} — ${r.move_number}.${prefix}${r.move} (interest: ${r.interest_score.toFixed(2)})`;
                  div.style.borderLeftColor = scoreToColor(r.efficiency_score);
                }
                if (viewerSec.classList.contains("active") && completedIdx === gameIdx) {
                  $("#info-efficiency-score").textContent = r.efficiency_score.toFixed(2);
                  $("#info-interest-score").textContent = r.interest_score.toFixed(2);
                  const warn = document.getElementById("sf-pending-warn");
                  if (warn) warn.hidden = true;
                }
              }
            },
            (r, posLabel, depth) => {
              if (thisRun.aborted) return;
              sfLabel = `Analyzing ${r.white} vs ${r.black}, position after ${posLabel} (depth ${depth}/${sfDepth})`;
              updateSfText();
            },
            abortCtrl);
        } catch (err) {
          console.error("[SF Phase 2]", err);
        }
        clearInterval(countdownInterval);
        sfWorker.terminate();
        sfRunEnabled = false;
        const warn = document.getElementById("sf-pending-warn");
        if (warn) warn.hidden = true;
      }
    }

    initViewer();
  });

  stopBtn.addEventListener("click", () => {
    abortCtrl.aborted = true;
    if (results.length > 0) {
      initViewer();
    } else {
      showState(uploadSec);
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
    const sfWarn = document.getElementById("sf-pending-warn");
    if (sfWarn) sfWarn.hidden = !(sfRunEnabled && r.eval_after === null);

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
    const tag = document.activeElement.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;

    const filterOpen = document.getElementById("acc-opening")?.classList.contains("open");
    if (filterOpen && uploadSec.classList.contains("active")) {
      if (e.key === "ArrowLeft")  { e.preventDefault(); filterGoTo(filterPly - 1); }
      if (e.key === "ArrowRight") { e.preventDefault(); filterGoTo(filterPly + 1); }
      return;
    }

    if (!viewerSec.classList.contains("active")) return;
    if (e.key === "ArrowRight") { e.preventDefault(); nextMove(); }
    if (e.key === "ArrowLeft")  { e.preventDefault(); prevMove(); }
    if (e.key === "ArrowDown")  { e.preventDefault(); nextGame(); }
    if (e.key === "ArrowUp")    { e.preventDefault(); prevGame(); }
  });

  document.getElementById("export-pgn-btn")?.addEventListener("click", () => {
    const pgns = results.map(r => r.game_pgn).filter(Boolean).join("\n\n");
    const blob = new Blob([pgns], { type: "application/x-chess-pgn" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "novelty-hunter-games.pgn";
    a.click();
    URL.revokeObjectURL(url);
  });

  // ── Beforeunload warning during analysis ─────────────────────
  window.addEventListener("beforeunload", (e) => {
    if (analyzeSec.classList.contains("active")) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  // ── Settings persistence ──────────────────────────────────────
  function saveSettings() {
    try {
      const kws = Array.from(document.querySelectorAll(".exclude-keyword"))
        .map(el => el.value.trim()).filter(k => k.length > 0);
      localStorage.setItem("nh_settings", JSON.stringify({
        periodAmount, periodUnit,
        minEloWhite: $("#min-elo-white")?.value,
        minEloBlack: $("#min-elo-black")?.value,
        sfEnabled: $("#stockfish-toggle")?.checked,
        sfDepth: $("#sf-depth")?.value,
        excludeKeywords: kws,
        filterMoves, filterPly,
        colorWhite: document.getElementById("color-white")?.checked,
        colorBlack: document.getElementById("color-black")?.checked,
      }));
    } catch {}
  }

  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem("nh_settings") || "null");
      if (!s) return;

      if (s.periodAmount) periodAmount = Math.max(1, parseInt(s.periodAmount));
      if (s.periodUnit === "weeks" || s.periodUnit === "months") {
        periodUnit = s.periodUnit;
        document.querySelectorAll(".unit-btn").forEach(b =>
          b.classList.toggle("active", b.dataset.unit === periodUnit));
      }
      updateStepper();

      if (s.minEloWhite) { const el = $("#min-elo-white"); if (el) el.value = s.minEloWhite; }
      if (s.minEloBlack) { const el = $("#min-elo-black"); if (el) el.value = s.minEloBlack; }

      if (s.sfEnabled !== undefined) {
        const tog = $("#stockfish-toggle");
        if (tog) { tog.checked = s.sfEnabled; sfDepthInput.disabled = !s.sfEnabled; }
      }
      if (s.sfDepth) { const el = $("#sf-depth"); if (el) el.value = s.sfDepth; }

      if (s.excludeKeywords?.length) {
        const container = $("#exclude-keywords");
        if (container) {
          const inputs = container.querySelectorAll(".exclude-keyword");
          s.excludeKeywords.forEach((kw, i) => {
            if (i === 0 && inputs[0]) {
              inputs[0].value = kw;
            } else {
              const inp = document.createElement("input");
              inp.type = "text"; inp.className = "exclude-keyword"; inp.value = kw;
              container.appendChild(inp);
            }
          });
        }
      }

      if (s.filterMoves?.length) {
        filterMoves = s.filterMoves;
        filterPly = Math.min(s.filterPly ?? filterMoves.length, filterMoves.length);
        const openBtn = document.querySelector('[data-target="acc-opening"]');
        if (openBtn) openBtn.classList.add("filter-active");
      }

      const cw = document.getElementById("color-white");
      const cb = document.getElementById("color-black");
      if (cw && s.colorWhite !== undefined) cw.checked = s.colorWhite;
      if (cb && s.colorBlack !== undefined) cb.checked = s.colorBlack;
    } catch {}
  }

  loadSettings();
  updateAuthUI();

  // ── Score colour (red → yellow → green) ──────────────────────
  function scoreToColor(score) {
    const s = Math.max(-1, Math.min(1, score));
    let r, g;
    if (s <= 0) {
      const t = s + 1; // 0 at -1, 1 at 0
      r = 255; g = Math.round(t * 210);
    } else {
      const t = s; // 0 at 0, 1 at +1
      r = Math.round(255 * (1 - t)); g = Math.round(210 + t * 45);
    }
    return `rgb(${r},${g},0)`;
  }

  // ── Tooltip portal ────────────────────────────────────────────
  document.querySelectorAll(".tooltip-anchor").forEach(anchor => {
    let tip = null;
    anchor.addEventListener("mouseenter", () => {
      const text = anchor.getAttribute("data-tooltip");
      if (!text) return;
      tip = document.createElement("div");
      tip.className = "tooltip-portal";
      tip.textContent = text;
      document.body.appendChild(tip);
      const r = anchor.getBoundingClientRect();
      const tr = tip.getBoundingClientRect();
      let top = r.bottom + 7;
      let left = r.left;
      if (left + tr.width > window.innerWidth - 10) left = window.innerWidth - tr.width - 10;
      if (top + tr.height > window.innerHeight - 10) top = r.top - tr.height - 7;
      tip.style.top = top + "px";
      tip.style.left = left + "px";
    });
    anchor.addEventListener("mouseleave", () => { tip?.remove(); tip = null; });
  });

})();
