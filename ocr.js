"use strict";
/* Screenshot import for Crossplay boards.
 * Pipeline: locate board via bonus/empty cell colors -> 15x15 grid -> tile detection
 * -> largest-white-component glyph -> template match (templates.json, built from real game glyphs). */

const OCR = (() => {
  const GS = 20;
  let TPL = null;

  async function loadTemplates() {
    if (!TPL) TPL = await fetch("templates.json").then((r) => r.json());
    return TPL;
  }

  // NOTE: 2W blue is deliberately excluded â€” it is too close to common page backgrounds
  const isEmptyish = (r, g, b) =>
    (Math.abs(r - 236) < 12 &&
      Math.abs(g - 234) < 12 &&
      Math.abs(b - 229) < 12 &&
      r - b > 2) || // empty (warm gray)
    (Math.abs(r - 233) < 18 &&
      Math.abs(g - 221) < 18 &&
      Math.abs(b - 174) < 22) || // 2L
    (Math.abs(r - 203) < 18 &&
      Math.abs(g - 220) < 18 &&
      Math.abs(b - 170) < 22) || // 3L
    (Math.abs(r - 226) < 18 &&
      Math.abs(g - 199) < 18 &&
      Math.abs(b - 228) < 18); // 3W
  const isTileBlue = (r, g, b) => b > r + 40 && b > 120 && b < 235 && r < 115;

  function analyze(imgData, W, H) {
    const d = imgData.data;
    // histograms of empty/bonus pixels to find board bbox (rack has none of these)
    const colHist = new Int32Array(W),
      rowHist = new Int32Array(H);
    for (let y = 0; y < H; y += 2) {
      for (let x = 0; x < W; x += 2) {
        const i = (y * W + x) * 4;
        if (isEmptyish(d[ i ], d[ i + 1 ], d[ i + 2 ])) {
          colHist[ x ]++;
          rowHist[ y ]++;
        }
      }
    }
    const colMax = Math.max(...colHist),
      rowMax = Math.max(...rowHist);
    if (colMax < 10)
      return { error: "Couldn't find a Crossplay board in this image." };
    let rx0 = 0,
      rx1 = W - 1,
      ry0 = 0,
      ry1 = H - 1;
    while (rx0 < W && colHist[ rx0 ] < colMax * 0.12) rx0++;
    while (rx1 > 0 && colHist[ rx1 ] < colMax * 0.12) rx1--;
    while (ry0 < H && rowHist[ ry0 ] < rowMax * 0.12) ry0++;
    while (ry1 > 0 && rowHist[ ry1 ] < rowMax * 0.12) ry1--;
    const bw = rx1 - rx0;
    if (bw < 150)
      return { error: "Board too small â€” use a full-resolution screenshot." };
    ry1 = Math.min(ry1, (ry0 + bw + bw / 15) | 0); // board is square; cap runaway bottom edge

    // refine grid via white gap-line phase fitting (gaps between cells are near-white)
    function phaseFit(hist, lo, hi, cellGuess) {
      let best = null;
      for (
        let s100 = Math.round(cellGuess * 90);
        s100 <= Math.round(cellGuess * 110);
        s100++
      ) {
        const s = s100 / 100;
        let cx = 0,
          cy = 0;
        for (let v = lo; v <= hi; v++) {
          const w = hist[ v ];
          if (!w) continue;
          const a = 2 * Math.PI * ((v / s) % 1);
          cx += w * Math.cos(a);
          cy += w * Math.sin(a);
        }
        const R = Math.hypot(cx, cy);
        if (!best || R > best.R)
          best = { R, s, phase: (Math.atan2(cy, cx) / (2 * Math.PI) + 1) % 1 };
      }
      return best;
    }
    const whiteCol = new Float32Array(W),
      whiteRow = new Float32Array(H);
    for (let y = ry0; y <= ry1; y += 2) {
      for (let x = rx0; x <= rx1; x += 2) {
        const i = (y * W + x) * 4;
        if (d[ i ] > 244 && d[ i + 1 ] > 244 && d[ i + 2 ] > 244) {
          whiteCol[ x ]++;
          whiteRow[ y ]++;
        }
      }
    }
    const guess = bw / 15;
    const fx = phaseFit(whiteCol, rx0, rx1, guess);
    const fy = phaseFit(whiteRow, ry0, ry1, guess);
    const sX = fx.s,
      sY = fy.s;
    // anchor: gap line nearest to rough left/top edge, cells start half? gap lines sit at cell boundaries
    const alignAnchor = (phase, s, roughEdge) => {
      let a = phase * s;
      while (a < roughEdge - s * 0.6) a += s;
      while (a > roughEdge + s * 0.6) a -= s;
      return a;
    };
    const x0 = alignAnchor(fx.phase, sX, rx0);
    const y0 = alignAnchor(fy.phase, sY, ry0);
    const y1 = y0 + 15 * sY;
    const s = (sX + sY) / 2;

    const cellAt = (px, py, size) => {
      // returns {tile, glyph} for a square region
      let dark = 0,
        n = 0;
      const inset = size * 0.28;
      for (let y = py + inset; y < py + size - inset; y += 2) {
        for (let x = px + inset; x < px + size - inset; x += 2) {
          const i = ((y | 0) * W + (x | 0)) * 4;
          if (isTileBlue(d[ i ], d[ i + 1 ], d[ i + 2 ])) dark++;
          n++;
        }
      }
      return dark > n * 0.4;
    };

    function glyphAt(px, py, size) {
      const x0i = Math.max(0, px | 0),
        y0i = Math.max(0, py | 0),
        sz = size | 0;
      const mask = new Uint8Array(sz * sz);
      for (let y = 0; y < sz; y++) {
        for (let x = 0; x < sz; x++) {
          if (y < sz * 0.42 && x > sz * 0.62) continue; // tile value digit corner
          const i = ((y0i + y) * W + (x0i + x)) * 4;
          if (d[ i ] > 185 && d[ i + 1 ] > 185 && d[ i + 2 ] > 185)
            mask[ y * sz + x ] = 1;
        }
      }
      // largest connected component
      const seen = new Uint8Array(sz * sz);
      let best = null;
      const stack = [];
      for (let start = 0; start < sz * sz; start++) {
        if (!mask[ start ] || seen[ start ]) continue;
        stack.length = 0;
        stack.push(start);
        seen[ start ] = 1;
        const comp = [];
        while (stack.length) {
          const p = stack.pop();
          comp.push(p);
          const cx = p % sz,
            cy = (p / sz) | 0;
          if (cx > 0 && mask[ p - 1 ] && !seen[ p - 1 ]) {
            seen[ p - 1 ] = 1;
            stack.push(p - 1);
          }
          if (cx < sz - 1 && mask[ p + 1 ] && !seen[ p + 1 ]) {
            seen[ p + 1 ] = 1;
            stack.push(p + 1);
          }
          if (cy > 0 && mask[ p - sz ] && !seen[ p - sz ]) {
            seen[ p - sz ] = 1;
            stack.push(p - sz);
          }
          if (cy < sz - 1 && mask[ p + sz ] && !seen[ p + sz ]) {
            seen[ p + sz ] = 1;
            stack.push(p + sz);
          }
        }
        if (!best || comp.length > best.length) best = comp;
      }
      if (!best || best.length < sz * sz * 0.02) return null;
      let bx0 = sz,
        bx1 = 0,
        by0 = sz,
        by1 = 0;
      const inComp = new Uint8Array(sz * sz);
      for (const p of best) {
        inComp[ p ] = 1;
        const cx = p % sz,
          cy = (p / sz) | 0;
        if (cx < bx0) bx0 = cx;
        if (cx > bx1) bx1 = cx;
        if (cy < by0) by0 = cy;
        if (cy > by1) by1 = cy;
      }
      const gw = bx1 - bx0 + 1,
        gh = by1 - by0 + 1;
      if (gw < 4 || gh < 4) return null;
      const grid = new Float32Array(GS * GS),
        cnt = new Float32Array(GS * GS);
      for (let y = by0; y <= by1; y++) {
        for (let x = bx0; x <= bx1; x++) {
          const gx = Math.min(GS - 1, (((x - bx0) * GS) / gw) | 0);
          const gy = Math.min(GS - 1, (((y - by0) * GS) / gh) | 0);
          cnt[ gy * GS + gx ]++;
          if (inComp[ y * sz + x ]) grid[ gy * GS + gx ]++;
        }
      }
      for (let k = 0; k < GS * GS; k++) if (cnt[ k ]) grid[ k ] /= cnt[ k ];
      return { grid, ratio: gw / gh };
    }

    function match(g) {
      let bestL = null,
        bestS = -1;
      for (const L in TPL) {
        const t = TPL[ L ];
        let dot = 0,
          na = 0,
          nb = 0;
        for (let y = 0; y < GS; y++) {
          for (let x = 0; x < GS; x++) {
            const a = g.grid[ y * GS + x ],
              b = t.g[ y ][ x ];
            dot += a * b;
            na += a * a;
            nb += b * b;
          }
        }
        let s = dot / (Math.sqrt(na * nb) + 1e-9);
        s -= 0.15 * Math.abs(Math.log(g.ratio / t.r));
        if (s > bestS) {
          bestS = s;
          bestL = L;
        }
      }
      return { letter: bestL, score: bestS };
    }

    // board cells
    const board = [];
    const dbg = {
      x0: Math.round(x0),
      y0: Math.round(y0),
      sX: +sX.toFixed(2),
      sY: +sY.toFixed(2),
      Rx: +fx.R.toFixed(1),
      Ry: +fy.R.toFixed(1),
      tiles: 0,
      noGlyph: 0,
      lowScore: [],
    };
    for (let r = 0; r < 15; r++) {
      for (let c = 0; c < 15; c++) {
        const px = x0 + c * sX,
          py = y0 + r * sY;
        if (!cellAt(px, py, s)) continue;
        dbg.tiles++;
        const g = glyphAt(px, py, s);
        if (!g) {
          dbg.noGlyph++;
          continue;
        }
        const m = match(g);
        if (m.score > 0.45)
          board.push({ r, c, letter: m.letter, score: m.score });
        else if (dbg.lowScore.length < 8)
          dbg.lowScore.push([ r, c, m.letter, +m.score.toFixed(2) ]);
      }
    }
    window.__ocrDbg = dbg;

    // rack: below board, blue blobs; scan a band and cluster columns
    const rackTop = y1 + s * 0.3,
      rackBot = Math.min(H - 1, y1 + s * 5.5);
    const rackCols = new Int32Array(W);
    for (let y = rackTop; y < rackBot; y += 2) {
      for (let x = 0; x < W; x += 2) {
        const i = ((y | 0) * W + (x | 0)) * 4;
        if (isTileBlue(d[ i ], d[ i + 1 ], d[ i + 2 ])) rackCols[ x ]++;
      }
    }
    const rack = [];
    const thr = Math.max(6, ((rackBot - rackTop) / 2) * 0.35);
    let runStart = -1;
    for (let x = 0; x <= W; x++) {
      const on = x < W && rackCols[ x ] >= thr;
      if (on && runStart < 0) runStart = x;
      if (!on && runStart >= 0) {
        const wRun = x - runStart;
        if (wRun > s * 0.5) {
          // find vertical extent
          let ry0 = rackBot,
            ry1 = rackTop;
          for (let y = rackTop; y < rackBot; y++) {
            const i = ((y | 0) * W + ((runStart + wRun / 2) | 0)) * 4;
            if (isTileBlue(d[ i ], d[ i + 1 ], d[ i + 2 ])) {
              if (y < ry0) ry0 = y;
              if (y > ry1) ry1 = y;
            }
          }
          const size = Math.max(wRun, ry1 - ry0);
          if (size > s * 0.5 && size < s * 2.5) {
            const g = glyphAt(runStart, ry0, size);
            if (g) {
              const m = match(g);
              if (m.score > 0.45) rack.push(m.letter);
            }
          }
        }
        runStart = -1;
      }
    }
    return { board, rack: rack.slice(0, 7) };
  }

  async function processFile(file) {
    await loadTemplates();
    const bmp = await createImageBitmap(file);
    const maxW = 1400;
    const scale = Math.min(1, maxW / bmp.width);
    const cw = Math.round(bmp.width * scale),
      ch = Math.round(bmp.height * scale);
    const cv = document.createElement("canvas");
    cv.width = cw;
    cv.height = ch;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, cw, ch);
    const data = ctx.getImageData(0, 0, cw, ch);
    return analyze(data, cw, ch);
  }

  return { processFile };
})();
