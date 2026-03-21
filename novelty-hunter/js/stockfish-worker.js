/**
 * Create a Stockfish worker wrapper.
 * Returns an object with { evaluate(fen, depth), terminate(), onResult }.
 * Call evaluate() and set onResult to receive the centipawn score.
 */
function createStockfishWorker() {
  let worker = null;
  let ready = false;
  let readyResolve = null;
  const readyPromise = new Promise(r => { readyResolve = r; });

  const wrapper = {
    onResult: null,  // Set by caller before each evaluate()
    loading: false,
    loaded: false,

    async init() {
      if (worker) return;
      wrapper.loading = true;

      try {
        console.log("[Stockfish] Loading SF 18 NNUE (lite, single-threaded)...");
        worker = new Worker("js/stockfish-18-lite-single.js");

        worker.onerror = (err) => {
          console.error("[Stockfish] Worker error:", err);
        };

        worker.onmessage = (e) => {
          const line = typeof e.data === "string" ? e.data : e.data.toString();

          if (line === "uciok") {
            console.log("[Stockfish] UCI handshake complete, configuring NNUE...");
            worker.postMessage("setoption name Use NNUE value true");
            worker.postMessage("isready");
          }
          if (line === "readyok") {
            console.log("[Stockfish] Engine ready for analysis");
            ready = true;
            wrapper.loading = false;
            wrapper.loaded = true;
            if (readyResolve) { readyResolve(); readyResolve = null; }
          }

          // Parse "info depth N ... score cp X" or "score mate X"
          if (line.startsWith("bestmove")) {
            console.log(`[Stockfish] Best move received: ${line}, score: ${wrapper._lastCp} cp`);
          }
          if (line.includes(" score cp ")) {
            const cpMatch = line.match(/score cp (-?\d+)/);
            if (cpMatch) {
              wrapper._lastCp = parseInt(cpMatch[1], 10);
              console.log(`[Stockfish] Centipawn score: ${wrapper._lastCp}, depth: ${line.match(/depth (\d+)/)?.[1] || "?"}`);
            }
          }
          if (line.includes(" score mate ")) {
            const mateMatch = line.match(/score mate (-?\d+)/);
            if (mateMatch) {
              const mateIn = parseInt(mateMatch[1], 10);
              wrapper._lastCp = mateIn > 0 ? 5000 : -5000;
              console.log(`[Stockfish] Mate in ${mateIn}, score: ${wrapper._lastCp}`);
            }
          }

          // When bestmove arrives, deliver the result
          if (line.startsWith("bestmove") && wrapper.onResult) {
            wrapper.onResult(wrapper._lastCp ?? null);
          }
        };

        worker.postMessage("uci");
        await readyPromise;
        console.log("[Stockfish] Initialization complete");
      } catch (err) {
        console.error("[Stockfish] Initialization failed:", err);
        wrapper.loading = false;
        wrapper.loaded = false;
        throw err;
      }
    },

    async evaluate(fen, depth) {
      if (!worker) {
        console.warn("[Stockfish] Worker not initialized, initializing...");
        await wrapper.init();
      }
      if (!ready) {
        console.warn("[Stockfish] Waiting for ready state...");
        await readyPromise;
      }

      console.log(`[Stockfish] Starting analysis: depth=${depth}, fen=${fen.substring(0, 40)}...`);
      wrapper._lastCp = null;
      worker.postMessage("position fen " + fen);
      worker.postMessage("go depth " + depth);
    },

    terminate() {
      if (worker) {
        console.log("[Stockfish] Terminating worker");
        worker.postMessage("quit");
        worker.terminate();
        worker = null;
        ready = false;
      }
    }
  };

  return wrapper;
}
