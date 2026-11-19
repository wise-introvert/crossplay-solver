"use strict";
/**
 * @file Crossplay Board Solver — browser-side board editor + exhaustive move generator.
 *
 * ============================================================================
 * OVERVIEW
 * ============================================================================
 * This script powers index.html. It lets the user rebuild a 15×15 NYT Crossplay
 * board (by typing, or by importing a screenshot through the global `OCR`
 * module defined in ocr.js), enter a rack of up to 7 tiles (with `?` for
 * blanks), and then enumerates EVERY legal placement, scores each one exactly
 * by Crossplay rules, and lists them best-first. Everything runs client-side;
 * the only network request is the one-time fetch of `dict.txt`.
 *
 * The move generator is the classic Appel–Jacobson algorithm ("The World's
 * Fastest Scrabble Program", 1988), implemented over a plain object trie
 * rather than a DAWG/GADDAG.
 *
 * ============================================================================
 * GAME RULES ENCODED HERE
 * ============================================================================
 * - LAYOUT: 15 strings of 15 chars describing bonus squares:
 *     'T' = triple word, 'D' = double word, 't' = triple letter,
 *     'd' = double letter, '*' = centre start square (acts as double word),
 *     '.' = plain square.
 *   The layout is Crossplay's, NOT Scrabble's (e.g. corners are TL).
 * - VAL: Crossplay tile values (differs from Scrabble). Blanks score 0.
 * - BINGO: +40 flat bonus when all 7 rack tiles are placed in one move.
 * - Premium squares apply only to tiles newly placed this turn; tiles already
 *   on the board contribute their face value only.
 * - The first move must cover the centre square (7,7).
 *
 * ============================================================================
 * MODULE STATE (mutable, top-level `let`s)
 * ============================================================================
 * - board        : N×N grid of `Cell | null`. The source of truth for tiles.
 * - sel / selDir : currently selected editor square and typing direction
 *                  (0 = across → , 1 = down ↓).
 * - dictWords    : array of valid words (uppercase, 2–15 letters, A–Z only).
 * - wordSet      : Set of the same words — O(1) lookup for cross-word checks.
 * - trie         : prefix tree of the same words — used to walk main words.
 * - lastResults  : last solver output (full sorted list of plays).
 * - previewCells : tiles of the result currently previewed on the board.
 * - pendingBlank : set by typing `?`/`.`; marks the next typed letter as blank.
 *
 * ============================================================================
 * FLOW OF EXECUTION
 * ============================================================================
 * 1. SCRIPT LOAD (synchronous, runs once; ocr.js has already defined `OCR`)
 *    a. Constants and state are initialised; `board` starts empty.
 *    b. Global listeners are attached:
 *         - document `keydown`         → handleEditorKey()  (desktop typing)
 *         - #kbd-proxy `input`         → handleEditorKey()  (mobile keyboards)
 *         - #solve-btn `click`         → solveBoard() → showResults()
 *         - #clear-btn `click`         → reset board/results
 *         - #shot-btn `click`          → opens the hidden #shot-file picker
 *         - #shot-file `change`        → importScreenshot()
 *    c. renderBoard() draws the empty grid with bonus labels.
 *    d. loadDict() is kicked off asynchronously. Until it resolves `trie` is
 *       null and the Solve button is a no-op. On success the status line
 *       reports the word count; on failure it asks the user to refresh.
 *
 * 2. BOARD EDITING (event-driven)
 *    - Clicking a square selects it (or toggles across/down if already
 *      selected), clears any preview, re-renders, and focuses the invisible
 *      #kbd-proxy input so phones open their on-screen keyboard.
 *    - Key presses go through handleEditorKey():
 *        letter      → place tile (blank if Shift held or `?` typed before),
 *                      advance one square in the current direction via step()
 *        `?` / `.`   → arm `pendingBlank` for the next letter
 *        Backspace   → clear the current square, or if already empty, move
 *                      back one square and clear that one
 *        Arrow → / ↓ → set direction and move one square
 *      Every mutation clears the preview and calls renderBoard(), which
 *      rebuilds the whole grid DOM from `board`, `previewCells` and `sel`.
 *
 * 3. SCREENSHOT IMPORT (async)
 *    importScreenshot(file) awaits OCR.processFile(file), replaces `board`
 *    wholesale with the recognised tiles (OCR cannot detect blanks, so all
 *    are marked non-blank), fills the rack input if a rack was detected, and
 *    reports how many tiles had low recognition confidence (< 0.6).
 *
 * 4. SOLVING (Solve button)
 *    a. The click handler validates the rack, writes "Solving…" and defers the
 *       actual work with setTimeout(…, 30) so the browser can paint the status.
 *    b. solveBoard() runs the generator twice:
 *         dir = 0 → on `board` itself (across plays)
 *         dir = 1 → on transpose(board) (down plays become across plays)
 *       so all generation logic only ever deals with horizontal words on row r.
 *       Coordinates are mapped back to the real board in recordPlay().
 *    c. Per direction:
 *         i.   computeCross() precomputes, for each empty square, the set of
 *              letters that form a valid perpendicular word with the tiles
 *              above/below it (null = no neighbours = unconstrained) and the
 *              face-value sum of those neighbouring tiles (for cross scoring).
 *         ii.  Anchors are found: every empty square orthogonally adjacent to a
 *              tile, or only (7,7) on an empty board. Every legal move must
 *              cover at least one anchor.
 *         iii. For each anchor, left to right per row:
 *                - If the square left of the anchor is occupied, that run of
 *                  existing tiles is a fixed prefix: walk it down the trie and
 *                  call extendRight() from the anchor.
 *                - Otherwise call leftPart(), which recursively builds every
 *                  rack-tile prefix (up to the number of free non-anchor
 *                  squares to the left, and at most rack.length-1 tiles) and
 *                  calls extendRight() for each, including the empty prefix.
 *              Restricting left parts to non-anchor squares guarantees each
 *              move is generated from exactly one anchor (its leftmost one).
 *         iv.  extendRight() walks rightwards: through existing tiles it simply
 *              follows the trie; on empty squares it tries every remaining
 *              rack tile (all 26 letters for a blank) that both continues a
 *              trie path and passes the cross-check. Whenever it reaches an
 *              empty square or the edge with a complete word that has covered
 *              the anchor and placed ≥1 tile, it calls recordPlay().
 *         v.   recordPlay() validates the placement (no tile directly before
 *              the word, centre coverage on an empty board), scores it
 *              (main word with letter/word multipliers for new tiles + every
 *              cross word formed + 40 for a bingo), maps coordinates back to
 *              the real board, and stores it in a Map keyed by
 *              direction/position/word/new-tile-columns/blank-flags so
 *              duplicate generation paths collapse to one entry.
 *    d. Plays are sorted by descending score and handed to showResults(),
 *       which renders the top 60 (blank-letters highlighted, position shown as
 *       column-letter + row-number + arrow). Clicking a result sets
 *       `previewCells` and re-renders, overlaying that play on the board.
 *
 * 5. CLEAR (Clear button)
 *    Resets `board`, the preview and the results list, then re-renders.
 *
 * ============================================================================
 * COORDINATE / DATA CONVENTIONS
 * ============================================================================
 * - (r, c) are 0-based row/column indices into the N×N grid.
 * - In solver functions, `b` may be the real board OR its transpose; `r` is
 *   then the "line" index and `c` the position along it. Look-ups into
 *   LAYOUT (letterMult/wordMult) must always use real-board coordinates, which
 *   is why recordPlay() swaps (r, c) when dir === 1.
 * - The rack is an array of single-char strings: 'A'–'Z' or '?' (blank).
 */

