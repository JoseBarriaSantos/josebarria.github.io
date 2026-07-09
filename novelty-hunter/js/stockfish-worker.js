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
    onResult: null,
    onDepth: null,
    loading: false,
    loaded: false,

    async init() {
      if (worker) return;
      wrapper.loading = true;

      try {
        worker = new Worker("js/stockfish-18-lite-single.js");

        worker.onerror = (err) => {
          console.error("[Stockfish] Worker error:", err);
        };

        worker.onmessage = (e) => {
          const line = typeof e.data === "string" ? e.data : e.data.toString();

          if (line === "uciok") {
            worker.postMessage("setoption name Use NNUE value true");
            worker.postMessage("isready");
          }
          if (line === "readyok") {
            ready = true;
            wrapper.loading = false;
            wrapper.loaded = true;
            if (readyResolve) { readyResolve(); readyResolve = null; }
          }

          if (line.startsWith("info")) {
            const dm = line.match(/\bdepth (\d+)/);
            if (dm && wrapper.onDepth) wrapper.onDepth(parseInt(dm[1], 10));
          }

          // Parse "info depth N ... score cp X" or "score mate X"
          if (line.includes(" score cp ")) {
            const cpMatch = line.match(/score cp (-?\d+)/);
            if (cpMatch) {
              wrapper._lastCp = parseInt(cpMatch[1], 10);
            }
          }
          if (line.includes(" score mate ")) {
            const mateMatch = line.match(/score mate (-?\d+)/);
            if (mateMatch) {
              const mateIn = parseInt(mateMatch[1], 10);
              wrapper._lastCp = mateIn > 0 ? 5000 : -5000;
            }
          }

          // When bestmove arrives, deliver the result
          if (line.startsWith("bestmove") && wrapper.onResult) {
            wrapper.onDepth = null;
            wrapper.onResult(wrapper._lastCp ?? null);
          }
        };

        worker.postMessage("uci");
        await readyPromise;
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

      wrapper._lastCp = null;
      worker.postMessage("position fen " + fen);
      worker.postMessage("go depth " + depth);
    },

    terminate() {
      if (worker) {
        worker.postMessage("quit");
        worker.terminate();
        worker = null;
        ready = false;
      }
    }
  };

  return wrapper;
}
