import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import * as cheerio from "cheerio";

import { safeFetch } from "./net";
import { isRepoPublic, readFile, writeFile, type Repo, type WriteResult } from "./github";
import { isHosted } from "./hosted";
import { env } from "./env";
import {
  EMPTY_VAULT,
  applyAction,
  siteOf,
  xStatus,
  type Mark,
  type Note,
  type Vault,
  type VaultAction,
  type VaultRequest,
} from "./vault";

/**
 * In a GitHub repo, the vault is `data/vault.json` — the same path hosted and
 * self-hosted, so moving between the two is copying one file. Without a repo,
 * it is a gitignored file next to the app, which is what local development uses.
 */
const FILE = "data/vault.json";
const LOCAL_FILE = path.join(process.cwd(), ".gitmarks-local.json");

function parse(text: string): Vault {
  const data = JSON.parse(text) as Vault;
  // Refuse to carry on from a file we do not understand: the next save would
  // overwrite it with an empty vault.
  if (
    !Array.isArray(data?.categories) ||
    !Array.isArray(data?.marks) ||
    (data.notes !== undefined && !Array.isArray(data.notes))
  ) {
    throw new Error(`${FILE} is not a gitmarks vault.`);
  }
  // Notes are shown as HTML, so they are cleaned on the way out too: the file
  // can be edited by hand on GitHub, by anything with access to the repo.
  if (data.notes) {
    data.notes = data.notes.map((n) => ({ ...n, html: cleanHtml(typeof n.html === "string" ? n.html : "") }));
  }
  return data;
}

// --- Notes --------------------------------------------------------------------

/** What the note editor makes. Everything else is unwrapped to its text. */
const NOTE_TAGS = new Set([
  "p",
  "div",
  "br",
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "strike",
  "ul",
  "ol",
  "li",
  "h2",
  "h3",
  "blockquote",
  "a",
]);

const escapeText = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (text: string) => escapeText(text).replace(/"/g, "&quot;");

/** A link's address if it is one a note may hold: the web or email, nothing that runs. */
function safeHref(href: string | undefined): string | null {
  try {
    const url = new URL(href ?? "");
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * The few attributes kept, each rebuilt rather than copied: a link's address,
 * a list being a checklist, and whether an item on it is ticked.
 */
function attributesOf(name: string, attribs: Record<string, string>): string | null {
  if (name === "a") {
    const href = safeHref(attribs.href);
    return href ? ` href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer"` : null;
  }
  if (name === "ul" && attribs["data-type"] === "checklist") return ' data-type="checklist"';
  if (name === "li" && attribs["data-checked"]) {
    return ` data-checked="${attribs["data-checked"] === "true" ? "true" : "false"}"`;
  }
  return "";
}

/**
 * Rebuilds note HTML from an allowlist, so nothing survives that could run:
 * no tags beyond the editor's, no attributes beyond the three it sets, and
 * scripts, styles and comments dropped with their contents. Exported for tests.
 */
export function cleanHtml(html: string): string {
  const root = cheerio.load(html, null, false).root()[0];
  const walk = (nodes: typeof root.children, depth: number): string =>
    nodes
      .map((node) => {
        if (node.type === "text") return escapeText(node.data);
        if (node.type !== "tag") return "";
        // Past any sensible nesting, keep the words and drop the structure.
        if (depth > 40) return escapeText(textOf(node));
        if (node.name === "br") return "<br>";
        const inner = walk(node.children, depth + 1);
        if (!NOTE_TAGS.has(node.name)) return inner;
        // Editing leaves empty paragraphs behind; a blank line is `<p><br></p>`.
        if (!inner && (node.name === "p" || node.name === "div" || node.name === "a")) return "";
        const attributes = attributesOf(node.name, node.attribs);
        // A link to somewhere a note may not point keeps its words, not the link.
        if (attributes === null) return inner;
        return `<${node.name}${attributes}>${inner}</${node.name}>`;
      })
      .join("");
  // Without recursion, which a hostile file could nest deep enough to overflow.
  function textOf(start: (typeof root.children)[number]): string {
    let text = "";
    const stack = [start];
    while (stack.length) {
      const node = stack.pop()!;
      if (node.type === "text") text += node.data;
      else if (node.type === "tag") stack.push(...[...node.children].reverse());
    }
    return text;
  }
  return walk(root.children, 0);
}

/**
 * Bookmarks in a public repo are bookmarks anyone can read, so a public repo
 * stops saving until it is made private. Self-hosted, the owner can opt in on
 * purpose with GITMARKS_ALLOW_PUBLIC=true; hosted, nobody can.
 */
export async function publicRepoProblem(store: Repo | null): Promise<string | null> {
  if (!store || (!isHosted() && env("GITMARKS_ALLOW_PUBLIC") === "true")) return null;
  return (await isRepoPublic(store)) ? store.repo : null;
}

export async function loadVault(store: Repo | null): Promise<{ vault: Vault; sha: string | null }> {
  if (store) {
    const file = await readFile(store, FILE);
    return { vault: file ? parse(file.text) : EMPTY_VAULT, sha: file?.sha ?? null };
  }
  try {
    return { vault: parse(await fs.readFile(LOCAL_FILE, "utf8")), sha: null };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { vault: EMPTY_VAULT, sha: null };
    throw error;
  }
}

async function saveVault(
  store: Repo | null,
  vault: Vault,
  sha: string | null,
  message: string,
): Promise<WriteResult> {
  const text = JSON.stringify(vault, null, 2) + "\n";
  if (store) return writeFile(store, FILE, text, sha, message);
  if (process.env.VERCEL) {
    return { ok: false, error: "Set GITHUB_TOKEN: this host has no disk to keep bookmarks on." };
  }
  await fs.writeFile(LOCAL_FILE, text);
  return { ok: true };
}

export type VaultResult = { ok: true; vault: Vault } | { ok: false; error: string };

/**
 * Read, apply, write — and if the file moved underneath us (the extension and
 * the page saving at once), read again and re-apply rather than overwrite.
 */
async function mutate(store: Repo | null, actions: VaultAction[], message: string): Promise<VaultResult> {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 250 * attempt));
    const { vault, sha } = await loadVault(store);
    const next = actions.reduce(applyAction, vault);
    const result = await saveVault(store, next, sha, message);
    if (result.ok) return { ok: true, vault: next };
    if (!result.conflict) return result;
  }
  return { ok: false, error: "The vault kept changing during this save. Try again." };
}