/**
 * A tile on the board.
 * @typedef {Object} Cell
 * @property {string} letter - Uppercase letter A–Z the tile represents.
 * @property {boolean} blank - True if the tile is a blank (scores 0).
 */

/**
 * A 15×15 grid of tiles, indexed `[row][col]`; `null` means an empty square.
 * @typedef {Array<Array<Cell|null>>} Board
 */

/**
 * A node of the dictionary prefix tree.
 * @typedef {Object} TrieNode
 * @property {Object<string, TrieNode>} ch - Child nodes keyed by letter (prototype-less object).
 * @property {boolean} end - True if the path from the root to this node spells a complete word.
 */

/**
 * A rack tile tentatively placed during move generation.
 * Left-part tiles are `[letter, isBlank]`; right-part tiles additionally carry
 * the (possibly transposed) `[letter, isBlank, r, c]` they were placed on.
 * recordPlay() only relies on the first two entries and on the array order
 * (left-to-right along the word).
 * @typedef {Array} PlacedTile
 */

/**
 * A fully scored, legal move.
 * @typedef {Object} Play
 * @property {string} word - Main word formed (uppercase, includes existing tiles).
 * @property {number} score - Total score: main word + all cross words + bingo bonus.
 * @property {0|1} dir - 0 = across, 1 = down.
 * @property {number} row - Real-board row of the word's first letter.
 * @property {number} col - Real-board column of the word's first letter.
 * @property {Array<[number, number, string, boolean]>} tiles - Newly placed tiles as `[row, col, letter, isBlank]` in real-board coordinates.
 * @property {number} blanks - How many of the newly placed tiles are blanks.
 */

/**
 * Per-direction cross-check data produced by computeCross().
 * @typedef {Object} CrossInfo
 * @property {Array<Array<Set<string>|null>>} crossOk - For each empty square, the letters that form a valid perpendicular word there; `null` when the square has no perpendicular neighbours (any letter allowed, no cross word formed).
 * @property {Array<Array<number>>} crossSum - For each constrained empty square, the summed face value of the existing tiles in its perpendicular word (excluding the square itself).
 */

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
const VAL = {
  A: 1,
  E: 1,
  I: 1,
  N: 1,
  O: 1,
  R: 1,
  S: 1,
  T: 1,
  D: 2,
  L: 2,
  U: 2,
  C: 3,
  H: 3,
  M: 3,
  P: 3,
  B: 4,
  F: 4,
  G: 4,
  Y: 4,
  W: 5,
  K: 6,
  V: 6,
  X: 8,
  J: 10,
  Q: 10,
  Z: 10,
};
const BINGO = 40;
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

// board cells: null or {letter:'A', blank:bool}
let board = Array.from({ length: N }, () => Array(N).fill(null));
let sel = null,
  selDir = 0; // 0 across, 1 down
let dictWords = null,
  trie = null,
  wordSet = null;
let lastResults = [],
  previewCells = [];

/**
 * Shorthand for `document.getElementById`.
 * @param {string} id - Element id (without `#`).
 * @returns {HTMLElement|null} The matching element, or null if absent.
 */
const $ = (id) => document.getElementById(id);

/* ---------- dictionary ---------- */
/**
 * Fetches `dict.txt` and builds the three dictionary structures used by the solver.
 *
 * The file is newline-separated. Each line is trimmed and upper-cased; only
 * words of 2–15 letters consisting solely of A–Z are kept (single letters can
 * never be legal Crossplay words, and nothing longer than the board fits).
 * From the filtered list it populates:
 *  - `dictWords` — the raw array,
 *  - `wordSet`   — a Set for O(1) whole-word checks (used by computeCross()),
 *  - `trie`      — a prefix tree whose nodes use `Object.create(null)` child
 *                  maps (no prototype keys to collide with letters), used to
 *                  walk main words letter-by-letter during generation.
 *
 * On completion the status line reports the dictionary size. Because `trie`
 * stays `null` until this resolves, solving is impossible before then.
 * The `?v=2` query string is a cache-buster for the static file.
 *
 * @async
 * @returns {Promise<void>} Resolves once all structures are built.
 * @throws {Error} Propagates network/read failures; the caller at the bottom
 *   of the file catches them and shows a "refresh the page" message.
 */
