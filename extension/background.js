// Pacemark service worker: keyboard shortcut, context menus and script injection.

const READER = "reader/index.html";

async function inject(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
}

async function send(tabId, type) {
  try {
    await inject(tabId);
    await chrome.tabs.sendMessage(tabId, { type });
  } catch (err) {
    // Chrome blocks scripts on its own pages and the built-in PDF viewer; open the reader instead.
    const tab = await chrome.tabs.get(tabId);
    if (tab.url && /\.pdf($|[?#])/i.test(tab.url)) openReader(tab.url);
    else console.warn("Pacemark can't run on this page:", err.message);
  }
}

function openReader(src) {
  const url = chrome.runtime.getURL(READER) + (src ? "?src=" + encodeURIComponent(src) : "");
  chrome.tabs.create({ url });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "pace-page", title: "Highlight this page with Pacemark", contexts: ["page"] });
  chrome.contextMenus.create({ id: "pace-selection", title: "Highlight from here with Pacemark", contexts: ["selection"] });
  chrome.contextMenus.create({ id: "pace-link", title: "Open link in Pacemark reader", contexts: ["link"] });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "pace-link") {
    // The reader downloads the file itself, which needs access to the link's site.
    chrome.permissions.request({ origins: [new URL(info.linkUrl).origin + "/*"] }, () => openReader(info.linkUrl));
  } else if (tab?.id) {
    send(tab.id, "pacemark:start");
  }
});

chrome.commands.onCommand.addListener(async command => {
  if (command !== "toggle-pacer") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) send(tab.id, "pacemark:toggle");
});

chrome.runtime.onMessage.addListener(msg => {
  if (msg?.type === "pacemark:open-reader") openReader(msg.src);
});
