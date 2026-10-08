"use strict";
/* Crossplay Board Solver — full move generation (Appel–Jacobson style)
 * Board layout extracted from the live game; Crossplay tile values; +40 full-rack bonus. */

const N = 15;
const LAYOUT = [
  "t..T...d...T..t",
  ".D....t.t....D.",
  "....d.....d....",
  "T..d...D...d..T",
  "..d..t...t..d..",
  "....t..d..t....",
  ".t...........t.",
  "d..D.d.*.d.D..d",
  ".t...........t.",
  "....t..d..t....",
  "..d..t...t..d..",
  "T..d...D...d..T",
  "....d.....d....",
  ".D....t.t....D.",
  "t..T...d...T..t",
];
const VAL = { A: 1, E: 1, I: 1, N: 1, O: 1, R: 1, S: 1, T: 1, D: 2, L: 2, U: 2, C: 3, H: 3, M: 3, P: 3, B: 4, F: 4, G: 4, Y: 4, W: 5, K: 6, V: 6, X: 8, J: 10, Q: 10, Z: 10 };
const BINGO = 40;
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

// board cells: null or {letter:'A', blank:bool}
let board = Array.from({ length: N }, () => Array(N).fill(null));
let sel = null, selDir = 0; // 0 across, 1 down
let dictWords = null, trie = null, wordSet = null;
let lastResults = [], previewCells = [];

const $ = (id) => document.getElementById(id);

/* ---------- dictionary ---------- */
async function loadDict() {
  const res = await fetch("dict.txt?v=2");
  const text = await res.text();
  const words = text.split("\n").map(w => w.trim().toUpperCase()).filter(w => w.length >= 2 && w.length <= 15 && /^[A-Z]+$/.test(w));
  dictWords = words;
  wordSet = new Set(words);
  trie = { ch: Object.create(null), end: false };
  for (const w of words) {
    let node = trie;
    for (const c of w) {
      node = node.ch[ c ] || (node.ch[ c ] = { ch: Object.create(null), end: false });
    }
    node.end = true;
  }
  $("status").textContent = `Dictionary ready (${words.length.toLocaleString()} words). Build your board and solve.`;
}

/* ---------- board editor ---------- */
function bonusClass(r, c) {
  const ch = LAYOUT[ r ][ c ];
  return ch === "T" ? "b-tw" : ch === "D" ? "b-dw" : ch === "t" ? "b-tl" : ch === "d" ? "b-dl" : ch === "*" ? "b-start" : "";
}
function bonusLabel(r, c) {
  const ch = LAYOUT[ r ][ c ];
  return ch === "T" ? "TW" : ch === "D" ? "DW" : ch === "t" ? "TL" : ch === "d" ? "DL" : ch === "*" ? "★" : "";
}
function renderBoard() {
  const el = $("board");
  el.innerHTML = "";
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const d = document.createElement("div");
    d.className = "sq " + bonusClass(r, c);
    const cell = board[ r ][ c ];
    if (cell) {
      d.textContent = cell.letter;
      d.classList.add("filled");
      if (cell.blank) d.classList.add("blank-tile");
    } else {
      const lb = bonusLabel(r, c);
      if (lb) d.innerHTML = `<span class="bl">${lb}</span>`;
    }
    if (previewCells.some(p => p[ 0 ] === r && p[ 1 ] === c)) {
      d.classList.add("preview");
      d.textContent = previewCells.find(p => p[ 0 ] === r && p[ 1 ] === c)[ 2 ];
      d.classList.add("filled");
    }
    if (sel && sel[ 0 ] === r && sel[ 1 ] === c) {
      d.classList.add("selected");
      d.dataset.arrow = selDir === 0 ? "→" : "↓";
    }
    d.addEventListener("click", () => {
      if (sel && sel[ 0 ] === r && sel[ 1 ] === c) selDir ^= 1;
      else { sel = [ r, c ]; }
      previewCells = []; renderBoard();
      const proxy = $("kbd-proxy");
      if (proxy) proxy.focus({ preventScroll: true }); // mobile: summon the on-screen keyboard
    });
    el.appendChild(d);
  }
}
let pendingBlank = false;
function handleEditorKey(key, shift) {
  if (!sel) return false;
  const [ r, c ] = sel;
  if (key === "Backspace") {
    if (board[ r ][ c ]) board[ r ][ c ] = null;
    else { const p = step(r, c, -1); if (p) { sel = p; board[ p[ 0 ] ][ p[ 1 ] ] = null; } }
    previewCells = []; renderBoard(); return true;
  }
  if (key === "?" || key === ".") { pendingBlank = true; return true; }
  if (key === "ArrowRight") { selDir = 0; const p = step(r, c, 1); if (p) sel = p; renderBoard(); return true; }
  if (key === "ArrowDown") { selDir = 1; const p = step(r, c, 1); if (p) sel = p; renderBoard(); return true; }
  const k = key.toUpperCase();
  if (k.length === 1 && LETTERS.includes(k)) {
    board[ r ][ c ] = { letter: k, blank: pendingBlank || shift };
    pendingBlank = false;
    const p = step(r, c, 1); if (p) sel = p;
    previewCells = []; renderBoard(); return true;
  }
  return false;
}
document.addEventListener("keydown", (e) => {
  if (!sel || document.activeElement === $("rack")) return;
  if (e.key === "Unidentified" || e.keyCode === 229) return; // let mobile input event handle it
  if (handleEditorKey(e.key, e.shiftKey)) e.preventDefault();
});
// iOS/Android virtual keyboards often skip proper keydown events — catch them via the proxy input
const kbdProxy = $("kbd-proxy");
if (kbdProxy) {
  kbdProxy.addEventListener("input", (e) => {
    const t = e.inputType || "";
    if (t === "deleteContentBackward") handleEditorKey("Backspace", false);
    else {
      const v = kbdProxy.value;
      const ch = v ? v[ v.length - 1 ] : (e.data || "");
      if (ch) handleEditorKey(ch, false);
    }
    kbdProxy.value = "";
  });
}
function step(r, c, delta) {
  if (selDir === 0) { c += delta; } else { r += delta; }
  if (r < 0 || r >= N || c < 0 || c >= N) return null;
  return [ r, c ];
}