async function loadDict() {
  const res = await fetch("dict.txt?v=2");
  const text = await res.text();
  const words = text
    .split("\n")
    .map((w) => w.trim().toUpperCase())
    .filter((w) => w.length >= 2 && w.length <= 15 && /^[A-Z]+$/.test(w));
  dictWords = words;
  wordSet = new Set(words);
  trie = { ch: Object.create(null), end: false };
  for (const w of words) {
    let node = trie;
    for (const c of w) {
      node =
        node.ch[c] || (node.ch[c] = { ch: Object.create(null), end: false });
    }
    node.end = true;
  }
  $("status").textContent =
    `Dictionary ready (${words.length.toLocaleString()} words). Build your board and solve.`;
}

/* ---------- board editor ---------- */
/**
 * Maps a square's LAYOUT code to the CSS class that colours it in the editor.
 * @param {number} r - Row index (0–14), real-board coordinates.
 * @param {number} c - Column index (0–14), real-board coordinates.
 * @returns {string} One of `b-tw`, `b-dw`, `b-tl`, `b-dl`, `b-start`, or `""` for a plain square.
 */
function bonusClass(r, c) {
  const ch = LAYOUT[r][c];
  return ch === "T"
    ? "b-tw"
    : ch === "D"
      ? "b-dw"
      : ch === "t"
        ? "b-tl"
        : ch === "d"
          ? "b-dl"
          : ch === "*"
            ? "b-start"
            : "";
}
/**
 * Maps a square's LAYOUT code to the short text label drawn on empty squares.
 * @param {number} r - Row index (0–14), real-board coordinates.
 * @param {number} c - Column index (0–14), real-board coordinates.
 * @returns {string} `TW`, `DW`, `TL`, `DL`, `★` for the centre, or `""` for a plain square.
 */
function bonusLabel(r, c) {
  const ch = LAYOUT[r][c];
  return ch === "T"
    ? "TW"
    : ch === "D"
      ? "DW"
      : ch === "t"
        ? "TL"
        : ch === "d"
          ? "DL"
          : ch === "*"
            ? "★"
            : "";
}
/**
 * Rebuilds the entire `#board` grid DOM from current state.
 *
 * Clears the container and creates N×N `.sq` divs in row-major order (the CSS
 * grid lays them out). For each square, in this order of precedence:
 *  1. Base class from bonusClass().
 *  2. If `board` holds a tile: show its letter, add `.filled`, and add
 *     `.blank-tile` for blanks. Otherwise show the bonus label (if any).
 *  3. If the square is part of `previewCells` (a result being previewed):
 *     add `.preview` + `.filled` and overwrite the text with the preview letter.
 *  4. If it is the selected square: add `.selected` and set `data-arrow` to
 *     `→`/`↓` so CSS can draw the typing direction.
 *
 * Each square receives a click handler that selects it — or, if it is
 * already selected, toggles `selDir` between across and down — clears any
 * preview, re-renders, and focuses `#kbd-proxy` (with `preventScroll`) so that
 * mobile browsers raise the on-screen keyboard.
 *
 * Full re-render is deliberate: 225 nodes is cheap, and it keeps the view a
 * pure function of state.
 *
 * @returns {void}
 */
function renderBoard() {
  const el = $("board");
  el.innerHTML = "";
  for (let r = 0; r < N; r++)
    for (let c = 0; c < N; c++) {
      const d = document.createElement("div");
      d.className = "sq " + bonusClass(r, c);
      const cell = board[r][c];
      if (cell) {
        d.textContent = cell.letter;
        d.classList.add("filled");
        if (cell.blank) d.classList.add("blank-tile");
      } else {
        const lb = bonusLabel(r, c);
        if (lb) d.innerHTML = `<span class="bl">${lb}</span>`;
      }
      if (previewCells.some((p) => p[0] === r && p[1] === c)) {
        d.classList.add("preview");
        d.textContent = previewCells.find((p) => p[0] === r && p[1] === c)[2];
        d.classList.add("filled");
      }
      if (sel && sel[0] === r && sel[1] === c) {
        d.classList.add("selected");
        d.dataset.arrow = selDir === 0 ? "→" : "↓";
      }
      d.addEventListener("click", () => {
        if (sel && sel[0] === r && sel[1] === c) selDir ^= 1;
        else {
          sel = [r, c];
        }
        previewCells = [];
        renderBoard();
        const proxy = $("kbd-proxy");
        if (proxy) proxy.focus({ preventScroll: true }); // mobile: summon the on-screen keyboard
      });
      el.appendChild(d);
    }
}
let pendingBlank = false;
/**
 * Applies one editor keystroke to the board at the current selection.
 *
 * Shared by the desktop `keydown` listener and the mobile `#kbd-proxy`
 * `input` listener. Does nothing if no square is selected.
 *
 * Behaviour by key:
 *  - `Backspace`: if the selected square has a tile, remove it (selection
 *    stays). If it is empty, move one square backwards in `selDir` (if not at
 *    the edge) and remove the tile there — mirrors crossword-app behaviour.
 *  - `?` or `.`: arm `pendingBlank`, so the next letter is entered as a blank.
 *  - `ArrowRight` / `ArrowDown`: set direction to across / down respectively
 *    and move the selection one square in that direction.
 *  - Any letter A–Z (case-insensitive): place it on the selected square as a
 *    blank if `pendingBlank` is armed or `shift` is held, disarm
 *    `pendingBlank`, then advance one square in `selDir`.
 *
 * Every handled key that changes the board or selection clears the result
 * preview and calls renderBoard().
 *
 * @param {string} key - `KeyboardEvent.key` value, or a single character from the proxy input.
 * @param {boolean} shift - Whether Shift was held (Shift+letter enters a blank).
 * @returns {boolean} True if the key was consumed (caller should `preventDefault`), false otherwise.
 */
