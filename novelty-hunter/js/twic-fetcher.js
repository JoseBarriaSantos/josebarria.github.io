"use strict";

// Set this to your Cloudflare Worker URL after deploying.
const TWIC_PROXY = "https://novelty-hunter-proxy.ze-guilherme-santos.workers.dev";

class TwicCorsError extends Error {
  constructor() {
    super("TWIC download failed. Direct access was blocked and no proxy is configured.");
    this.name = "TwicCorsError";
  }
}

// Updated anchor: TWIC issue 1625 ~ 2025-01-06
const _ANCHOR_ISSUE = 1625;
const _ANCHOR_MS = new Date("2025-01-06").getTime();

function _estimateCurrentIssue() {
  const weeks = Math.floor((Date.now() - _ANCHOR_MS) / (7 * 24 * 60 * 60 * 1000));
  return _ANCHOR_ISSUE + weeks;
}

function _twicZipUrl(issueNum) {
  if (TWIC_PROXY) {
    return TWIC_PROXY.replace(/\/$/, "") + "/" + issueNum;
  }
  return "https://theweekinchess.com/zips/twic" + issueNum + "g.zip";
}

async function _probeIssueExists(issueNum) {
  try {
    const resp = await fetch(_twicZipUrl(issueNum), { method: "HEAD" });
    return resp.ok;
  } catch (err) {
    if (err instanceof TypeError) throw new TwicCorsError();
    throw err;
  }
}

async function _findLatestIssue(onStatus) {
  try {
    const raw = localStorage.getItem("nh_twic_latest");
    if (raw) {
      const { issue, ts } = JSON.parse(raw);
      if (issue && Date.now() - ts < 6 * 60 * 60 * 1000) return issue;
    }
  } catch {}

  let n = _estimateCurrentIssue();
  onStatus?.("Checking current TWIC issue...", 0);

  let exists = await _probeIssueExists(n);

  if (exists) {
    for (let i = 0; i < 20; i++) {
      if (!await _probeIssueExists(n + 1)) break;
      n++;
    }
  } else {
    let found = false;
    for (let i = 0; i < 60; i++) {
      n--;
      onStatus?.("Checking TWIC issue #" + n + "...", 0);
      if (await _probeIssueExists(n)) { found = true; break; }
    }
    if (!found) throw new Error("Could not determine the current TWIC issue number.");
  }

  try {
    localStorage.setItem("nh_twic_latest", JSON.stringify({ issue: n, ts: Date.now() }));
  } catch {}

  return n;
}

// startPct and rangePct define this issue's slice of the 0-100 progress bar.
async function _downloadIssue(issueNum, onStatus, startPct, rangePct) {
  onStatus?.("Downloading TWIC issue #" + issueNum + "...", startPct);

  let resp;
  try {
    resp = await fetch(_twicZipUrl(issueNum));
  } catch (err) {
    if (err instanceof TypeError) throw new TwicCorsError();
    throw err;
  }
  if (!resp.ok) throw new Error("TWIC issue #" + issueNum + " returned HTTP " + resp.status);

  const downloadShare = rangePct * 0.65;
  const extractShare  = rangePct * 0.35;

  // Stream download with byte-level progress
  const contentLength = parseInt(resp.headers.get("Content-Length") || "0", 10);
  let buf;
  if (contentLength > 0 && resp.body) {
    const reader = resp.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      const pct = startPct + Math.round((received / contentLength) * downloadShare);
      onStatus?.("Downloading TWIC issue #" + issueNum + "...", pct);
    }
    const arr = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) { arr.set(chunk, offset); offset += chunk.length; }
    buf = arr.buffer;
  } else {
    buf = await resp.arrayBuffer();
  }

  const extractStart = startPct + Math.round(downloadShare);
  onStatus?.("Extracting games from issue #" + issueNum + "...", extractStart);

  const zip = await JSZip.loadAsync(buf, {
    onUpdate: (meta) => {
      const pct = extractStart + Math.round((meta.percent / 100) * extractShare);
      onStatus?.("Extracting games from issue #" + issueNum + "...", pct);
    }
  });

  const pgnName = Object.keys(zip.files).find(f => f.toLowerCase().endsWith(".pgn"));
  if (!pgnName) throw new Error("No PGN file found in TWIC issue #" + issueNum);

  const pgn = await zip.files[pgnName].async("string");
  onStatus?.("Ready", startPct + rangePct);
  return pgn;
}

async function fetchTwicGames(mode, onStatus) {
  const latest = await _findLatestIssue(onStatus);

  const issueNums = mode === "lastmonth"
    ? [latest, latest - 1, latest - 2, latest - 3]
    : [latest];

  // Download sequentially so progress is clean and linear
  const rangePerIssue = Math.floor(100 / issueNums.length);
  const pgns = [];
  for (let i = 0; i < issueNums.length; i++) {
    const pgn = await _downloadIssue(issueNums[i], onStatus, i * rangePerIssue, rangePerIssue);
    pgns.push(pgn);
  }

  return pgns.join("\n\n");
}
