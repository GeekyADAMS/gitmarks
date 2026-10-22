// Every request to your gitmarks goes through here: one place holds the key,
// and the host permission granted at setup is what lets it skip CORS.

async function settings() {
  const { base = "", token = "" } = await chrome.storage.local.get(["base", "token"]);
  return { base: base.replace(/\/+$/, ""), token };
}

async function api(method, body) {
  const { base, token } = await settings();
  if (!base || !token) {
    return { ok: false, error: "Open the extension and paste your key." };
  }
  try {
    const res = await fetch(`${base}/api/vault`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    // The API answers anyone it does not recognise with a plain 404.
    if (res.status === 404)
      return { ok: false, error: "gitmarks didn't recognise that key. Copy it again from Connect." };
    return await res.json();
  } catch {
    return { ok: false, error: `Could not reach ${base}.` };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message.type === "vault") api("GET").then(reply);
  if (message.type === "save") api("POST", { type: "add", ...message.payload }).then(reply);
  if (message.type === "move") {
    api("POST", { type: "update", id: message.id, patch: { category: message.category } }).then(reply);
  }
  return true; // replying asynchronously
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "link", title: "Save link to gitmarks", contexts: ["link"] });
  chrome.contextMenus.create({ id: "page", title: "Save page to gitmarks", contexts: ["page"] });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const url = info.menuItemId === "link" ? info.linkUrl : info.pageUrl;
  const result = await api("POST", { type: "add", urls: [url] });
  flash(tab?.id, result.ok);
});

/** A tick or a bang on the toolbar icon: the only feedback a menu click gets. */
function flash(tabId, ok) {
  chrome.action.setBadgeBackgroundColor({ color: ok ? "#16a34a" : "#dc2626", tabId });
  chrome.action.setBadgeText({ text: ok ? "✓" : "!", tabId });
  setTimeout(() => chrome.action.setBadgeText({ text: "", tabId }), 2500);
}