function handleEditorKey(key, shift) {
  if (!sel) return false;
  const [r, c] = sel;
  if (key === "Backspace") {
    if (board[r][c]) board[r][c] = null;
    else {
      const p = step(r, c, -1);
      if (p) {
        sel = p;
        board[p[0]][p[1]] = null;
      }
    }
    previewCells = [];
    renderBoard();
    return true;
  }
  if (key === "?" || key === ".") {
    pendingBlank = true;
    return true;
  }
  if (key === "ArrowRight") {
    selDir = 0;
    const p = step(r, c, 1);
    if (p) sel = p;
    renderBoard();
    return true;
  }
  if (key === "ArrowDown") {
    selDir = 1;
    const p = step(r, c, 1);
    if (p) sel = p;
    renderBoard();
    return true;
  }
  const k = key.toUpperCase();
  if (k.length === 1 && LETTERS.includes(k)) {
    board[r][c] = { letter: k, blank: pendingBlank || shift };
    pendingBlank = false;
    const p = step(r, c, 1);
    if (p) sel = p;
    previewCells = [];
    renderBoard();
    return true;
  }
  return false;
}
/**
 * Global desktop keyboard handler for the board editor.
 *
 * Ignored when no square is selected or when the rack input has focus (so
 * typing the rack does not also write onto the board). Also ignores IME /
 * virtual-keyboard events reported as `Unidentified` or keyCode 229, leaving
 * those to the `#kbd-proxy` `input` listener. Otherwise forwards to
 * handleEditorKey() and suppresses the browser default (e.g. page scrolling on
 * arrow keys) when the key was consumed.
 *
 * @param {KeyboardEvent} e - The keydown event.
 */
document.addEventListener("keydown", (e) => {
  if (!sel || document.activeElement === $("rack")) return;
  if (e.key === "Unidentified" || e.keyCode === 229) return; // let mobile input event handle it
  if (handleEditorKey(e.key, e.shiftKey)) e.preventDefault();
});
// iOS/Android virtual keyboards often skip proper keydown events — catch them via the proxy input
const kbdProxy = $("kbd-proxy");
if (kbdProxy) {
  /**
   * Mobile keyboard bridge: translates `input` events on the hidden
   * `#kbd-proxy` text field into editor keystrokes.
   *
   * A `deleteContentBackward` input becomes a Backspace. Anything else uses
   * the last character currently in the field (falling back to `e.data`) as
   * the key. The field is always emptied afterwards so every keystroke
   * arrives as a fresh single-character input.
   *
   * @param {InputEvent} e - The input event from the proxy field.
   */
  kbdProxy.addEventListener("input", (e) => {
    const t = e.inputType || "";
    if (t === "deleteContentBackward") handleEditorKey("Backspace", false);
    else {
      const v = kbdProxy.value;
      const ch = v ? v[v.length - 1] : e.data || "";
      if (ch) handleEditorKey(ch, false);
    }
    kbdProxy.value = "";
  });
}
/**
 * Computes the square `delta` steps from (r, c) along the current typing
 * direction `selDir` (columns when across, rows when down).
 * @param {number} r - Starting row.
 * @param {number} c - Starting column.
 * @param {number} delta - Signed step count; the editor uses +1 (forward) and -1 (backward).
 * @returns {[number, number]|null} The new `[row, col]`, or null if it would fall off the board.
 */
function step(r, c, delta) {
  if (selDir === 0) {
    c += delta;
  } else {
    r += delta;
  }
  if (r < 0 || r >= N || c < 0 || c >= N) return null;
  return [r, c];
}

/* ---------- solver ---------- */
/**
 * Returns a new board with rows and columns swapped (`t[c][r] = b[r][c]`).
 *
 * The solver only knows how to generate across words; running it on the
 * transpose turns down words into across words. Cells are shared by
 * reference, not cloned — callers must not mutate them.
 *
 * @param {Board} b - Board to transpose.
 * @returns {Board} The transposed board.
 */
function transpose(b) {
  const t = Array.from({ length: N }, () => Array(N).fill(null));
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) t[c][r] = b[r][c];
  return t;
}
/**
 * Checks whether the board contains no tiles at all (i.e. this is the opening
 * move, which must cover the centre square instead of touching tiles).
 * @param {Board} b - Board to inspect.
 * @returns {boolean} True if every square is empty.
 */
function boardEmpty(b) {
  for (let r = 0; r < N; r++)
    for (let c = 0; c < N; c++) if (b[r][c]) return false;
  return true;
}
/**
 * Letter multiplier of a square: 3 for triple-letter (`t`), 2 for
 * double-letter (`d`), otherwise 1. Only applied to newly placed tiles.
 * @param {number} r - Row in REAL-board coordinates (never transposed).
 * @param {number} c - Column in REAL-board coordinates.
 * @returns {number} 1, 2 or 3.
 */
function letterMult(r, c) {
  const ch = LAYOUT[r][c];
  return ch === "t" ? 3 : ch === "d" ? 2 : 1;
}
/**
 * Word multiplier of a square: 3 for triple-word (`T`), 2 for double-word
 * (`D`) and for the centre start square (`*`), otherwise 1. Only counts when a
 * tile is newly placed on it; multipliers from several new tiles compound.
 * @param {number} r - Row in REAL-board coordinates (never transposed).
 * @param {number} c - Column in REAL-board coordinates.
 * @returns {number} 1, 2 or 3.
 */
function wordMult(r, c) {
  const ch = LAYOUT[r][c];
  return ch === "T" ? 3 : ch === "D" ? 2 : ch === "*" ? 2 : 1;
}
/**
 * Face value of a tile already on the board: 0 for blanks, otherwise the
 * Crossplay value from VAL. No premium squares are applied.
 * @param {Cell} cell - A non-null board cell.
 * @returns {number} The tile's point value.
 */
function tileVal(cell) {
  return cell.blank ? 0 : VAL[cell.letter];
}

