(() => {
const $ = id => document.getElementById(id);
const COLORS = [
  ["Yellow","#FFE45C"],["Green","#9BEF8A"],["Pink","#FF9ECF"],["Blue","#8DD2FF"],["Orange","#FFB067"]
];
const store = {
  get(k, d){ try{ const v = localStorage.getItem("pacemark:"+k); return v == null ? d : JSON.parse(v); }catch(e){ return d; } },
  set(k, v){ try{ localStorage.setItem("pacemark:"+k, JSON.stringify(v)); }catch(e){} }
};

const S = Object.assign({wpm:250,color:"#FFE45C",style:"marker",chunk:1,zoom:100,punct:true,fade:true,follow:true,pdfView:"pages"}, store.get("settings",{}));
const saveSettings = () => store.set("settings", S);

let words = [];     // span elements
let tokens = [];    // word strings
let sentenceStarts = [];
let pos = 0;
let playing = false;
let timer = null, nextAt = 0;
let docKey = "sample";
let followPausedUntil = 0;
let wakeLock = null;
let currentPdf = null;      // {pdf, analysis, name, key} for the open PDF
let pageObserver = null, resizeTimer = null;
const visiblePages = new Set();
const SENTENCE_RE = /[.!?…]["'”’)\]]*$/;

/* ---------- colors ---------- */
function inkFor(hex){
  const n = parseInt(hex.slice(1),16), r=(n>>16)&255, g=(n>>8)&255, b=n&255;
  const lum = (0.2126*r + 0.7152*g + 0.0722*b)/255;
  return lum > 0.55 ? "#14110A" : "#FFFFFF";
}
function applyColor(hex){
  S.color = hex;
  document.documentElement.style.setProperty("--hl", hex);
  document.documentElement.style.setProperty("--hl-ink", inkFor(hex));
  let matched = false;
  document.querySelectorAll(".sw").forEach(b => {
    const on = b.dataset.c.toLowerCase() === hex.toLowerCase();
    if (on) matched = true;
    b.setAttribute("aria-pressed", on);
  });
  $("customWrap").dataset.on = !matched;
  if (!matched) $("customColor").value = hex.toLowerCase();
  saveSettings();
}
const swWrap = $("swatches");
COLORS.forEach(([name, c]) => {
  const b = document.createElement("button");
  b.type = "button"; b.className = "sw"; b.dataset.c = c; b.style.background = c;
  b.title = name; b.setAttribute("aria-label", name + " highlight");
  b.onclick = () => applyColor(c);
  swWrap.insertBefore(b, $("customWrap"));
});
$("customColor").addEventListener("input", e => applyColor(e.target.value));

/* ---------- document building ---------- */
function setMeta(name, kind, extra){
  $("docmeta").innerHTML = "";
  const parts = [["strong", name], ["span", kind]];
  if (extra) parts.push(["span", extra]);
  parts.forEach(([t, txt]) => { const e = document.createElement(t); e.textContent = txt; $("docmeta").appendChild(e); });
}

// blocks: [{type:'p'|'h'|'page', text}]
function render(blocks, key){
  stop();
  resetPageView();
  const reader = $("reader");
  reader.innerHTML = "";
  words = []; tokens = []; sentenceStarts = [0];
  const frag = document.createDocumentFragment();
  for (const blk of blocks){
    if (blk.type === "page"){
      const d = document.createElement("div"); d.className = "pagemark"; d.textContent = blk.text; frag.appendChild(d); continue;
    }
    const text = blk.text.replace(/\s+/g," ").trim();
    if (!text) continue;
    const el = document.createElement(blk.type === "h" ? "h2" : "p");
    const parts = text.split(" ");
    parts.forEach((wd, j) => {
      const s = document.createElement("span");
      s.className = "w"; s.textContent = wd; s.dataset.i = words.length;
      el.appendChild(s);
      if (j < parts.length - 1) el.appendChild(document.createTextNode(" "));
      words.push(s); tokens.push(wd);
      if (/[.!?…]["'”’)\]]*$/.test(wd)) sentenceStarts.push(words.length);
    });
    // a paragraph boundary also starts a sentence
    if (sentenceStarts[sentenceStarts.length-1] !== words.length) sentenceStarts.push(words.length);
    frag.appendChild(el);
  }
  reader.appendChild(frag);
  restorePosition(key);
  if (!words.length) reader.innerHTML = '<p class="loading">No readable text found in this file. If it is a scanned PDF, it contains images rather than text.</p>';
}

function restorePosition(key, at){
  docKey = key;
  const saved = at ?? store.get("pos:" + key, 0);
  pos = -1;
  goTo(Math.min(saved, Math.max(0, words.length - 1)), false);
}

/* ---------- PDF: original pages with the highlight drawn over the real words ---------- */
async function openPdf(buf){
  if (!window.pdfjsLib || !window.PdfLayout) throw new Error("The PDF reader didn't load. Reload the page and try again.");
  pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
  // Browsers refuse Web Workers on file:// pages, so run the PDF parser on the main thread there.
  if (location.protocol === "file:" && !window.pdfjsWorker) await loadScript("vendor/pdf.worker.min.js");
  return pdfjsLib.getDocument({data: buf}).promise;
}

function showPdf(keepPlace){
  const doc = currentPdf;
  const fraction = keepPlace && words.length ? pos / words.length : null;
  if (S.pdfView === "pages") renderPages(doc);
  else render(PdfLayout.toBlocks(doc.analysis), doc.key);
  if (fraction !== null) restorePosition(doc.key, Math.round(fraction * words.length));
  const n = doc.analysis.pages.length;
  setMeta(doc.name, "PDF", n + (n === 1 ? " page" : " pages"));
  const btn = document.createElement("button");
  btn.type = "button"; btn.className = "linkbtn";
  btn.textContent = S.pdfView === "pages" ? "Show as plain text" : "Show original pages";
  btn.onclick = () => { S.pdfView = S.pdfView === "pages" ? "text" : "pages"; $("pdfView").value = S.pdfView; saveSettings(); showPdf(true); };
  $("docmeta").appendChild(btn);
  if (!words.length){
    const note = document.createElement("span");
    note.className = "err";
    note.textContent = "No selectable text found. This looks like a scanned PDF, which needs OCR first.";
    $("docmeta").appendChild(note);
  }
}

function renderPages(doc){
  stop();
  resetPageView();
  const reader = $("reader");
  reader.innerHTML = "";
  reader.classList.add("layout");
  words = []; tokens = []; sentenceStarts = [0];
  const frag = document.createDocumentFragment();
  for (const pg of doc.analysis.pages){
    const div = document.createElement("div");
    div.className = "pdfpage";
    div.style.aspectRatio = `${pg.width} / ${pg.height}`;
    div.setAttribute("aria-label", "Page " + pg.num);
    div._pg = pg;
    div.appendChild(document.createElement("canvas"));
    for (const f of pg.frags){
      if (f.paraStart && sentenceStarts[sentenceStarts.length - 1] !== words.length) sentenceStarts.push(words.length);
      f.words.forEach((w, j) => {
        const s = document.createElement("span");
        s.className = "w"; s.dataset.i = words.length;
        // --gap stretches the "already read" shading over the space before the next word
        const next = f.words[j + 1], ww = Math.max(0.1, w.x1 - w.x0);
        const gap = next ? Math.max(0, next.x0 - w.x1) / ww * 100 : 0;
        s.style.cssText = `left:${w.x0 / pg.width * 100}%;top:${w.y0 / pg.height * 100}%;width:${ww / pg.width * 100}%;height:${(w.y1 - w.y0) / pg.height * 100}%;--gap:${gap.toFixed(1)}%`;
        div.appendChild(s);
        words.push(s); tokens.push(w.t);
        if (SENTENCE_RE.test(w.t)) sentenceStarts.push(words.length);
      });
    }
    frag.appendChild(div);
  }
  reader.appendChild(frag);
  // draw pages only when they are near the screen, and free them again when far away
  pageObserver = new IntersectionObserver(entries => {
    for (const en of entries){
      if (en.isIntersecting){ visiblePages.add(en.target); drawPage(en.target); }
      else { visiblePages.delete(en.target); clearPage(en.target); }
    }
  }, {rootMargin: "1500px 0px"});
  reader.querySelectorAll(".pdfpage").forEach(d => pageObserver.observe(d));
  restorePosition(doc.key);
}

async function drawPage(div){
  const doc = currentPdf;
  const width = div.clientWidth;
  if (!doc || !width) return;
  // cap the bitmap size so 300% zoom on a sharp screen doesn't exhaust memory
  const target = Math.min(4096, Math.round(width * Math.min(window.devicePixelRatio || 1, 2.5)));
  if (div._drawn === target) return;
  div._drawn = target;
  div._task?.cancel();
  const page = await doc.pdf.getPage(div._pg.num);
  const viewport = page.getViewport({scale: target / div._pg.width});
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(viewport.width); canvas.height = Math.round(viewport.height);
  div._task = page.render({canvasContext: canvas.getContext("2d"), viewport});
  try { await div._task.promise; } catch (e) { return; }   // cancelled by a newer draw
  if (div._drawn !== target || !div.isConnected) return;
  div.querySelector("canvas").replaceWith(canvas);
}
function clearPage(div){
  div._task?.cancel();
  if (!div._drawn) return;
  div._drawn = 0;
  div.querySelector("canvas").replaceWith(document.createElement("canvas"));
}
function resetPageView(){
  pageObserver?.disconnect();
  pageObserver = null;
  visiblePages.clear();
  $("reader").classList.remove("layout");
}
// redraw sharper pages after zooming or resizing the window
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => visiblePages.forEach(drawPage), 200);
}).observe($("reader"));

/* ---------- highlighting ---------- */
function goTo(i, scroll = true){
  if (!words.length) { updateStats(); return; }
  i = Math.max(0, Math.min(i, words.length - 1));
  const old = pos;
  // clear old chunk
  for (let k = Math.max(0, old); k < Math.min(words.length, old + 3); k++) words[k].classList.remove("on");
  // update read state
  if (old < 0) { for (let k = 0; k < i; k++) words[k].classList.add("read"); }
  else if (i > old) { for (let k = old; k < i; k++) words[k].classList.add("read"); }
  else { for (let k = i; k < old; k++) words[k].classList.remove("read"); }
  pos = i;
  for (let k = i; k < Math.min(words.length, i + +S.chunk); k++) { words[k].classList.add("on"); words[k].classList.remove("read"); }
  if (scroll) follow();
  updateStats();
  if (pos % 20 === 0 || !playing) store.set("pos:" + docKey, pos);
}

function follow(){
  if (!S.follow || performance.now() < followPausedUntil) return;
  const el = words[pos]; if (!el) return;
  const r = el.getBoundingClientRect();
  const avail = window.innerHeight - document.querySelector(".bar").offsetHeight;
  if (r.bottom < 0 || r.top > avail) glideTo(window.scrollY + r.top - avail * 0.35, 0.25);
  else if (r.top < avail * 0.12 || r.bottom > avail * 0.6) glideTo(window.scrollY + r.top - avail * 0.42, 0.06);
  // zoomed in past the window width: slide sideways to keep the word in view
  const reader = $("reader");
  if (reader.scrollWidth > reader.clientWidth + 1){
    const box = reader.getBoundingClientRect();
    if (r.left < box.left + box.width * 0.1 || r.right > box.right - box.width * 0.1){
      const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
      reader.scrollTo({left: reader.scrollLeft + r.left - box.left - box.width * 0.3, behavior: reduce ? "auto" : "smooth"});
    }
  }
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

function fmtTime(min){
  const s = Math.max(0, Math.round(min * 60));
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), ss = s%60;
  return h ? `${h}:${String(m).padStart(2,"0")}:${String(ss).padStart(2,"0")}` : `${m}:${String(ss).padStart(2,"0")}`;
}
function updateStats(){
  const n = words.length, done = n ? pos : 0;
  $("stats").textContent = `${(done).toLocaleString()} / ${n.toLocaleString()} words · ${fmtTime((n - done)/S.wpm)} left`;
  $("progressFill").style.width = n ? (pos / Math.max(1, n - 1) * 100) + "%" : "0";
}

/* ---------- pacing ---------- */
function delayFor(i){
  const base = 60000 / S.wpm;
  let total = 0;
  const end = Math.min(words.length, i + +S.chunk);
  for (let k = i; k < end; k++){
    let f = 1;
    if (S.punct){
      const w = tokens[k];
      if (/[.!?…]["'”’)\]]*$/.test(w)) f = 2;
      else if (/[,;:—–]["'”’)\]]*$/.test(w)) f = 1.45;
      if (w.length > 9) f += 0.25;
    }
    total += base * f;
  }
  return total;
}
function tick(){
  if (!playing) return;
  const nextPos = pos + +S.chunk;
  if (nextPos >= words.length){ stop(); store.set("pos:" + docKey, 0); return; }
  goTo(nextPos);
  nextAt += delayFor(pos);
  timer = setTimeout(tick, Math.max(0, nextAt - performance.now()));
}
async function play(){
  if (!words.length) return;
  if (pos >= words.length - 1) goTo(0);
  playing = true; setPlayIcon();
  follow();
  nextAt = performance.now() + delayFor(pos);
  timer = setTimeout(tick, delayFor(pos));
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch(e) {}
}
function stop(){
  playing = false; clearTimeout(timer); setPlayIcon();
  store.set("pos:" + docKey, Math.max(0,pos));
  try { wakeLock?.release(); } catch(e) {} wakeLock = null;
}
const toggle = () => playing ? stop() : play();
function setPlayIcon(){
  $("playIcon").innerHTML = playing ? '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>' : '<path d="M7 4.5v15l13-7.5z"/>';
  $("playBtn").setAttribute("aria-label", playing ? "Pause" : "Play");
}
function restartClock(){ if (playing){ clearTimeout(timer); nextAt = performance.now() + delayFor(pos); timer = setTimeout(tick, delayFor(pos)); } }
function jump(i){ goTo(i); restartClock(); }
function sentenceJump(dir){
  let idx = sentenceStarts.findIndex(s => s > pos);
  if (idx === -1) idx = sentenceStarts.length;
  const cur = sentenceStarts[idx - 1] ?? 0;
  if (dir < 0){
    const target = (pos - cur < 3) ? (sentenceStarts[idx - 2] ?? 0) : cur;
    jump(target);
  } else jump(sentenceStarts[idx] ?? words.length - 1);
}

/* ---------- controls ---------- */
$("playBtn").onclick = toggle;
$("backBtn").onclick = () => sentenceJump(-1);
$("fwdBtn").onclick = () => sentenceJump(1);
$("reader").addEventListener("click", e => {
  const w = e.target.closest(".w"); if (!w) return;
  jump(+w.dataset.i);
});
$("progress").addEventListener("click", e => {
  const r = e.currentTarget.getBoundingClientRect();
  followPausedUntil = 0;
  jump(Math.round((e.clientX - r.left) / r.width * (words.length - 1)));
});
function setWpm(v){
  S.wpm = Math.max(60, Math.min(1000, v));
  $("wpm").value = S.wpm; $("wpmOut").textContent = S.wpm;
  updateStats(); saveSettings();
}
$("wpm").addEventListener("input", e => setWpm(+e.target.value));
$("style").addEventListener("change", e => { S.style = e.target.value; applyLook(); saveSettings(); });
$("chunk").addEventListener("change", e => { S.chunk = +e.target.value; const p = pos; for (let k=Math.max(0,p);k<Math.min(words.length,p+3);k++) words[k].classList.remove("on"); pos = p; goTo(p, false); saveSettings(); });

/* ---------- zoom and full screen ---------- */
// zoom is a percentage, or "fit" to fill the window width. It sizes the pages in the original-pages
// view and the text in the plain-text view.
const ZOOMS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300];
function zoomBy(dir){
  const cur = S.zoom === "fit" ? fitPercent() : S.zoom;
  const next = dir > 0 ? ZOOMS.find(z => z > cur + 1) : [...ZOOMS].reverse().find(z => z < cur - 1);
  setZoom(next ?? (dir > 0 ? ZOOMS[ZOOMS.length - 1] : ZOOMS[0]));
}
// the zoom level that "fit" currently amounts to, relative to the 920px page used at 100%
function fitPercent(){ return Math.round($("reader").clientWidth / Math.min(920, $("reader").clientWidth) * 100); }
function setZoom(z){
  S.zoom = z;
  applyLook();
  saveSettings();
  // keep the current word in view and redraw pages at the new size
  centerCurrent();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => visiblePages.forEach(drawPage), 300);
}
// bring the current word back to the middle once a zoom or full-screen change has settled
let centerTimer = null;
function centerCurrent(){
  clearTimeout(centerTimer);
  centerTimer = setTimeout(() => {
    const el = words[pos]; if (!el) return;
    stopGlide();
    const r = el.getBoundingClientRect();
    const avail = window.innerHeight - document.querySelector(".bar").offsetHeight;
    window.scrollTo({top: window.scrollY + r.top - avail * 0.4, behavior: "instant"});
    const reader = $("reader"), box = reader.getBoundingClientRect();
    if (reader.scrollWidth > reader.clientWidth + 1) reader.scrollLeft += r.left - box.left - box.width * 0.3;
  }, 250);
}
$("zoomIn").onclick = () => zoomBy(1);
$("zoomOut").onclick = () => zoomBy(-1);
$("zoomVal").onclick = () => setZoom(100);
$("fitBtn").onclick = () => setZoom(S.zoom === "fit" ? 100 : "fit");

function setFull(on){
  document.body.classList.toggle("focus", on);
  $("fullBtn").setAttribute("aria-pressed", on);
  $("fullIcon").innerHTML = on
    ? '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>'
    : '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>';
}
async function toggleFull(){
  const on = !document.body.classList.contains("focus");
  setFull(on);
  try {
    if (on && !document.fullscreenElement) await document.documentElement.requestFullscreen?.();
    else if (!on && document.fullscreenElement) await document.exitFullscreen();
  } catch (e) { /* full-screen not allowed here: the distraction-free layout still applies */ }
  centerCurrent();
}
$("fullBtn").onclick = toggleFull;
// leaving full screen with Esc also leaves the distraction-free layout
document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement) setFull(false); centerCurrent(); });
$("pdfView").addEventListener("change", e => { S.pdfView = e.target.value; saveSettings(); if (currentPdf) showPdf(true); });
$("punct").addEventListener("change", e => { S.punct = e.target.checked; saveSettings(); });
$("fadeRead").addEventListener("change", e => { S.fade = e.target.checked; applyLook(); saveSettings(); });
$("follow").addEventListener("change", e => { S.follow = e.target.checked; saveSettings(); });
$("settingsBtn").onclick = () => {
  const s = $("settings"); s.hidden = !s.hidden;
  $("settingsBtn").setAttribute("aria-expanded", !s.hidden);
};
function applyLook(){
  const r = $("reader");
  r.classList.remove("style-marker","style-underline","style-box");
  r.classList.add("style-" + S.style);
  r.classList.toggle("fade", S.fade);
  const z = S.zoom === "fit" ? null : S.zoom / 100;
  document.documentElement.style.setProperty("--fs", Math.round(20 * (z ?? 1)) + "px");
  r.style.setProperty("--pagew", z === null ? "100%" : `calc(min(920px, 100%) * ${z})`);
  $("zoomVal").textContent = S.zoom === "fit" ? "Fit" : S.zoom + "%";
  $("fitBtn").setAttribute("aria-pressed", S.zoom === "fit");
}
// manual scrolling during playback pauses auto-follow for a few seconds
["wheel","touchmove"].forEach(ev => window.addEventListener(ev, () => { stopGlide(); if (playing) followPausedUntil = performance.now() + 4000; }, {passive:true}));

document.addEventListener("keydown", e => {
  if (e.target.closest("textarea, input[type=text], select")) return;
  if (e.key === " " ){ e.preventDefault(); toggle(); }
  else if (e.key === "ArrowRight"){ e.preventDefault(); e.shiftKey ? sentenceJump(1) : jump(pos + 1); }
  else if (e.key === "ArrowLeft"){ e.preventDefault(); e.shiftKey ? sentenceJump(-1) : jump(pos - 1); }
  else if (e.key === "ArrowUp"){ e.preventDefault(); setWpm(S.wpm + 10); }
  else if (e.key === "ArrowDown"){ e.preventDefault(); setWpm(S.wpm - 10); }
  else if (e.ctrlKey || e.metaKey || e.altKey) return;
  else if (e.key === "+" || e.key === "="){ e.preventDefault(); zoomBy(1); }
  else if (e.key === "-" || e.key === "_"){ e.preventDefault(); zoomBy(-1); }
  else if (e.key === "0"){ e.preventDefault(); setZoom("fit"); }
  else if (e.key === "f" || e.key === "F"){ e.preventDefault(); toggleFull(); }
});

/* ---------- file loading ---------- */
$("openBtn").onclick = () => $("fileInput").click();
$("fileInput").addEventListener("change", e => { const f = e.target.files[0]; if (f) loadFile(f); e.target.value = ""; });
$("pasteBtn").onclick = () => { $("pastePanel").hidden = false; $("pasteText").focus(); };
$("pasteCancel").onclick = () => { $("pastePanel").hidden = true; };
$("pasteGo").onclick = () => {
  const t = $("pasteText").value.trim(); if (!t) return;
  $("pastePanel").hidden = true;
  currentPdf?.pdf.destroy(); currentPdf = null;
  const blocks = textToBlocks(t);
  setMeta("Pasted text", "Text", "");
  render(blocks, "paste:" + t.length + ":" + t.slice(0, 40));
  window.scrollTo({top:0});
};

let dragDepth = 0;
window.addEventListener("dragenter", e => { if (e.dataTransfer?.types?.includes("Files")){ dragDepth++; $("drop").hidden = false; } });
window.addEventListener("dragleave", () => { if (--dragDepth <= 0){ dragDepth = 0; $("drop").hidden = true; } });
window.addEventListener("dragover", e => e.preventDefault());
window.addEventListener("drop", e => {
  e.preventDefault(); dragDepth = 0; $("drop").hidden = true;
  const f = e.dataTransfer?.files?.[0]; if (f) loadFile(f);
});

function textToBlocks(t){
  return t.replace(/\r/g,"").split(/\n\s*\n/).map(p => {
    const line = p.replace(/-\n(?=[a-z])/g, "").replace(/\n/g, " ").trim();
    const m = line.match(/^#{1,6}\s+(.*)/);
    return m ? {type:"h", text:m[1]} : {type:"p", text:line.replace(/^[*_>-]\s+/, "")};
  }).filter(b => b.text);
}

async function loadFile(f){
  stop();
  const name = f.name, ext = name.split(".").pop().toLowerCase();
  const key = "file:" + name + ":" + f.size;
  $("reader").innerHTML = '<p class="loading">Reading ' + escapeHtml(name) + '…</p>';
  setMeta(name, "Loading…", "");
  window.scrollTo({top:0});
  try{
    if (!(ext === "pdf" || f.type === "application/pdf")) { currentPdf?.pdf.destroy(); currentPdf = null; }
    if (ext === "pdf" || f.type === "application/pdf"){
      const pdf = await openPdf(await f.arrayBuffer());
      const analysis = await PdfLayout.analyze(pdf, (n, total) => setMeta(name, "PDF", `reading page ${n} of ${total}`));
      currentPdf?.pdf.destroy();
      currentPdf = {pdf, analysis, name, key};
      showPdf(false);
      return;
    } else if (ext === "docx"){
      if (!window.mammoth) throw new Error("The Word reader didn't load. Reload the page and try again.");
      const res = await mammoth.extractRawText({arrayBuffer: await f.arrayBuffer()});
      setMeta(name, "Word document", "");
      render(textToBlocks(res.value), key);
    } else if (ext === "html" || ext === "htm"){
      const doc = new DOMParser().parseFromString(await f.text(), "text/html");
      setMeta(name, "Web page", "");
      render(textToBlocks(doc.body.innerText || doc.body.textContent), key);
    } else if (ext === "doc"){
      throw new Error("Old .doc files aren't supported. Save it as .docx or PDF and open that instead.");
    } else {
      setMeta(name, "Text", "");
      render(textToBlocks(await f.text()), key);
    }
  } catch(err){
    $("reader").innerHTML = '<p class="loading err"></p>';
    $("reader").firstChild.textContent = "Couldn't open " + name + ": " + (err.message || err);
    setMeta(name, "Error", "");
  }
}
function loadScript(src){
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src; el.onload = resolve; el.onerror = () => reject(new Error("Couldn't load " + src));
    document.head.appendChild(el);
  });
}
function escapeHtml(s){ return s.replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }

/* ---------- init ---------- */
const SAMPLE = [
  {type:"h", text:"Sample: reading with a pacer"},
  {type:"p", text:"Your eyes don't glide across a line of text. They jump, stop, and sometimes slip backwards to a word they already passed. Those small backward jumps, called regressions, are one of the quiet reasons reading a dense document feels slow and tiring."},
  {type:"p", text:"A pacer gives your eyes something to follow. For centuries readers used a finger or the edge of a card; this page uses a moving highlight instead. Set a speed you can comfortably keep up with, press play, and let the marker lead. When your attention drifts, the color pulls it back to exactly where you were."},
  {type:"p", text:"Start a little below your natural speed, around 200 to 250 words per minute, and raise it by ten or twenty once the pace feels easy. Most people find that comprehension holds up well past where they expected, as long as the material isn't brand new to them."},
  {type:"p", text:"Open a PDF, a Word document or a text file with the button at the top, or drag one onto the page. Click any word to start from there. Your speed, color and position in each file are remembered on this device, so you can close the tab and pick up later."}
];
$("wpm").value = S.wpm; $("wpmOut").textContent = S.wpm;
$("style").value = S.style; $("chunk").value = String(S.chunk);
$("pdfView").value = S.pdfView; $("punct").checked = S.punct; $("fadeRead").checked = S.fade; $("follow").checked = S.follow;
applyColor(S.color); applyLook();
// ?src=<url> opens a remote document (used by the browser extension to hand over PDFs).
const src = new URLSearchParams(location.search).get("src");
if (src) {
  const name = decodeURIComponent(src.split(/[?#]/)[0].split("/").pop() || "document.pdf");
  $("reader").innerHTML = '<p class="loading">Downloading ' + escapeHtml(name) + '…</p>';
  fetch(src)
    .then(r => { if (!r.ok) throw new Error("the server answered " + r.status); return r.blob(); })
    .then(b => loadFile(new File([b], /\.\w+$/.test(name) ? name : name + ".pdf", {type: b.type})))
    .catch(err => {
      $("reader").innerHTML = '<p class="loading err"></p>';
      $("reader").firstChild.textContent = "Couldn't download " + name + ": " + err.message + ". Save the file and open it with Open file instead.";
    });
} else {
  setMeta("Sample passage", "Open a file to read your own", "");
  render(SAMPLE, "sample");
}

// When installed as an app, files opened with "Open with → Pacemark" arrive here.
if ("launchQueue" in window) {
  window.launchQueue.setConsumer(async params => {
    if (params.files?.length) loadFile(await params.files[0].getFile());
  });
}

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  // When an update takes over an already-open window, reload once so the new version shows right away.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloading || playing) return;
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.register("sw.js", {updateViaCache: "none"})
    .then(reg => reg.update())
    .catch(() => {});
}
})();