/* ---------- solver ---------- */
function transpose(b) {
  const t = Array.from({ length: N }, () => Array(N).fill(null));
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) t[ c ][ r ] = b[ r ][ c ];
  return t;
}
function boardEmpty(b) {
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (b[ r ][ c ]) return false;
  return true;
}
function letterMult(r, c) { const ch = LAYOUT[ r ][ c ]; return ch === "t" ? 3 : ch === "d" ? 2 : 1; }
function wordMult(r, c) { const ch = LAYOUT[ r ][ c ]; return ch === "T" ? 3 : ch === "D" ? 2 : ch === "*" ? 2 : 1; }
function tileVal(cell) { return cell.blank ? 0 : VAL[ cell.letter ]; }

// For a working board b (row-major), and its layout coordinate mapper
function computeCross(b, mapRC) {
  // crossOk[r][c] = Set of letters valid vertically at (r,c); null = no vertical neighbors (all ok)
  // crossSum[r][c] = sum of existing tile values in the vertical word (excluding this cell)
  const crossOk = Array.from({ length: N }, () => Array(N).fill(null));
  const crossSum = Array.from({ length: N }, () => Array(N).fill(0));
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    if (b[ r ][ c ]) continue;
    let up = "", down = "", sum = 0;
    for (let i = r - 1; i >= 0 && b[ i ][ c ]; i--) { up = b[ i ][ c ].letter + up; sum += tileVal(b[ i ][ c ]); }
    for (let i = r + 1; i < N && b[ i ][ c ]; i++) { down += b[ i ][ c ].letter; sum += tileVal(b[ i ][ c ]); }
    if (!up && !down) continue;
    const ok = new Set();
    for (const L of LETTERS) if (wordSet.has(up + L + down)) ok.add(L);
    crossOk[ r ][ c ] = ok;
    crossSum[ r ][ c ] = sum;
  }
  return { crossOk, crossSum };
}

function solveBoard() {
  if (!trie) return [];
  const plays = new Map(); // key -> play
  const empty = boardEmpty(board);
  for (let dir = 0; dir < 2; dir++) {
    const b = dir === 0 ? board : transpose(board);
    const mapRC = dir === 0 ? (r, c) => [ r, c ] : (r, c) => [ c, r ];
    const { crossOk, crossSum } = computeCross(b, mapRC);
    // anchors
    const isAnchor = Array.from({ length: N }, () => Array(N).fill(false));
    if (empty) {
      isAnchor[ 7 ][ 7 ] = true;
    } else {
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
        if (b[ r ][ c ]) continue;
        if ((r > 0 && b[ r - 1 ][ c ]) || (r < N - 1 && b[ r + 1 ][ c ]) || (c > 0 && b[ r ][ c - 1 ]) || (c < N - 1 && b[ r ][ c + 1 ])) isAnchor[ r ][ c ] = true;
      }
    }
    const rack = parseRack($("rack").value);
    if (!rack.length) continue;

    for (let r = 0; r < N; r++) {
      let prevAnchorCol = -1;
      for (let c = 0; c < N; c++) {
        if (!isAnchor[ r ][ c ]) { if (b[ r ][ c ]) prevAnchorCol = c; continue; }
        // anchor at (r,c)
        if (c > 0 && b[ r ][ c - 1 ]) {
          // fixed left prefix
          let start = c - 1;
          while (start > 0 && b[ r ][ start - 1 ]) start--;
          let node = trie, ok = true, prefix = "";
          for (let i = start; i < c; i++) {
            node = node.ch[ b[ r ][ i ].letter ];
            if (!node) { ok = false; break; }
            prefix += b[ r ][ i ].letter;
          }
          if (ok) extendRight(b, r, start, c, c, node, prefix, [], rack, crossOk, crossSum, dir, plays, empty);
        } else {
          // generated left parts on empty non-anchor cells
          const maxLeft = Math.min(rack.length - 1, c - prevAnchorCol - 1 < 0 ? 0 : c - prevAnchorCol - 1);
          leftPart(b, r, c, trie, "", [], rack, 0, maxLeft, crossOk, crossSum, dir, plays, empty);
        }
        prevAnchorCol = c;
      }
    }
  }
  return [ ...plays.values() ].sort((a, b2) => b2.score - a.score);
}