/**
 * Precomputes cross-checks and cross-word base scores for every empty square
 * of a working board, from the perspective of across-word generation.
 *
 * For each empty square (r, c), collects the contiguous tiles directly above
 * (`up`) and below (`down`) it. If there are none, the square is left
 * unconstrained (`crossOk = null`) — any letter may go there and no cross word
 * is formed. Otherwise it tests all 26 letters `L` and keeps those for which
 * `up + L + down` is in `wordSet`; an empty resulting Set means nothing can be
 * placed there. It also records the face-value sum of those neighbouring tiles
 * in `crossSum` so recordPlay() can score the cross word without re-walking it.
 *
 * When `b` is the transposed board, "above/below" correspond to left/right on
 * the real board, which is exactly the perpendicular direction for down plays.
 *
 * @param {Board} b - Working board (real or transposed).
 * @param {function(number, number): [number, number]} mapRC - Working→real coordinate mapper. Currently unused; scoring does its own mapping in recordPlay().
 * @returns {CrossInfo} The `crossOk` and `crossSum` grids.
 */
function computeCross(b, mapRC) {
  // crossOk[r][c] = Set of letters valid vertically at (r,c); null = no vertical neighbors (all ok)
  // crossSum[r][c] = sum of existing tile values in the vertical word (excluding this cell)
  const crossOk = Array.from({ length: N }, () => Array(N).fill(null));
  const crossSum = Array.from({ length: N }, () => Array(N).fill(0));
  for (let r = 0; r < N; r++)
    for (let c = 0; c < N; c++) {
      if (b[r][c]) continue;
      let up = "",
        down = "",
        sum = 0;
      for (let i = r - 1; i >= 0 && b[i][c]; i--) {
        up = b[i][c].letter + up;
        sum += tileVal(b[i][c]);
      }
      for (let i = r + 1; i < N && b[i][c]; i++) {
        down += b[i][c].letter;
        sum += tileVal(b[i][c]);
      }
      if (!up && !down) continue;
      const ok = new Set();
      for (const L of LETTERS) if (wordSet.has(up + L + down)) ok.add(L);
      crossOk[r][c] = ok;
      crossSum[r][c] = sum;
    }
  return { crossOk, crossSum };
}

/**
 * Generates, scores and ranks every legal move for the current `board` and
 * the rack in `#rack`.
 *
 * Runs twice — `dir = 0` on the board itself (across words) and `dir = 1` on
 * its transpose (down words) — so the generation code only ever handles
 * horizontal words. For each direction it:
 *  1. Builds cross-checks via computeCross().
 *  2. Marks anchors: on an empty board only the centre (7,7); otherwise every
 *     empty square orthogonally adjacent to at least one tile.
 *  3. Parses the rack (skipping the direction if it is empty).
 *  4. Scans each row left to right, tracking `prevAnchorCol` — the column of
 *     the last anchor OR existing tile seen — and for each anchor:
 *       - If the square to its left holds a tile, walks the whole run of
 *         contiguous tiles to the left through the trie as a fixed prefix
 *         (abandoning the anchor if that prefix is not in the trie) and calls
 *         extendRight() starting at the anchor.
 *       - Otherwise calls leftPart() with a limit of
 *         `min(rack.length - 1, free squares between prevAnchorCol and the
 *         anchor)`. Never extending a left part over a previous anchor is what
 *         prevents the same move being generated from two anchors.
 *
 * All moves are accumulated in a shared Map (see recordPlay() for the key),
 * which collapses duplicates.
 *
 * @returns {Play[]} All legal plays sorted by score, highest first. Empty if
 *   the dictionary has not loaded yet or the rack is empty.
 */
function solveBoard() {
  if (!trie) return [];
  const plays = new Map(); // key -> play
  const empty = boardEmpty(board);
  for (let dir = 0; dir < 2; dir++) {
    const b = dir === 0 ? board : transpose(board);
    const mapRC = dir === 0 ? (r, c) => [r, c] : (r, c) => [c, r];
    const { crossOk, crossSum } = computeCross(b, mapRC);
    // anchors
    const isAnchor = Array.from({ length: N }, () => Array(N).fill(false));
    if (empty) {
      isAnchor[7][7] = true;
    } else {
      for (let r = 0; r < N; r++)
        for (let c = 0; c < N; c++) {
          if (b[r][c]) continue;
          if (
            (r > 0 && b[r - 1][c]) ||
            (r < N - 1 && b[r + 1][c]) ||
            (c > 0 && b[r][c - 1]) ||
            (c < N - 1 && b[r][c + 1])
          )
            isAnchor[r][c] = true;
        }
    }
    const rack = parseRack($("rack").value);
    if (!rack.length) continue;

    for (let r = 0; r < N; r++) {
      let prevAnchorCol = -1;
      for (let c = 0; c < N; c++) {
        if (!isAnchor[r][c]) {
          if (b[r][c]) prevAnchorCol = c;
          continue;
        }
        // anchor at (r,c)
        if (c > 0 && b[r][c - 1]) {
          // fixed left prefix
          let start = c - 1;
          while (start > 0 && b[r][start - 1]) start--;
          let node = trie,
            ok = true,
            prefix = "";
          for (let i = start; i < c; i++) {
            node = node.ch[b[r][i].letter];
            if (!node) {
              ok = false;
              break;
            }
            prefix += b[r][i].letter;
          }
          if (ok)
            extendRight(
              b,
              r,
              start,
              c,
              c,
              node,
              prefix,
              [],
              rack,
              crossOk,
              crossSum,
              dir,
              plays,
              empty,
            );
        } else {
          // generated left parts on empty non-anchor cells
          const maxLeft = Math.min(
            rack.length - 1,
            c - prevAnchorCol - 1 < 0 ? 0 : c - prevAnchorCol - 1,
          );
          leftPart(
            b,
            r,
            c,
            trie,
            "",
            [],
            rack,
            0,
            maxLeft,
            crossOk,
            crossSum,
            dir,
            plays,
            empty,
          );
        }
        prevAnchorCol = c;
      }
    }
  }
  return [...plays.values()].sort((a, b2) => b2.score - a.score);
}

