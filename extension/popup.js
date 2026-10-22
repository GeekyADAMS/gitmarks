const $ = (id) => document.getElementById(id);
const send = (message) => chrome.runtime.sendMessage(message);

// Same colour per category as the web page, so a name looks the same in both.
const HUES = [25, 55, 85, 145, 175, 200, 235, 265, 295, 330];
const hue = (name) => {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length];
};

let category = "";
let tab;

function say(text, error = false) {
  $("msg").textContent = text;
  $("msg").className = error ? "msg error" : "msg";
}

function renderChips(categories) {
  $("chips").replaceChildren(
    ...["", ...categories].map((name, i) => {
      const chip = document.createElement("button");
      chip.className = "chip";
      chip.setAttribute("aria-pressed", String(name === category));
      chip.title = i < 9 ? `Press ${i + 1}` : "";
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.cssText = name
        ? `background:oklch(0.7 0.15 ${hue(name)})`
        : "border:1.5px solid var(--muted)";
      chip.append(dot);
      chip.append(name || "Inbox");
      chip.onclick = () => {
        category = name;
        renderChips(categories);
      };
      return chip;
    }),
  );
}

async function save() {
  $("save").disabled = true;
  say("Saving…");
  const note = $("note").value.trim();
  const result = await send({
    type: "save",
    payload: { urls: [tab.url], category, ...(note ? { note } : {}) },
  });
  if (!result?.ok) {
    $("save").disabled = false;
    return say(result?.error ?? "Save failed.", true);
  }
  say(`Saved to ${category || "Inbox"} ✓`);
  setTimeout(() => window.close(), 700);
}

async function showSettings(show) {
  $("settings").hidden = !show;
  $("save-view").hidden = show;
  if (show) {
    const { base = "", token = "" } = await chrome.storage.local.get(["base", "token"]);
    $("base").value = base;
    $("token").value = token;
  }
}

$("toggle-settings").onclick = () => showSettings($("settings").hidden);
$("settings").onsubmit = async (event) => {
  event.preventDefault();
  let base;
  try {
    base = new URL($("base").value.trim()).origin;
  } catch {
    return say("Enter your gitmarks address, e.g. https://you.vercel.app", true);
  }
  // The browser shows its own prompt for this one site. It must be the first
  // await in the handler, or the click no longer counts as the user's gesture.
  if (!(await chrome.permissions.request({ origins: [`${base}/*`] }))) {
    return say("gitmarks needs permission to reach that address.", true);
  }
  await chrome.storage.local.set({ base, token: $("token").value.trim() });
  await showSettings(false);
  load();
};
$("save").onclick = save;

document.addEventListener("keydown", (event) => {
  if (!$("settings").hidden) return;
  const inNote = event.target === $("note");
  // Enter saves; inside the note it is a newline unless ⌘ is held.
  if (event.key === "Enter" && (!inNote || event.metaKey)) {
    event.preventDefault();
    save();
  }
  const chips = $("chips").children;
  const n = Number(event.key);
  if (!inNote && n >= 1 && n <= chips.length) chips[n - 1].click();
});

async function load() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $("title").textContent = tab?.title || tab?.url || "";
  $("url").textContent = tab?.url ?? "";
  if (tab?.url)
    $("favicon").src = `https://www.google.com/s2/favicons?domain=${new URL(tab.url).hostname}&sz=64`;
  if (!/^https?:/.test(tab?.url ?? "")) {
    $("save").disabled = true;
    return say("Only web pages can be saved.");
  }

  const { token, base } = await chrome.storage.local.get(["token", "base"]);
  if (!token || !base) {
    say("Add your gitmarks address and secret to connect.");
    return showSettings(true);
  }
  renderChips([]);
  const result = await send({ type: "vault" });
  if (result?.ok) renderChips(result.vault.categories);
  else say(result?.error ?? "Could not load categories.", true);
}

load();