function parseRack(s) {
  return s.toUpperCase().replace(/[^A-Z?.]/g, "").replace(/\./g, "?").split("").slice(0, 7);
}

function leftPart(b, r, anchorC, node, prefix, placed, rack, used, limit, crossOk, crossSum, dir, plays, empty) {
  extendRight(b, r, anchorC - prefix.length, anchorC, anchorC, node, prefix, placed, rack, crossOk, crossSum, dir, plays, empty);
  if (prefix.length >= limit) return;
  const tried = new Set();
  for (let i = 0; i < rack.length; i++) {
    const t = rack[ i ];
    if (tried.has(t)) continue;
    tried.add(t);
    const rest = rack.slice(0, i).concat(rack.slice(i + 1));
    if (t === "?") {
      for (const L of LETTERS) {
        const next = node.ch[ L ];
        if (!next) continue;
        leftPart(b, r, anchorC, next, prefix + L, placed.concat([ [ L, true ] ]), rest, used + 1, limit, crossOk, crossSum, dir, plays, empty);
      }
    } else {
      const next = node.ch[ t ];
      if (!next) continue;
      leftPart(b, r, anchorC, next, prefix + t, placed.concat([ [ t, false ] ]), rest, used + 1, limit, crossOk, crossSum, dir, plays, empty);
    }
  }
}

function extendRight(b, r, startC, c, anchorC, node, word, placed, rack, crossOk, crossSum, dir, plays, empty) {
  if (c >= N || !b[ r ][ c ]) {
    // record if valid stopping point — the word must extend past the anchor square,
    // otherwise a generated left part alone would form a play disconnected from the board
    if (node.end && placed.length > 0 && c > anchorC && c - startC === word.length) {
      recordPlay(b, r, startC, word, placed, crossOk, crossSum, dir, plays, empty);
    }
  }
  if (c >= N) return;
  const cell = b[ r ][ c ];
  if (cell) {
    const next = node.ch[ cell.letter ];
    if (next) extendRight(b, r, startC, c + 1, anchorC, next, word + cell.letter, placed, rack, crossOk, crossSum, dir, plays, empty);
    return;
  }
  const ok = crossOk[ r ][ c ];
  const tried = new Set();
  for (let i = 0; i < rack.length; i++) {
    const t = rack[ i ];
    if (tried.has(t)) continue;
    tried.add(t);
    const rest = rack.slice(0, i).concat(rack.slice(i + 1));
    const options = t === "?" ? LETTERS : t;
    for (const L of options) {
      if (ok && !ok.has(L)) continue;
      const next = node.ch[ L ];
      if (!next) continue;
      extendRight(b, r, startC, c + 1, anchorC, next, word + L, placed.concat([ [ L, t === "?", r, c ] ]), rest, crossOk, crossSum, dir, plays, empty);
    }
  }
}