/**
 * Normalises raw rack input into an array of tile codes.
 *
 * Upper-cases the string, strips everything except A–Z, `?` and `.`,
 * converts `.` to `?` (both mean blank), splits into characters and truncates
 * to the 7-tile rack limit.
 *
 * @param {string} s - Raw text from the rack input (or OCR result).
 * @returns {string[]} e.g. `"aei?rt."` → `["A","E","I","?","R","T","?"]`.
 */
function parseRack(s) {
  return s
    .toUpperCase()
    .replace(/[^A-Z?.]/g, "")
    .replace(/\./g, "?")
    .split("")
    .slice(0, 7);
}

/**
 * Recursively builds every possible "left part" of a word — the rack tiles
 * placed on empty squares immediately to the left of an anchor — and hands
 * each one to extendRight().
 *
 * On every call it first tries the current prefix as-is (including the empty
 * prefix on the first call), starting the word at `anchorC - prefix.length`
 * and extending right from the anchor. Then, unless the prefix has reached
 * `limit`, it tries appending each DISTINCT remaining rack tile (duplicates
 * are skipped via a `tried` Set to avoid redundant work) whose letter
 * continues a trie path. A blank (`?`) is expanded into each of the 26
 * letters that have a trie child.
 *
 * Left-part squares are by construction non-anchor empty squares, so they
 * have no perpendicular neighbours and need no cross-check.
 *
 * @param {Board} b - Working board (real or transposed).
 * @param {number} r - Row (line) being generated on.
 * @param {number} anchorC - Column of the anchor the left part abuts.
 * @param {TrieNode} node - Trie node reached after spelling `prefix`.
 * @param {string} prefix - Letters of the left part built so far.
 * @param {PlacedTile[]} placed - Rack tiles used so far, in left-to-right order, as `[letter, isBlank]`.
 * @param {string[]} rack - Tiles still available.
 * @param {number} used - Number of rack tiles used so far (informational; equals `prefix.length`).
 * @param {number} limit - Maximum left-part length allowed at this anchor.
 * @param {Array<Array<Set<string>|null>>} crossOk - Cross-check sets from computeCross().
 * @param {Array<Array<number>>} crossSum - Cross-word base sums from computeCross().
 * @param {0|1} dir - Generation direction (0 = across on real board, 1 = down via transpose).
 * @param {Map<string, Play>} plays - Accumulator of discovered plays.
 * @param {boolean} empty - Whether the board was empty (opening move).
 * @returns {void}
 */
function leftPart(
  b,
  r,
  anchorC,
  node,
  prefix,
  placed,
  rack,
  used,
  limit,
  crossOk,
  crossSum,
  dir,
  plays,
  empty,
) {
  extendRight(
    b,
    r,
    anchorC - prefix.length,
    anchorC,
    anchorC,
    node,
    prefix,
    placed,
    rack,
    crossOk,
    crossSum,
    dir,
    plays,
    empty,
  );
  if (prefix.length >= limit) return;
  const tried = new Set();
  for (let i = 0; i < rack.length; i++) {
    const t = rack[i];
    if (tried.has(t)) continue;
    tried.add(t);
    const rest = rack.slice(0, i).concat(rack.slice(i + 1));
    if (t === "?") {
      for (const L of LETTERS) {
        const next = node.ch[L];
        if (!next) continue;
        leftPart(
          b,
          r,
          anchorC,
          next,
          prefix + L,
          placed.concat([[L, true]]),
          rest,
          used + 1,
          limit,
          crossOk,
          crossSum,
          dir,
          plays,
          empty,
        );
      }
    } else {
      const next = node.ch[t];
      if (!next) continue;
      leftPart(
        b,
        r,
        anchorC,
        next,
        prefix + t,
        placed.concat([[t, false]]),
        rest,
        used + 1,
        limit,
        crossOk,
        crossSum,
        dir,
        plays,
        empty,
      );
    }
  }
}

/**
 * Recursively extends a partial word rightwards from column `c`, placing rack
 * tiles on empty squares and absorbing existing tiles, recording every
 * complete legal word it reaches.
 *
 * Step by step:
 *  1. If `c` is past the edge or on an empty square, the word could end here.
 *     It is recorded via recordPlay() when ALL of these hold:
 *       - `node.end` — the letters so far form a dictionary word;
 *       - `placed.length > 0` — at least one rack tile was used;
 *       - `c > anchorC` — the word has covered the anchor square (otherwise a
 *         bare left part would be a play disconnected from the board);
 *       - `c - startC === word.length` — sanity check that the word spans
 *         exactly the squares from `startC`.
 *  2. If past the edge, stop.
 *  3. If `c` holds an existing tile, follow its letter in the trie (stop if
 *     no child) and recurse to `c + 1`. No rack tile is consumed.
 *  4. If `c` is empty, try each distinct remaining rack tile (blanks as all 26
 *     letters), skipping letters rejected by the square's cross-check or that
 *     have no trie child, and recurse to `c + 1` with that tile placed.
 *
 * @param {Board} b - Working board (real or transposed).
 * @param {number} r - Row (line) being generated on.
 * @param {number} startC - Column where the word begins.
 * @param {number} c - Column currently being filled.
 * @param {number} anchorC - Column of the anchor this move is generated from.
 * @param {TrieNode} node - Trie node reached after spelling `word`.
 * @param {string} word - Letters from `startC` up to (not including) `c`.
 * @param {PlacedTile[]} placed - Rack tiles placed so far, left to right.
 * @param {string[]} rack - Tiles still available.
 * @param {Array<Array<Set<string>|null>>} crossOk - Cross-check sets from computeCross().
 * @param {Array<Array<number>>} crossSum - Cross-word base sums from computeCross().
 * @param {0|1} dir - Generation direction.
 * @param {Map<string, Play>} plays - Accumulator of discovered plays.
 * @param {boolean} empty - Whether the board was empty (opening move).
 * @returns {void}
 */
