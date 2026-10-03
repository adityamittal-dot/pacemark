(() => {
const $ = id => document.getElementById(id);
const COLORS = [
  ["Yellow","#FFE45C"],["Green","#9BEF8A"],["Pink","#FF9ECF"],["Blue","#8DD2FF"],["Orange","#FFB067"]
];
const store = {
  get(k, d){ try{ const v = localStorage.getItem("pacemark:"+k); return v == null ? d : JSON.parse(v); }catch(e){ return d; } },
  set(k, v){ try{ localStorage.setItem("pacemark:"+k, JSON.stringify(v)); }catch(e){} }
};

const S = Object.assign({wpm:250,color:"#FFE45C",style:"marker",chunk:1,fontSize:20,punct:true,fade:true,follow:true}, store.get("settings",{}));
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
  docKey = key;
  const saved = store.get("pos:" + key, 0);
  pos = -1;
  goTo(Math.min(saved, Math.max(0, words.length - 1)), false);
  if (!words.length) reader.innerHTML = '<p class="loading">No readable text found in this file. If it is a scanned PDF, it contains images rather than text.</p>';
}

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
$("fontSize").addEventListener("input", e => { S.fontSize = +e.target.value; applyLook(); saveSettings(); });
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
  document.documentElement.style.setProperty("--fs", S.fontSize + "px");
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
});

/* ---------- file loading ---------- */
$("openBtn").onclick = () => $("fileInput").click();
$("fileInput").addEventListener("change", e => { const f = e.target.files[0]; if (f) loadFile(f); e.target.value = ""; });
$("pasteBtn").onclick = () => { $("pastePanel").hidden = false; $("pasteText").focus(); };
$("pasteCancel").onclick = () => { $("pastePanel").hidden = true; };
$("pasteGo").onclick = () => {
  const t = $("pasteText").value.trim(); if (!t) return;
  $("pastePanel").hidden = true;
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
    if (ext === "pdf" || f.type === "application/pdf"){
      const blocks = await readPdf(await f.arrayBuffer(), n => setMeta(name, "PDF", "extracting page " + n));
      const pages = blocks.filter(b => b.type === "page").length;
      setMeta(name, "PDF", pages + (pages === 1 ? " page" : " pages"));
      render(blocks, key);
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

async function readPdf(buf, onPage){
  if (!window.pdfjsLib) throw new Error("The PDF reader didn't load. Reload the page and try again.");
  pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
  // Browsers refuse Web Workers on file:// pages, so run the PDF parser on the main thread there.
  if (location.protocol === "file:" && !window.pdfjsWorker) await loadScript("vendor/pdf.worker.min.js");
  const pdf = await pdfjsLib.getDocument({data: buf}).promise;
  const blocks = [];
  for (let p = 1; p <= pdf.numPages; p++){
    onPage?.(p);
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    // group items into lines
    const lines = []; let cur = null;
    for (const it of tc.items){
      if (!("str" in it)) continue;
      if (!it.str && !it.hasEOL) continue;
      const y = it.transform[5], h = Math.abs(it.transform[3]) || it.height || 0;
      if (!it.str){ if (cur && cur.t.trim()) lines.push(cur); cur = null; continue; }
      if (!cur || Math.abs(y - cur.y) > Math.max(h, cur.h) * 0.5){
        if (cur && cur.t.trim()) lines.push(cur);
        cur = {t: "", y, h};
      }
      cur.h = Math.max(cur.h, h);
      cur.t += it.str;
      if (it.hasEOL){ if (cur.t.trim()) lines.push(cur); cur = null; }
    }
    if (cur && cur.t.trim()) lines.push(cur);
    if (!lines.length) continue;
    blocks.push({type:"page", text:"Page " + p});
    // Paragraph breaks: a gap well beyond the font size, a jump back up (new column) or a change of font size.
    const sizes = lines.map(l => l.h).sort((a, b) => a - b);
    const bodySize = sizes[Math.floor(sizes.length / 2)] || 10;
    let para = "", paraSize = 0;
    const flush = () => {
      if (para.trim()) blocks.push({type: paraSize > bodySize * 1.25 && para.length < 160 ? "h" : "p", text: para});
      para = "";
    };
    lines.forEach((ln, i) => {
      const text = ln.t.replace(/\s+/g, " ").trim();
      if (i > 0){
        const prev = lines[i-1];
        const gap = prev.y - ln.y;
        const sizeChange = Math.max(ln.h, prev.h) / Math.max(1, Math.min(ln.h, prev.h)) > 1.2;
        if (gap > Math.max(ln.h, prev.h) * 1.6 || gap < -2 || sizeChange) flush();
      }
      if (!para) paraSize = ln.h;
      if (para.endsWith("-") && /^[a-z]/.test(text)) para = para.slice(0, -1) + text;
      else para += (para ? " " : "") + text;
    });
    flush();
  }
  return blocks;
}

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
$("fontSize").value = S.fontSize; $("punct").checked = S.punct; $("fadeRead").checked = S.fade; $("follow").checked = S.follow;
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
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
})();
