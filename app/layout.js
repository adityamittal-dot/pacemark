// Pacemark PDF layout analysis.
// Turns pdf.js text items into words with page coordinates, then works out reading order from the
// layout itself (columns, full-width headings, running headers and footers) instead of trusting the
// order the text happens to be stored in the file.
//
// All coordinates are in PDF points at scale 1 with the origin at the top-left of the page.
window.PdfLayout = (() => {
  const SENTENCE_END = /[.!?…]["'”’)\]]*$/;
  const ctx = document.createElement("canvas").getContext("2d");
  const widthCache = new Map();
  function measure(str, family) {
    const key = family + "\u0000" + str;
    let w = widthCache.get(key);
    if (w === undefined) {
      ctx.font = `100px ${family || "sans-serif"}`;
      w = ctx.measureText(str).width;
      if (widthCache.size > 20000) widthCache.clear();
      widthCache.set(key, w);
    }
    return w;
  }
  const median = arr => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const cy = b => (b.y0 + b.y1) / 2;

  /* ---------- 1. words with boxes ---------- */
  // Items can split a word into pieces ("communica" + "T" + "ion"), so pieces that touch on the same
  // line are merged back into one word.
  function pageWords(tc, vp) {
    const words = [];
    let prev = null;
    for (const it of tc.items) {
      if (!("str" in it)) continue;
      if (!it.str) { if (it.hasEOL) prev = null; continue; }
      const t = pdfjsLib.Util.transform(vp.transform, it.transform);
      // skip rotated text (vertical margin notes, watermarks)
      if (Math.abs(Math.atan2(t[1], t[0])) > 0.05) { prev = null; continue; }
      const h = Math.hypot(t[2], t[3]) || Math.abs(it.height) || 1;
      const x = t[4], base = t[5];
      const family = tc.styles[it.fontName]?.fontFamily;
      const total = measure(it.str, family);
      const scale = total > 0 ? it.width / total : 0;
      if (/^\s/.test(it.str)) prev = null;
      const re = /\S+/g;
      let m;
      while ((m = re.exec(it.str))) {
        const x0 = x + measure(it.str.slice(0, m.index), family) * scale;
        const x1 = x0 + Math.max(measure(m[0], family) * scale, h * 0.2);
        const box = { t: m[0], x0, x1, y0: base - h * 0.8, y1: base + h * 0.22, h };
        const tol = Math.max(prev?.h || 0, h);
        const touches = prev && m.index === 0 &&
          Math.abs(cy(prev) - cy(box)) < tol * 0.6 &&
          box.x0 - prev.x1 < tol * 0.12 && box.x0 - prev.x1 > -tol * 0.5;
        if (touches) {
          prev.t += m[0];
          prev.x1 = Math.max(prev.x1, box.x1);
          prev.y0 = Math.min(prev.y0, box.y0);
          prev.y1 = Math.max(prev.y1, box.y1);
          prev.h = Math.max(prev.h, h);
        } else {
          words.push(box);
          prev = box;
        }
      }
      if (/\s$/.test(it.str) || it.hasEOL) prev = null;
    }
    return words;
  }

  /* ---------- 2. lines, split into fragments at wide gaps ---------- */
  function fragments(words) {
    const sorted = [...words].sort((a, b) => cy(a) - cy(b) || a.x0 - b.x0);
    const rows = [];
    for (const w of sorted) {
      const row = rows[rows.length - 1];
      if (row && Math.abs(cy(w) - row.c) < Math.min(w.h, row.h) * 0.5) {
        row.words.push(w);
        row.c = (row.c * (row.words.length - 1) + cy(w)) / row.words.length;
        row.h = Math.max(row.h, w.h);
      } else rows.push({ c: cy(w), h: w.h, words: [w] });
    }
    const frags = [];
    for (const row of rows) {
      row.words.sort((a, b) => a.x0 - b.x0);
      let cur = null;
      for (const w of row.words) {
        // a gap wider than about one character height separates columns; over-splitting inside a
        // column is harmless because single-column regions are re-read row by row later
        if (cur && w.x0 - cur.x1 < Math.min(w.h, cur.h) * 1.0) {
          cur.words.push(w);
          cur.x1 = Math.max(cur.x1, w.x1); cur.y0 = Math.min(cur.y0, w.y0); cur.y1 = Math.max(cur.y1, w.y1); cur.h = Math.max(cur.h, w.h);
        } else {
          cur = { words: [w], x0: w.x0, x1: w.x1, y0: w.y0, y1: w.y1, h: w.h };
          frags.push(cur);
        }
      }
    }
    for (const f of frags) {
      f.h = median(f.words.map(w => w.h));
      f.text = f.words.map(w => w.t).join(" ");
    }
    return frags;
  }

  /* ---------- 3. reading order ---------- */
  // Recursive layout cut:
  //  a) If a clean vertical gutter runs through the whole region, read the left side, then the right.
  //  b) Otherwise, if most lines respect a gutter but a few cross it (a full-width title, figure
  //     caption or footnote), split the region above and below those spanning lines and recurse.
  //  c) Otherwise it is a single column: read row by row.
  function order(frags, bodyH, out) {
    if (!frags.length) return;
    if (frags.length === 1) { emitLeaf(frags, out); return; }

    const cut = verticalCut(frags, bodyH);
    if (cut !== null) {
      order(frags.filter(f => f.x1 <= cut), bodyH, out);
      order(frags.filter(f => f.x1 > cut), bodyH, out);
      return;
    }

    const gutter = blockedGutter(frags, bodyH);
    if (gutter !== null) {
      const spanning = frags.filter(f => f.x0 < gutter && f.x1 > gutter);
      const rest = frags.filter(f => !(f.x0 < gutter && f.x1 > gutter));
      if (!spanning.length) {
        // a narrow but clean gutter: still two columns
        order(frags.filter(f => f.x1 <= gutter), bodyH, out);
        order(frags.filter(f => f.x1 > gutter), bodyH, out);
        return;
      }
      // group spanning lines into horizontal bands
      spanning.sort((a, b) => a.y0 - b.y0);
      const bands = [];
      for (const s of spanning) {
        const b = bands[bands.length - 1];
        if (b && s.y0 <= b.y1 + bodyH * 0.6) { b.items.push(s); b.y1 = Math.max(b.y1, s.y1); }
        else bands.push({ y0: s.y0, y1: s.y1, items: [s] });
      }
      let remaining = rest;
      for (const b of bands) {
        const above = remaining.filter(f => cy(f) < b.y0);
        remaining = remaining.filter(f => cy(f) >= b.y0);
        order(above, bodyH, out);
        const inside = remaining.filter(f => cy(f) <= b.y1);
        remaining = remaining.filter(f => cy(f) > b.y1);
        emitLeaf([...b.items, ...inside], out);
      }
      order(remaining, bodyH, out);
      return;
    }

    emitLeaf(frags, out);
  }

  function verticalCut(frags, bodyH) {
    const iv = frags.map(f => [f.x0, f.x1]).sort((a, b) => a[0] - b[0]);
    let best = null, bestGap = bodyH * 0.8, end = iv[0][1];
    for (let i = 1; i < iv.length; i++) {
      const gap = iv[i][0] - end;
      if (gap > bestGap) { bestGap = gap; best = end + gap / 2; }
      end = Math.max(end, iv[i][1]);
    }
    return best;
  }

  // Finds a gutter that most lines respect but a few cross. Returns its x position or null.
  function blockedGutter(frags, bodyH) {
    const x0 = Math.min(...frags.map(f => f.x0)), x1 = Math.max(...frags.map(f => f.x1));
    const width = x1 - x0;
    if (width < bodyH * 8) return null;
    const step = Math.max(1, bodyH / 4);
    let best = null, bestScore = 0;
    for (let x = x0 + width * 0.12; x <= x1 - width * 0.12; x += step) {
      let crossing = 0, left = 0, right = 0;
      for (const f of frags) {
        if (f.x0 < x && f.x1 > x) crossing++;
        else if (f.x1 <= x) left++;
        else right++;
      }
      // real columns: several lines on each side, and only a small share crossing
      if (left < 3 || right < 3 || crossing > 0.25 * (left + right)) continue;
      const score = Math.min(left, right) / (crossing + 1);
      if (score > bestScore) { bestScore = score; best = x; }
    }
    return bestScore >= 2 ? best : null;
  }

  function emitLeaf(frags, out) {
    const sorted = [...frags].sort((a, b) => cy(a) - cy(b) || a.x0 - b.x0);
    // rows first, then left to right inside a row
    const rows = [];
    for (const f of sorted) {
      const row = rows[rows.length - 1];
      if (row && Math.abs(cy(f) - row.c) < f.h * 0.5) row.items.push(f);
      else rows.push({ c: cy(f), items: [f] });
    }
    const leaf = { x0: Math.min(...frags.map(f => f.x0)), x1: Math.max(...frags.map(f => f.x1)) };
    for (const row of rows) {
      row.items.sort((a, b) => a.x0 - b.x0);
      for (const f of row.items) { f.leaf = leaf; out.push(f); }
    }
  }

  /* ---------- 4. running headers, footers and page numbers ---------- */
  const PAGE_NO = /^(page\s*)?[\divxlc]+(\s*(of|\/)\s*\d+)?$/i;
  const keyOf = t => t.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
  function inMargin(f, page) { return f.y1 < page.height * 0.1 || f.y0 > page.height * 0.9; }

  /* ---------- public API ---------- */
  async function analyze(pdf, onPage) {
    const pages = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      onPage?.(n, pdf.numPages);
      const page = await pdf.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const words = pageWords(tc, vp);
      pages.push({ num: n, width: vp.width, height: vp.height, frags: fragments(words) });
      page.cleanup();
    }

    // body text size: the font size carrying the most characters
    const sizeChars = new Map();
    for (const p of pages) for (const f of p.frags) {
      const k = Math.round(f.h * 2) / 2;
      sizeChars.set(k, (sizeChars.get(k) || 0) + f.text.length);
    }
    let bodyH = 10, most = 0;
    for (const [k, c] of sizeChars) if (c > most) { most = c; bodyH = k; }

    // text repeated in the top or bottom margin of several pages is a running header or footer
    const seen = new Map();
    for (const p of pages) {
      const keys = new Set(p.frags.filter(f => inMargin(f, p)).map(f => keyOf(f.text)));
      for (const k of keys) seen.set(k, (seen.get(k) || 0) + 1);
    }
    const repeatMin = pages.length >= 3 ? 2 : 99;
    for (const p of pages) {
      const keep = [];
      for (const f of p.frags) {
        const margin = inMargin(f, p);
        const k = keyOf(f.text);
        const skip =
          (margin && (PAGE_NO.test(f.text.trim()) || ((seen.get(k) || 0) >= repeatMin && k.length < 160))) ||
          f.h < bodyH * 0.62 || // figure labels and other tiny print
          (/^[\d*†‡]{1,3}$/.test(f.text) && f.h < bodyH * 0.9); // stray footnote markers
        if (!skip) keep.push(f);
      }
      const out = [];
      order(keep, bodyH, out);
      // mark paragraph starts for sentence skipping and the text-only view
      out.forEach((f, i) => {
        const prev = out[i - 1];
        if (!prev) { f.paraStart = true; return; }
        // the second half of a line split at a wide justified space is not a new paragraph
        if (Math.abs(cy(f) - cy(prev)) < f.h * 0.5 && f.x0 > prev.x1 && f.leaf === prev.leaf) { f.paraStart = false; return; }
        const gap = f.y0 - prev.y1;
        const newColumn = f.leaf !== prev.leaf || f.y0 < prev.y0 - 1;
        const sizeChange = Math.max(f.h, prev.h) / Math.min(f.h, prev.h) > 1.15;
        const shortPrev = prev.x1 < prev.leaf.x1 - bodyH * 1.5 && SENTENCE_END.test(prev.text);
        const indented = f.x0 > f.leaf.x0 + bodyH * 0.6 && prev.x0 <= prev.leaf.x0 + bodyH * 0.3;
        f.paraStart = gap > Math.max(f.h, prev.h) * 0.9 || sizeChange || shortPrev ||
          (indented && SENTENCE_END.test(prev.text)) || (newColumn && SENTENCE_END.test(prev.text));
      });
      p.frags = out;
      p.bodyH = bodyH;
    }
    return { pages, bodyH };
  }

  // Paragraph blocks for the text-only view.
  function toBlocks(analysis) {
    const blocks = [];
    for (const p of analysis.pages) {
      if (!p.frags.length) continue;
      blocks.push({ type: "page", text: "Page " + p.num });
      let cur = null;
      for (const f of p.frags) {
        const heading = f.h > analysis.bodyH * 1.18;
        if (!cur || f.paraStart || (cur.type === "h") !== heading) {
          cur = { type: heading ? "h" : "p", text: "" };
          blocks.push(cur);
        }
        if (cur.text.endsWith("-") && /^[a-z]/.test(f.text)) cur.text = cur.text.slice(0, -1) + f.text;
        else cur.text += (cur.text ? " " : "") + f.text;
      }
    }
    // large print that runs on for sentences is an intro paragraph, not a heading
    for (const b of blocks) if (b.type === "h" && b.text.length > 140) b.type = "p";
    return blocks;
  }

  return { analyze, toBlocks };
})();