function extendRight(
  b,
  r,
  startC,
  c,
  anchorC,
  node,
  word,
  placed,
  rack,
  crossOk,
  crossSum,
  dir,
  plays,
  empty,
) {
  if (c >= N || !b[r][c]) {
    // record if valid stopping point — the word must extend past the anchor square,
    // otherwise a generated left part alone would form a play disconnected from the board
    if (
      node.end &&
      placed.length > 0 &&
      c > anchorC &&
      c - startC === word.length
    ) {
      recordPlay(
        b,
        r,
        startC,
        word,
        placed,
        crossOk,
        crossSum,
        dir,
        plays,
        empty,
      );
    }
  }
  if (c >= N) return;
  const cell = b[r][c];
  if (cell) {
    const next = node.ch[cell.letter];
    if (next)
      extendRight(
        b,
        r,
        startC,
        c + 1,
        anchorC,
        next,
        word + cell.letter,
        placed,
        rack,
        crossOk,
        crossSum,
        dir,
        plays,
        empty,
      );
    return;
  }
  const ok = crossOk[r][c];
  const tried = new Set();
  for (let i = 0; i < rack.length; i++) {
    const t = rack[i];
    if (tried.has(t)) continue;
    tried.add(t);
    const rest = rack.slice(0, i).concat(rack.slice(i + 1));
    const options = t === "?" ? LETTERS : t;
    for (const L of options) {
      if (ok && !ok.has(L)) continue;
      const next = node.ch[L];
      if (!next) continue;
      extendRight(
        b,
        r,
        startC,
        c + 1,
        anchorC,
        next,
        word + L,
        placed.concat([[L, t === "?", r, c]]),
        rest,
        crossOk,
        crossSum,
        dir,
        plays,
        empty,
      );
    }
  }
}

/**
 * Validates, scores and stores one candidate move.
 *
 * Validation:
 *  - Rejects the word if the square immediately before `startC` holds a tile
 *    (the real word would be longer than `word`).
 *  - On an empty board, rejects words on any row other than 7 or that do not
 *    span column 7, i.e. the opening move must cover the centre square.
 *  - Rejects moves that place no tiles.
 *
 * Mapping: walks the word's squares left to right and assigns `placed[i]` to
 * the i-th empty square, giving `placedByCol` (column → PlacedTile).
 *
 * Scoring (Crossplay rules), with premium squares looked up in REAL-board
 * coordinates (swapping r/c when `dir === 1`):
 *  - Main word: existing tiles add face value; each new tile adds
 *    `value × letterMult` (0 for blanks), and the product of `wordMult` over
 *    all new tiles multiplies the whole main word.
 *  - Cross words: for each new tile on a constrained square (`crossOk` not
 *    null), adds `(crossSum + new tile's letter-multiplied value) × wordMult`
 *    of that square.
 *  - Bingo: +40 if all 7 tiles were placed.
 *
 * De-duplication: the Map key combines direction, real start square, word,
 * and the columns of new tiles with a `b` suffix for blanks. If the same key
 * already exists with an equal or higher score, the new one is discarded.
 *
 * @param {Board} b - Working board (real or transposed).
 * @param {number} r - Row (line) the word lies on in the working board.
 * @param {number} startC - Column of the word's first letter in the working board.
 * @param {string} word - The complete main word.
 * @param {PlacedTile[]} placed - Rack tiles placed, in left-to-right order.
 * @param {Array<Array<Set<string>|null>>} crossOk - Cross-check sets from computeCross().
 * @param {Array<Array<number>>} crossSum - Cross-word base sums from computeCross().
 * @param {0|1} dir - 0 = across (working board is real), 1 = down (working board is transposed).
 * @param {Map<string, Play>} plays - Accumulator the play is written into.
 * @param {boolean} empty - Whether the board was empty (opening move).
 * @returns {void}
 */
function recordPlay(
  b,
  r,
  startC,
  word,
  placed,
  crossOk,
  crossSum,
  dir,
  plays,
  empty,
) {
  // positions of the word: (r, startC .. startC+word.length-1)
  const len = word.length;
  // left neighbor must be empty/edge (guaranteed by construction), right checked at call
  if (startC > 0 && b[r][startC - 1]) return;
  // must connect: contains an anchor by construction; for empty board must cover center
  if (empty && !(r === 7 && startC <= 7 && startC + len > 7)) return;
  // compute placed map by column
  const placedByCol = new Map();
  let pi = 0;
  for (let c = startC; c < startC + len; c++) {
    if (!b[r][c]) {
      placedByCol.set(c, placed[pi]);
      pi++;
    }
  }
  if (placedByCol.size === 0) return;
  // score
  let mainSum = 0,
    mult = 1,
    crossTotal = 0;
  for (let c = startC; c < startC + len; c++) {
    const L = word[c - startC];
    const [lr, lc] = dir === 0 ? [r, c] : [c, r];
    if (b[r][c]) {
      mainSum += tileVal(b[r][c]);
      continue;
    }
    const [, isBlank] = placedByCol.get(c);
    const lv = (isBlank ? 0 : VAL[L]) * letterMult(lr, lc);
    mainSum += lv;
    mult *= wordMult(lr, lc);
    if (crossOk[r][c]) {
      crossTotal += (crossSum[r][c] + lv) * wordMult(lr, lc);
    }
  }
  let score = mainSum * mult + crossTotal;
  if (placedByCol.size === 7) score += BINGO;
  const [pr, pc] = dir === 0 ? [r, startC] : [startC, r];
  const key = `${dir}:${pr},${pc}:${word}:${[...placedByCol.entries()].map(([c, p]) => c + (p[1] ? "b" : "")).join(",")}`;
  if (plays.has(key) && plays.get(key).score >= score) return;
  plays.set(key, {
    word,
    score,
    dir,
    row: pr,
    col: pc,
    tiles: [...placedByCol.entries()].map(([c, p]) => {
      const [rr, cc] = dir === 0 ? [r, c] : [c, r];
      return [rr, cc, p[0], p[1]];
    }),
    blanks: [...placedByCol.values()].filter((p) => p[1]).length,
  });
}

