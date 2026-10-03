const DEFAULTS = { wpm: 250, color: "#FFE45C", style: "marker", chunk: 1, punct: true, fade: true };
const COLORS = [["Yellow", "#FFE45C"], ["Green", "#9BEF8A"], ["Pink", "#FF9ECF"], ["Blue", "#8DD2FF"], ["Orange", "#FFB067"]];
const $ = id => document.getElementById(id);
let S = { ...DEFAULTS };

const save = patch => { S = { ...S, ...patch }; chrome.storage.sync.set({ settings: S }); render(); };

function render() {
  $("wpm").value = S.wpm;
  $("wpmOut").textContent = S.wpm;
  $("style").value = S.style;
  $("chunk").value = String(S.chunk);
  $("punct").checked = S.punct;
  $("fade").checked = S.fade;
  let matched = false;
  document.querySelectorAll(".sw").forEach(b => {
    const on = b.dataset.c.toLowerCase() === S.color.toLowerCase();
    matched ||= on;
    b.setAttribute("aria-pressed", on);
  });
  $("customWrap").dataset.on = !matched;
  if (!matched) $("custom").value = S.color.toLowerCase();
}

COLORS.forEach(([name, c]) => {
  const b = document.createElement("button");
  b.type = "button"; b.className = "sw"; b.dataset.c = c; b.style.background = c;
  b.title = name; b.setAttribute("aria-label", name + " highlight");
  b.onclick = () => save({ color: c });
  $("swatches").insertBefore(b, $("customWrap"));
});
$("custom").addEventListener("input", e => save({ color: e.target.value }));
$("wpm").addEventListener("input", e => save({ wpm: +e.target.value }));
$("style").addEventListener("change", e => save({ style: e.target.value }));
$("chunk").addEventListener("change", e => save({ chunk: +e.target.value }));
$("punct").addEventListener("change", e => save({ punct: e.target.checked }));
$("fade").addEventListener("change", e => save({ fade: e.target.checked }));

$("reader").onclick = () => { chrome.runtime.sendMessage({ type: "pacemark:open-reader" }); window.close(); };

function note(text) { $("note").textContent = text; $("note").hidden = !text; }

async function setupPrimary() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const btn = $("primary");
  if (!tab?.id) return;

  let kind = "blocked";
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => document.contentType });
    kind = res?.result === "application/pdf" ? "pdf" : "page";
  } catch (e) {
    if (tab.url && /\.pdf($|[?#])/i.test(tab.url)) kind = "pdf";
  }

  if (kind === "page") {
    const status = await chrome.tabs.sendMessage(tab.id, { type: "pacemark:status" }).catch(() => null);
    btn.textContent = status?.active ? "Stop highlighting" : "Highlight this page";
    btn.disabled = false;
    btn.onclick = async () => {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      await chrome.tabs.sendMessage(tab.id, { type: "pacemark:toggle" });
      window.close();
    };
    note("Select some text first to start from that word.");
  } else if (kind === "pdf") {
    btn.textContent = "Read this PDF in Pacemark";
    btn.disabled = false;
    btn.onclick = () => {
      const origin = tab.url.startsWith("file:") ? "file:///*" : new URL(tab.url).origin + "/*";
      // The reader downloads the PDF itself, so it needs access to the PDF's site.
      chrome.permissions.request({ origins: [origin] }, granted => {
        if (!granted && origin === "file:///*") {
          note("To read local PDFs, turn on \"Allow access to file URLs\" for Pacemark in chrome://extensions.");
          return;
        }
        chrome.runtime.sendMessage({ type: "pacemark:open-reader", src: tab.url });
        window.close();
      });
    };
  } else {
    btn.textContent = "Can't highlight this page";
    note("Chrome doesn't let extensions run on its own pages or the Web Store. Use the reader below instead.");
  }
}

chrome.commands.getAll(cmds => {
  const c = cmds.find(x => x.name === "toggle-pacer");
  if (c?.shortcut) $("shortcut").textContent = c.shortcut;
});

chrome.storage.sync.get("settings", ({ settings }) => { S = { ...DEFAULTS, ...(settings || {}) }; render(); });
setupPrimary();
