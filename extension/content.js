// Pacemark page pacer: highlights the words of the current page at a chosen reading speed.
// Injected on demand by the popup, the keyboard shortcut or the context menu.
(() => {
  if (window.__pacemark) return;

  const DEFAULTS = { wpm: 250, color: "#FFE45C", style: "marker", chunk: 1, punct: true, fade: true };
  const COLORS = ["#FFE45C", "#9BEF8A", "#FF9ECF", "#8DD2FF", "#FFB067"];
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT", "BUTTON", "OPTION",
    "CODE", "PRE", "SVG", "MATH", "CANVAS", "IFRAME", "NAV", "ASIDE", "FOOTER", "FORM", "LABEL", "SUP", "FIGCAPTION"]);
  const SENTENCE_END = /[.!?…]["'”’)\]]*$/;
  const CLAUSE_END = /[,;:—–]["'”’)\]]*$/;

  let S = { ...DEFAULTS };
  let words = [], tokens = [], sentenceStarts = [], wrapped = [];
  let pos = 0, playing = false, timer = null, nextAt = 0, followPausedUntil = 0;
  let active = false, host = null, ui = null, styleEl = null;

  /* ---------- finding the readable part of the page ---------- */
  function findRoot() {
    const textLen = el => (el.innerText || "").length;
    const articles = [...document.querySelectorAll("article")].filter(a => textLen(a) > 600);
    if (articles.length) return articles.sort((a, b) => textLen(b) - textLen(a))[0];
    // score each paragraph's parent by how much paragraph text it holds
    const scores = new Map();
    for (const p of document.querySelectorAll("p")) {
      const len = (p.textContent || "").trim().length;
      if (len < 40 || !p.parentElement) continue;
      scores.set(p.parentElement, (scores.get(p.parentElement) || 0) + len);
    }
    let best = null, bestScore = 0;
    for (const [el, sc] of scores) if (sc > bestScore) { best = el; bestScore = sc; }
    if (best && bestScore > 400) {
      // widen to the parent when siblings carry a lot of the text too (headings, lists, split sections)
      const parent = best.parentElement;
      if (parent && parent !== document.body && textLen(parent) < textLen(best) * 1.8) best = parent;
      return best;
    }
    return document.querySelector("main, [role=main]") || document.body;
  }

  function isHidden(el, cache) {
    if (cache.has(el)) return cache.get(el);
    const st = getComputedStyle(el);
    const hidden = st.display === "none" || st.visibility === "hidden" || el.getAttribute("aria-hidden") === "true";
    cache.set(el, hidden);
    return hidden;
  }

  function collectTextNodes(root) {
    const cache = new Map();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType !== Node.TEXT_NODE || !node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
        for (let el = node.parentElement; el && el !== root.parentElement; el = el.parentElement) {
          if (SKIP.has(el.tagName) || el.isContentEditable || el.id === "pacemark-host" || isHidden(el, cache)) return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const out = [];
    while (walker.nextNode()) out.push(walker.currentNode);
    return out;
  }

  const BLOCK = /^(P|LI|H[1-6]|BLOCKQUOTE|DD|DT|TD|TH|DIV|SECTION|ARTICLE)$/;
  const blockOf = node => { let el = node.parentElement; while (el && !BLOCK.test(el.tagName)) el = el.parentElement; return el; };

  function wrapWords(root) {
    words = []; tokens = []; sentenceStarts = [0]; wrapped = [];
    let lastBlock = null;
    for (const node of collectTextNodes(root)) {
      const block = blockOf(node);
      if (block !== lastBlock && words.length && sentenceStarts[sentenceStarts.length - 1] !== words.length) sentenceStarts.push(words.length);
      lastBlock = block;
      const frag = document.createDocumentFragment();
      const inserted = [];
      for (const part of node.nodeValue.split(/(\s+)/)) {
        if (!part) continue;
        let n;
        if (/^\s+$/.test(part)) n = document.createTextNode(part);
        else {
          n = document.createElement("span");
          n.className = "pm-w"; n.textContent = part; n.dataset.pmI = words.length;
          words.push(n); tokens.push(part);
          if (SENTENCE_END.test(part)) sentenceStarts.push(words.length);
        }
        frag.appendChild(n); inserted.push(n);
      }
      wrapped.push([node, inserted]);
      node.replaceWith(frag);
    }
  }

  function unwrapWords() {
    for (const [orig, inserted] of wrapped) {
      const first = inserted[0];
      if (first && first.parentNode) {
        first.parentNode.insertBefore(orig, first);
        inserted.forEach(n => n.remove());
      }
    }
    wrapped = []; words = []; tokens = [];
  }

  /* ---------- highlight + pacing ---------- */
  function inkFor(hex) {
    const n = parseInt(hex.slice(1), 16);
    const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
    return lum > 0.55 ? "#14110A" : "#FFFFFF";
  }

  function pageCss() {
    const hl = S.color, ink = inkFor(hl);
    const on = {
      marker: `background:${hl}!important;color:${ink}!important;box-shadow:0 0 0 .14em ${hl}!important;border-radius:3px!important;`,
      underline: `box-shadow:inset 0 -.32em 0 ${hl}!important;`,
      box: `box-shadow:0 0 0 2px ${hl}!important;border-radius:3px!important;`
    }[S.style] || "";
    return `.pm-w{cursor:pointer}
      .pm-w.pm-on{${on}}
      ${S.fade ? ".pm-w.pm-read{opacity:.45}" : ""}`;
  }
  function applyLook() { if (styleEl) styleEl.textContent = pageCss(); renderUi(); }

  function goTo(i, scroll = true) {
    if (!words.length) return;
    i = Math.max(0, Math.min(i, words.length - 1));
    const old = pos;
    for (let k = Math.max(0, old); k < Math.min(words.length, old + 3); k++) words[k].classList.remove("pm-on");
    if (i > old) for (let k = old; k < i; k++) words[k].classList.add("pm-read");
    else for (let k = i; k < old; k++) words[k].classList.remove("pm-read");
    pos = i;
    for (let k = i; k < Math.min(words.length, i + +S.chunk); k++) words[k].classList.add("pm-on"), words[k].classList.remove("pm-read");
    if (scroll) follow();
    renderUi();
  }

  function follow() {
    if (performance.now() < followPausedUntil) return;
    const el = words[pos]; if (!el) return;
    const r = el.getBoundingClientRect();
    const avail = window.innerHeight - (host ? 90 : 0);
    if (r.bottom < 0 || r.top > avail) glideTo(window.scrollY + r.top - avail * 0.35, 0.25);
    else if (r.top < avail * 0.12 || r.bottom > avail * 0.6) glideTo(window.scrollY + r.top - avail * 0.42, 0.06);
  }

  /* Smooth follow: as the current word nears the bottom of the view, glide the page up so its line
     settles near the middle; a jump to an off-screen word scrolls there quickly. */
  let glideTarget = 0, glideSpeed = 0, glideRaf = 0;
  function glideTo(y, speed){
    const max = document.documentElement.scrollHeight - window.innerHeight;
    glideTarget = Math.max(0, Math.min(max, y));
    glideSpeed = speed;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches){ window.scrollTo({top: glideTarget, behavior: "instant"}); return; }
    if (!glideRaf) glideRaf = requestAnimationFrame(glideStep);
  }
  function glideStep(){
    const d = glideTarget - window.scrollY;
    if (Math.abs(d) < 1){ window.scrollTo({top: glideTarget, behavior: "instant"}); glideRaf = 0; return; }
    window.scrollTo({top: window.scrollY + d * glideSpeed, behavior: "instant"});
    glideRaf = requestAnimationFrame(glideStep);
  }
  function stopGlide(){ cancelAnimationFrame(glideRaf); glideRaf = 0; }

  function delayFor(i) {
    const base = 60000 / S.wpm;
    let total = 0;
    for (let k = i; k < Math.min(words.length, i + +S.chunk); k++) {
      let f = 1;
      if (S.punct) {
        const w = tokens[k];
        if (SENTENCE_END.test(w)) f = 2; else if (CLAUSE_END.test(w)) f = 1.45;
        if (w.length > 9) f += 0.25;
      }
      total += base * f;
    }
    return total;
  }

  function tick() {
    if (!playing) return;
    const next = pos + +S.chunk;
    if (next >= words.length) { pause(); return; }
    goTo(next);
    nextAt += delayFor(pos);
    timer = setTimeout(tick, Math.max(0, nextAt - performance.now()));
  }
  function play() {
    if (!words.length) return;
    if (pos >= words.length - 1) goTo(0);
    playing = true; follow();
    nextAt = performance.now() + delayFor(pos);
    timer = setTimeout(tick, delayFor(pos));
    renderUi();
  }
  function pause() { playing = false; clearTimeout(timer); renderUi(); }
  const toggle = () => (playing ? pause() : play());
  function restartClock() { if (playing) { clearTimeout(timer); nextAt = performance.now() + delayFor(pos); timer = setTimeout(tick, delayFor(pos)); } }
  function jump(i) { followPausedUntil = 0; goTo(i); restartClock(); }
  function sentenceJump(dir) {
    let idx = sentenceStarts.findIndex(s => s > pos);
    if (idx === -1) idx = sentenceStarts.length;
    const cur = sentenceStarts[idx - 1] ?? 0;
    if (dir < 0) jump(pos - cur < 3 ? (sentenceStarts[idx - 2] ?? 0) : cur);
    else jump(sentenceStarts[idx] ?? words.length - 1);
  }

  function startIndex() {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed) {
      const range = sel.getRangeAt(0);
      const hit = words.findIndex(w => range.intersectsNode(w));
      if (hit >= 0) { sel.removeAllRanges(); return hit; }
    }
    const h = window.innerHeight;
    const visible = words.findIndex(w => { const r = w.getBoundingClientRect(); return r.top >= 0 && r.bottom <= h && r.width > 0; });
    return visible >= 0 ? visible : 0;
  }

  /* ---------- floating control bar ---------- */
  const ICONS = {
    back: '<path d="M11 6v12l-8.5-6zM21 6v12l-8.5-6z"/>',
    fwd: '<path d="M13 6v12l8.5-6zM3 6v12l8.5-6z"/>',
    play: '<path d="M7 4.5v15l13-7.5z"/>',
    pause: '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>',
    close: '<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" fill="none"/>'
  };
  function buildUi() {
    host = document.createElement("div");
    host.id = "pacemark-host";
    host.style.cssText = "all:initial;position:fixed;z-index:2147483647;left:0;right:0;bottom:16px;margin:0 auto;width:max-content;max-width:calc(100vw - 32px)";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>
      :host{--bg:#FFFFFF;--ink:#1B2220;--muted:#66716C;--line:#D5DBD6;--accent:#145A55;--accent-ink:#fff}
      @media (prefers-color-scheme: dark){:host{--bg:#1B211F;--ink:#E2E8E4;--muted:#8E9994;--line:#2C3431;--accent:#5FC4B8;--accent-ink:#0B1513}}
      .bar{font:500 13px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink);background:var(--bg);border:1px solid var(--line);
        border-radius:16px;box-shadow:0 14px 40px -12px rgba(0,0,0,.35);padding:8px 10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
      button{font:inherit;color:inherit;background:none;border:1px solid var(--line);border-radius:50%;width:32px;height:32px;display:grid;place-items:center;cursor:pointer;padding:0}
      button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
      button svg{width:15px;height:15px;fill:currentColor}
      .play{width:40px;height:40px;background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
      .wpm{display:flex;align-items:center;gap:6px}
      .wpm b{font:700 17px/1 ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums;min-width:3.2ch;text-align:right}
      .wpm small{font:500 10px ui-monospace,Menlo,monospace;color:var(--muted);letter-spacing:.08em}
      input[type=range]{width:110px;accent-color:var(--accent)}
      .sw{width:20px;height:20px;border:2px solid var(--bg);box-shadow:0 0 0 1px var(--line)}
      .sw[aria-pressed=true]{box-shadow:0 0 0 2px var(--ink)}
      .prog{font:500 11px ui-monospace,Menlo,monospace;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
      .x{border:none;width:28px;height:28px;color:var(--muted)}
      .group{display:flex;align-items:center;gap:5px}
    </style>
    <div class="bar" role="toolbar" aria-label="Pacemark reading controls">
      <div class="group">
        <button data-act="back" aria-label="Back one sentence"><svg viewBox="0 0 24 24">${ICONS.back}</svg></button>
        <button data-act="play" class="play" aria-label="Play"><svg viewBox="0 0 24 24">${ICONS.play}</svg></button>
        <button data-act="fwd" aria-label="Forward one sentence"><svg viewBox="0 0 24 24">${ICONS.fwd}</svg></button>
      </div>
      <label class="wpm"><b></b><small>WPM</small><input type="range" min="60" max="1000" step="10" aria-label="Words per minute"></label>
      <div class="group swatches">${COLORS.map(c => `<button class="sw" data-color="${c}" style="background:${c}" aria-label="Highlight color ${c}"></button>`).join("")}</div>
      <span class="prog"></span>
      <button data-act="close" class="x" aria-label="Stop highlighting (Esc)"><svg viewBox="0 0 24 24">${ICONS.close}</svg></button>
    </div>`;
    ui = {
      play: root.querySelector("[data-act=play]"),
      wpm: root.querySelector(".wpm b"),
      range: root.querySelector("input[type=range]"),
      prog: root.querySelector(".prog"),
      sw: [...root.querySelectorAll(".sw")]
    };
    root.addEventListener("click", e => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.color) return save({ color: b.dataset.color });
      ({ back: () => sentenceJump(-1), fwd: () => sentenceJump(1), play: toggle, close: deactivate })[b.dataset.act]?.();
    });
    ui.range.addEventListener("input", e => save({ wpm: +e.target.value }));
    document.documentElement.appendChild(host);
    renderUi();
  }
  function renderUi() {
    if (!ui) return;
    ui.play.innerHTML = `<svg viewBox="0 0 24 24">${playing ? ICONS.pause : ICONS.play}</svg>`;
    ui.play.setAttribute("aria-label", playing ? "Pause" : "Play");
    ui.wpm.textContent = S.wpm;
    if (+ui.range.value !== S.wpm) ui.range.value = S.wpm;
    ui.sw.forEach(b => b.setAttribute("aria-pressed", b.dataset.color.toLowerCase() === S.color.toLowerCase()));
    const left = Math.max(0, Math.round((words.length - pos) / S.wpm * 60));
    ui.prog.textContent = `${Math.round(pos / Math.max(1, words.length - 1) * 100)}% · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} left`;
  }

  /* ---------- settings ---------- */
  function save(patch) {
    S = { ...S, ...patch };
    applyLook();
    chrome.storage.sync.set({ settings: S });
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.settings) { S = { ...DEFAULTS, ...changes.settings.newValue }; if (active) applyLook(); }
  });

  /* ---------- input ---------- */
  function onKey(e) {
    if (!active || e.target.closest?.("input, textarea, select, [contenteditable=''], [contenteditable=true]")) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (k === " ") toggle();
    else if (k === "Escape") deactivate();
    else if (k === "ArrowRight") e.shiftKey ? sentenceJump(1) : jump(pos + 1);
    else if (k === "ArrowLeft") e.shiftKey ? sentenceJump(-1) : jump(pos - 1);
    else if (k === "ArrowUp") save({ wpm: Math.min(1000, S.wpm + 10) });
    else if (k === "ArrowDown") save({ wpm: Math.max(60, S.wpm - 10) });
    else return;
    e.preventDefault(); e.stopPropagation();
  }
  function onClick(e) {
    const w = e.target.closest?.(".pm-w");
    if (!w || w.closest("a") || window.getSelection()?.toString()) return;
    e.preventDefault(); e.stopPropagation();
    jump(+w.dataset.pmI);
  }
  const onManualScroll = () => { stopGlide(); if (playing) followPausedUntil = performance.now() + 4000; };

  /* ---------- lifecycle ---------- */
  async function activate(autoplay = true) {
    if (active) { if (autoplay && !playing) play(); return; }
    const stored = await chrome.storage.sync.get("settings");
    S = { ...DEFAULTS, ...(stored.settings || {}) };
    let root = findRoot();
    // If the reader selected text outside the detected article, read the area around the selection instead.
    const sel = window.getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed) {
      const c = sel.getRangeAt(0).commonAncestorContainer;
      const el = c.nodeType === 1 ? c : c.parentElement;
      if (el && !root.contains(el)) root = el.closest("article, main, section") || document.body;
    }
    wrapWords(root);
    if (!words.length) { alertLess("Pacemark couldn't find readable text on this page."); return; }
    active = true;
    styleEl = document.createElement("style");
    styleEl.id = "pacemark-style";
    document.documentElement.appendChild(styleEl);
    buildUi();
    applyLook();
    pos = 0;
    goTo(startIndex());
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("click", onClick, true);
    window.addEventListener("wheel", onManualScroll, { passive: true });
    window.addEventListener("touchmove", onManualScroll, { passive: true });
    if (autoplay) play();
  }
  function deactivate() {
    pause();
    stopGlide();
    active = false;
    unwrapWords();
    styleEl?.remove(); host?.remove();
    styleEl = host = ui = null;
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("click", onClick, true);
    window.removeEventListener("wheel", onManualScroll);
    window.removeEventListener("touchmove", onManualScroll);
  }
  // A small toast instead of alert(), which would block the page.
  function alertLess(msg) {
    const t = document.createElement("div");
    t.textContent = msg;
    t.style.cssText = "all:initial;position:fixed;z-index:2147483647;left:50%;bottom:24px;transform:translateX(-50%);background:#1B2220;color:#fff;font:500 14px system-ui,sans-serif;padding:10px 14px;border-radius:10px";
    document.documentElement.appendChild(t);
    setTimeout(() => t.remove(), 3500);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type === "pacemark:toggle") active ? deactivate() : activate(true);
    else if (msg?.type === "pacemark:start") { if (active) deactivate(); activate(true); }
    else if (msg?.type === "pacemark:status") reply({ active, playing });
  });

  window.__pacemark = { activate, deactivate };
})();