/* ---------- UI wiring ---------- */
/**
 * Renders the solver output into the `#results` ordered list.
 *
 * Stores the full list in `lastResults`, then shows only the top 60 entries.
 * Each item displays:
 *  - the word, with letters played from blanks wrapped in `<span class="b">`
 *    (found by matching each letter's offset to the play's new tiles);
 *  - the position as column letter + 1-based row + direction arrow
 *    (e.g. `H8 →`), plus `· blank` if any blank was used;
 *  - the score.
 *
 * Clicking an item previews it: sets `previewCells` to its new tiles,
 * re-renders the board, and moves the `.active` highlight to that item.
 *
 * @param {Play[]} list - Plays sorted best-first, as returned by solveBoard().
 * @returns {void}
 */
function showResults(list) {
  lastResults = list;
  const ol = $("results");
  ol.innerHTML = "";
  const top = list.slice(0, 60);
  for (let i = 0; i < top.length; i++) {
    const p = top[i];
    const li = document.createElement("li");
    const pos = `${String.fromCharCode(65 + p.col)}${p.row + 1} ${p.dir === 0 ? "→" : "↓"}`;
    const wordHtml = p.word
      .split("")
      .map((ch, j) => {
        const t = p.tiles.find(
          (t2) => (p.dir === 0 ? t2[1] - p.col : t2[0] - p.row) === j,
        );
        return t && t[3] ? `<span class="b">${ch}</span>` : ch;
      })
      .join("");
    li.innerHTML = `<span class="word">${wordHtml}</span><span class="meta">${pos}${p.blanks ? " · blank" : ""}</span><span class="pts">${p.score}</span>`;
    li.addEventListener("click", () => {
      previewCells = p.tiles.map((t) => [t[0], t[1], t[2]]);
      renderBoard();
      [...ol.children].forEach((x) => x.classList.remove("active"));
      li.classList.add("active");
    });
    ol.appendChild(li);
  }
}

/**
 * Solve button handler.
 *
 * No-op until the dictionary is loaded. Requires a non-empty rack, otherwise
 * prompts the user to enter one. Clears any preview, shows "Solving…", then
 * defers the (synchronous, potentially hundreds-of-ms) solveBoard() call by
 * 30 ms so the status text is painted first. Afterwards it reports the number
 * of plays and elapsed time (or that none were found), renders the results
 * and re-renders the board.
 */
$("solve-btn").addEventListener("click", () => {
  if (!trie) return;
  const rack = parseRack($("rack").value);
  if (!rack.length) {
    $("status").textContent = "Type your rack letters first.";
    return;
  }
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
/**
 * Clear button handler: empties the board, drops the preview and previous
 * results, clears the results list and re-renders. The rack is left intact.
 */
$("clear-btn").addEventListener("click", () => {
  board = Array.from({ length: N }, () => Array(N).fill(null));
  previewCells = [];
  lastResults = [];
  $("results").innerHTML = "";
  $("status").textContent = "Board cleared.";
  renderBoard();
});

/**
 * Imports a board (and, if visible, the rack) from a game screenshot via the
 * OCR module in ocr.js.
 *
 * Calls `OCR.processFile(file)`, which resolves to either `{ error }` or
 * `{ board: Array<{r, c, letter, score}>, rack: string[] }`, where `score` is
 * the template-match confidence (0–1). On success it:
 *  - replaces `board` entirely with the recognised tiles (always non-blank —
 *    the OCR cannot tell blanks apart, so the user must mark them manually);
 *  - writes the rack into `#rack` if any rack tiles were recognised;
 *  - clears the preview and re-renders;
 *  - reports the tile count, the rack, and how many tiles had confidence
 *    below 0.6 so the user knows to double-check them.
 * An OCR-reported error is shown verbatim; any thrown exception (e.g. an
 * undecodable image) shows a generic "try a full screenshot" message. The
 * existing board is untouched in both failure cases.
 *
 * @async
 * @param {File} file - Image file chosen by the user.
 * @returns {Promise<void>}
 */
async function importScreenshot(file) {
  $("status").textContent = "Reading screenshot…";
  try {
    const res = await OCR.processFile(file);
    if (res.error) {
      $("status").textContent = res.error;
      return;
    }
    board = Array.from({ length: N }, () => Array(N).fill(null));
    for (const t of res.board)
      board[t.r][t.c] = { letter: t.letter, blank: false };
    if (res.rack.length) $("rack").value = res.rack.join("");
    previewCells = [];
    renderBoard();
    const low = res.board.filter((t) => t.score < 0.6).length;
    $("status").textContent =
      `Imported ${res.board.length} tiles` +
      (res.rack.length ? ` + rack ${res.rack.join("")}` : "") +
      (low
        ? ` — ${low} uncertain, please double-check.`
        : ". Check the board, fix any misreads, then solve.");
  } catch (e) {
    $("status").textContent =
      "Couldn't read that image — try a full, uncropped screenshot.";
  }
}
/** Import button handler: opens the hidden `#shot-file` file picker. */
$("shot-btn").addEventListener("click", () => $("shot-file").click());
/**
 * File picker change handler: imports the chosen image, then resets the
 * input's value so selecting the same file again still fires `change`.
 * @param {Event} e - The change event from `#shot-file`.
 */
$("shot-file").addEventListener("change", (e) => {
  if (e.target.files[0]) importScreenshot(e.target.files[0]);
  e.target.value = "";
});


/* ---------- bootstrap ----------
 * Initial render of the empty board, then start loading the dictionary in the
 * background. A load failure is surfaced in the status line. */
renderBoard();
loadDict().catch(() => {
  $("status").textContent = "Failed to load dictionary — refresh the page.";
});
