// A "save to gitmarks" button in the action bar of every post on X, beside like
// and repost. One click files it in the inbox; the chips that appear let you
// sort it on the spot, or ignore them and sort later on the web page.

// Icons are built as DOM nodes rather than parsed from markup: no innerHTML
// anywhere, so there is no HTML sink for anything to slip through later.
const SVG = "http://www.w3.org/2000/svg";
function icon(width, shapes) {
  const svg = document.createElementNS(SVG, "svg");
  for (const [k, v] of Object.entries({
    viewBox: "0 0 24 24",
    width: "18.75",
    height: "18.75",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": width,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  })) {
    svg.setAttribute(k, v);
  }
  for (const [tag, attrs] of shapes) {
    const el = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.append(el);
  }
  return svg;
}
const saveIcon = () =>
  icon("1.8", [
    ["rect", { x: "3", y: "4", width: "18", height: "5", rx: "1.5" }],
    ["path", { d: "M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4" }],
  ]);
const doneIcon = () => icon("2.2", [["path", { d: "m5 12.5 4.5 4.5L19 7.5" }]]);
const MUTED = "rgb(113, 118, 123)";
const ACCENT = "rgb(234, 179, 8)";
const HUES = [25, 55, 85, 145, 175, 200, 235, 265, 295, 330];
const hue = (name) => {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length];
};

const isDark = () => {
  const [r, g, b] = getComputedStyle(document.body).backgroundColor.match(/\d+/g).map(Number);
  return r + g + b < 384;
};

let panel;
let panelTimer;

function closePanel() {
  panel?.remove();
  panel = undefined;
}

/** Category chips under the button, for sorting a post the moment it is saved. */
function showPanel(button, id, categories, current) {
  closePanel();
  if (!categories.length) return;
  const dark = isDark();
  const rect = button.getBoundingClientRect();
  panel = document.createElement("div");
  panel.style.cssText = `position:fixed;z-index:9999;top:${rect.bottom + 6}px;left:${Math.max(8, rect.right - 280)}px;
    width:280px;display:flex;flex-wrap:wrap;gap:6px;padding:10px;border-radius:16px;
    font:13px -apple-system,BlinkMacSystemFont,system-ui,sans-serif;
    background:${dark ? "#000" : "#fff"};color:${dark ? "#e7e9ea" : "#0f1419"};
    border:1px solid ${dark ? "#2f3336" : "#eff3f4"};box-shadow:0 8px 28px rgb(0 0 0 / ${dark ? 0.6 : 0.15})`;

  const title = document.createElement("div");
  title.textContent = "Saved to gitmarks — sort it:";
  title.style.cssText = `width:100%;font-size:12px;color:${MUTED};margin-bottom:2px`;
  panel.append(title);

  for (const name of ["", ...categories]) {
    const chip = document.createElement("button");
    const active = name === current;
    chip.style.cssText = `display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;cursor:pointer;
      border-radius:9px;font:inherit;color:inherit;background:${active ? (dark ? "#16181c" : "#f7f9f9") : "transparent"};
      border:1px solid ${active ? MUTED : dark ? "#2f3336" : "#eff3f4"};font-weight:${active ? 600 : 400}`;
    const dot = document.createElement("span");
    dot.style.cssText = `width:8px;height:8px;border-radius:50%;${name ? `background:oklch(0.7 0.15 ${hue(name)})` : `border:1.5px solid ${MUTED}`}`;
    chip.append(dot, name || "Inbox");
    chip.onclick = async (event) => {
      event.stopPropagation();
      const result = await chrome.runtime.sendMessage({ type: "move", id, category: name });
      if (result?.ok) showPanel(button, id, categories, name);
      clearTimeout(panelTimer);
      panelTimer = setTimeout(closePanel, 1200);
    };
    panel.append(chip);
  }

  panel.onmouseenter = () => clearTimeout(panelTimer);
  panel.onmouseleave = () => (panelTimer = setTimeout(closePanel, 800));
  document.body.append(panel);
  clearTimeout(panelTimer);
  panelTimer = setTimeout(closePanel, 5000);
}

function addButton(article) {
  article.dataset.vault = "1";
  const bar = [...article.querySelectorAll('[role="group"]')].pop();
  const link = article.querySelector('a[href*="/status/"] time')?.closest("a");
  if (!bar || !link) return;

  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("aria-label", "Save to gitmarks");
  button.title = "Save to gitmarks";
  button.replaceChildren(saveIcon());
  button.style.cssText = `display:flex;align-items:center;justify-content:center;width:34px;height:34px;margin:-7px 0;
    border:0;border-radius:50%;background:transparent;color:${MUTED};cursor:pointer;transition:color .15s,background .15s`;
  button.onmouseenter = () => (button.style.background = "rgb(234 179 8 / 0.12)");
  button.onmouseleave = () => (button.style.background = "transparent");

  button.onclick = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const url = new URL(link.getAttribute("href"), location.origin).href;
    button.style.opacity = "0.5";
    const result = await chrome.runtime.sendMessage({ type: "save", payload: { urls: [url] } });
    button.style.opacity = "1";
    if (!result?.ok) {
      button.title = result?.error ?? "Save failed";
      button.style.color = "rgb(244, 33, 46)";
      return;
    }
    button.replaceChildren(doneIcon());
    button.style.color = ACCENT;
    // The server returns the vault with the new post first.
    const mark = result.vault.marks[0];
    showPanel(button, mark.id, result.vault.categories, mark.category);
  };

  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;align-items:center";
  wrap.append(button);
  bar.append(wrap);
}

let scheduled = false;
new MutationObserver(() => {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    document.querySelectorAll('article[data-testid="tweet"]:not([data-vault])').forEach(addButton);
  });
}).observe(document.body, { childList: true, subtree: true });

document.addEventListener("scroll", closePanel, { passive: true });