function recordPlay(b, r, startC, word, placed, crossOk, crossSum, dir, plays, empty) {
  // positions of the word: (r, startC .. startC+word.length-1)
  const len = word.length;
  // left neighbor must be empty/edge (guaranteed by construction), right checked at call
  if (startC > 0 && b[ r ][ startC - 1 ]) return;
  // must connect: contains an anchor by construction; for empty board must cover center
  if (empty && !(r === 7 && startC <= 7 && startC + len > 7)) return;
  // compute placed map by column
  const placedByCol = new Map();
  let pi = 0;
  for (let c = startC; c < startC + len; c++) {
    if (!b[ r ][ c ]) { placedByCol.set(c, placed[ pi ]); pi++; }
  }
  if (placedByCol.size === 0) return;
  // score
  let mainSum = 0, mult = 1, crossTotal = 0;
  for (let c = startC; c < startC + len; c++) {
    const L = word[ c - startC ];
    const [ lr, lc ] = dir === 0 ? [ r, c ] : [ c, r ];
    if (b[ r ][ c ]) { mainSum += tileVal(b[ r ][ c ]); continue; }
    const [ , isBlank ] = placedByCol.get(c);
    const lv = (isBlank ? 0 : VAL[ L ]) * letterMult(lr, lc);
    mainSum += lv;
    mult *= wordMult(lr, lc);
    if (crossOk[ r ][ c ]) {
      crossTotal += (crossSum[ r ][ c ] + lv) * wordMult(lr, lc);
    }
  }
  let score = mainSum * mult + crossTotal;
  if (placedByCol.size === 7) score += BINGO;
  const [ pr, pc ] = dir === 0 ? [ r, startC ] : [ startC, r ];
  const key = `${dir}:${pr},${pc}:${word}:${[ ...placedByCol.entries() ].map(([ c, p ]) => c + (p[ 1 ] ? "b" : "")).join(",")}`;
  if (plays.has(key) && plays.get(key).score >= score) return;
  plays.set(key, {
    word, score, dir, row: pr, col: pc,
    tiles: [ ...placedByCol.entries() ].map(([ c, p ]) => {
      const [ rr, cc ] = dir === 0 ? [ r, c ] : [ c, r ];
      return [ rr, cc, p[ 0 ], p[ 1 ] ];
    }),
    blanks: [ ...placedByCol.values() ].filter(p => p[ 1 ]).length,
  });
}

/* ---------- UI wiring ---------- */
function showResults(list) {
  lastResults = list;
  const ol = $("results");
  ol.innerHTML = "";
  const top = list.slice(0, 60);
  for (let i = 0; i < top.length; i++) {
    const p = top[ i ];
    const li = document.createElement("li");
    const pos = `${String.fromCharCode(65 + p.col)}${p.row + 1} ${p.dir === 0 ? "→" : "↓"}`;
    const wordHtml = p.word.split("").map((ch, j) => {
      const t = p.tiles.find(t2 => (p.dir === 0 ? t2[ 1 ] - p.col : t2[ 0 ] - p.row) === j);
      return t && t[ 3 ] ? `<span class="b">${ch}</span>` : ch;
    }).join("");
    li.innerHTML = `<span class="word">${wordHtml}</span><span class="meta">${pos}${p.blanks ? " · blank" : ""}</span><span class="pts">${p.score}</span>`;
    li.addEventListener("click", () => {
      previewCells = p.tiles.map(t => [ t[ 0 ], t[ 1 ], t[ 2 ] ]);
      renderBoard();
      [ ...ol.children ].forEach(x => x.classList.remove("active"));
      li.classList.add("active");
    });
    ol.appendChild(li);
  }
}

$("solve-btn").addEventListener("click", () => {
  if (!trie) return;
  const rack = parseRack($("rack").value);
  if (!rack.length) { $("status").textContent = "Type your rack letters first."; return; }
  $("status").textContent = "Solving…";
  previewCells = [];
  setTimeout(() => {
    const t0 = performance.now();
    const res = solveBoard();
    const ms = Math.round(performance.now() - t0);
    $("status").textContent = res.length
      ? `${res.length.toLocaleString()} legal plays found in ${ms} ms — top ${Math.min(60, res.length)} shown.`
      : "No legal plays found — check the board and rack.";
    showResults(res);
    renderBoard();
  }, 30);
});
$("clear-btn").addEventListener("click", () => {
  board = Array.from({ length: N }, () => Array(N).fill(null));
  previewCells = []; lastResults = [];
  $("results").innerHTML = "";
  $("status").textContent = "Board cleared.";
  renderBoard();
});

async function importScreenshot(file) {
  $("status").textContent = "Reading screenshot…";
  try {
    const res = await OCR.processFile(file);
    if (res.error) { $("status").textContent = res.error; return; }
    board = Array.from({ length: N }, () => Array(N).fill(null));
    for (const t of res.board) board[ t.r ][ t.c ] = { letter: t.letter, blank: false };
    if (res.rack.length) $("rack").value = res.rack.join("");
    previewCells = [];
    renderBoard();
    const low = res.board.filter(t => t.score < 0.6).length;
    $("status").textContent = `Imported ${res.board.length} tiles` +
      (res.rack.length ? ` + rack ${res.rack.join("")}` : "") +
      (low ? ` — ${low} uncertain, please double-check.` : ". Check the board, fix any misreads, then solve.");
  } catch (e) {
    $("status").textContent = "Couldn't read that image — try a full, uncropped screenshot.";
  }
}
$("shot-btn").addEventListener("click", () => $("shot-file").click());
$("shot-file").addEventListener("change", (e) => {
  if (e.target.files[ 0 ]) importScreenshot(e.target.files[ 0 ]);
  e.target.value = "";
});

renderBoard();
loadDict().catch(() => { $("status").textContent = "Failed to load dictionary — refresh the page."; });