export async function performRequest(store: Repo | null, request: VaultRequest): Promise<VaultResult> {
  try {
    const publicRepo = await publicRepoProblem(store);
    if (publicRepo) {
      return { ok: false, error: `${publicRepo} is public, so saving is paused. Make it private on GitHub.` };
    }
    if (request.type === "saveNote") {
      const now = new Date().toISOString();
      const note: Note = {
        ...request.note,
        html: cleanHtml(request.note.html),
        createdAt: now,
        updatedAt: now,
      };
      return await mutate(store, [{ type: "putNote", note }], "gitmarks: save a note");
    }
    if (request.type === "resetKey") {
      const version = randomBytes(9).toString("base64url");
      return await mutate(store, [{ type: "setKeyVersion", version }], "gitmarks: reset the device key");
    }
    if (request.type !== "add") return await mutate(store, [request], `gitmarks: ${request.type}`);
    const marks = await Promise.all(
      request.urls.map((url) => buildMark(url, request.category ?? "", request.note)),
    );
    // Reversed so the first URL of a batch ends up on top.
    const puts = marks.reverse().map((mark): VaultAction => ({ type: "put", mark }));
    return await mutate(
      store,
      puts,
      `gitmarks: add ${marks.length === 1 ? marks[0].url : `${marks.length} links`}`,
    );
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Save failed." };
  }
}

// --- Previews ---------------------------------------------------------------

type Preview = Partial<Pick<Mark, "title" | "description" | "image" | "author">>;

const USER_AGENT = "Mozilla/5.0 (compatible; gitmarks/1.0; +https://github.com/GeekyADAMS/gitmarks)";

/** Every preview request goes through `safeFetch`: public addresses only, redirects checked hop by hop. */
function get(url: string): Promise<Response> {
  return safeFetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "text/html,application/json;q=0.9,*/*;q=0.8" },
    signal: AbortSignal.timeout(6000),
  });
}

/**
 * The body up to `</head>`, which is all a preview needs. Capped at 2MB rather
 * than less because YouTube ships ~750KB of script before its first og: tag.
 */
async function head(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let html = "";
  while (html.length < 2_000_000 && !html.includes("</head>")) {
    const { done, value } = await reader.read();
    if (done) break;
    html += decoder.decode(value, { stream: true });
  }
  void reader.cancel().catch(() => {});
  return html;
}

const decodeEntities = (text: string) => cheerio.load(`<p>${text}</p>`)("p").text();

/** Open Graph first, then Twitter cards, then plain HTML. Exported for tests. */
export function parseMeta(html: string, pageUrl: string): Preview {
  const $ = cheerio.load(html);
  const meta = (...keys: string[]) => {
    for (const key of keys) {
      const value = $(`meta[property="${key}"], meta[name="${key}"]`).attr("content")?.trim();
      if (value) return value;
    }
    return undefined;
  };
  const title = meta("og:title", "twitter:title") ?? ($("title").first().text().trim() || undefined);
  const description = meta("og:description", "twitter:description", "description");
  let image = meta("og:image:secure_url", "og:image", "twitter:image", "twitter:image:src");
  if (image) {
    try {
      image = new URL(image, pageUrl).toString();
    } catch {
      image = undefined;
    }
  }
  return {
    ...(title ? { title: decodeEntities(title).slice(0, 300) } : {}),
    ...(description ? { description: decodeEntities(description).slice(0, 1000) } : {}),
    ...(image?.startsWith("http") ? { image } : {}),
  };
}

async function pagePreview(url: string): Promise<Preview> {
  try {
    const res = await get(url);
    if (!res.ok) return {};
    const type = res.headers.get("content-type") ?? "";
    if (type.startsWith("image/")) {
      void res.body?.cancel();
      return { image: url };
    }
    if (!type.includes("html")) {
      void res.body?.cancel();
      return {};
    }
    return parseMeta(await head(res), res.url || url);
  } catch {
    return {};
  }
}

type FxTweet = {
  text?: string;
  author?: { name?: string; screen_name?: string; avatar_url?: string };
  media?: {
    photos?: { url: string }[];
    videos?: { thumbnail_url?: string }[];
  };
};

/**
 * Posts on X. X serves no Open Graph to anything that is not a browser, so the
 * page route would return nothing: FxTwitter's public API gives the text, the
 * author and the media; X's own oEmbed is the fallback, text only.
 */
async function xPreview(url: string, handle: string, id: string): Promise<Preview> {
  try {
    const res = await get(`https://api.fxtwitter.com/${handle}/status/${id}`);
    const { tweet } = (await res.json()) as { tweet?: FxTweet };
    if (tweet?.author?.name) {
      const image = tweet.media?.photos?.[0]?.url ?? tweet.media?.videos?.[0]?.thumbnail_url;
      return {
        title: `${tweet.author.name} on X`,
        description: tweet.text ?? "",
        ...(image ? { image } : {}),
        author: {
          name: tweet.author.name,
          handle: tweet.author.screen_name ?? handle,
          ...(tweet.author.avatar_url ? { avatar: tweet.author.avatar_url } : {}),
        },
      };
    }
  } catch {
    // Fall through to oEmbed.
  }
  try {
    const res = await get(`https://publish.twitter.com/oembed?omit_script=1&url=${encodeURIComponent(url)}`);
    const data = (await res.json()) as { author_name?: string; html?: string };
    if (data.author_name) {
      return {
        title: `${data.author_name} on X`,
        description: cheerio
          .load(data.html ?? "")("blockquote p")
          .first()
          .text(),
        author: { name: data.author_name, handle },
      };
    }
  } catch {
    // No preview: the mark still saves, titled by its URL.
  }
  return {};
}

async function buildMark(url: string, category: string, note?: string): Promise<Mark> {
  const x = xStatus(url);
  const preview = x ? await xPreview(url, x.handle, x.id) : await pagePreview(url);
  return {
    id: randomUUID(),
    url,
    title: preview.title || url.replace(/^https?:\/\/(www\.)?/, ""),
    description: preview.description ?? "",
    ...(preview.image ? { image: preview.image } : {}),
    site: siteOf(url),
    kind: x ? "x" : "link",
    ...(preview.author ? { author: preview.author } : {}),
    category,
    ...(note ? { note } : {}),
    createdAt: new Date().toISOString(),
  };
}
