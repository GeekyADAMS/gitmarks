/**
 * The vault: private, categorised bookmarks. This file is the shared core —
 * types, URL handling and the one reducer every change goes through. The server
 * runs it against the stored file; the client runs the same function to show a
 * change before the server has confirmed it, so the two cannot disagree about
 * what an action means.
 *
 * Nothing here touches the network or Node, so it is safe in the browser.
 */

export type Mark = {
  id: string;
  url: string;
  title: string;
  description: string;
  image?: string;
  /** Display host, e.g. `github.com`. */
  site: string;
  kind: "x" | "link";
  /** Set on posts: who wrote it. */
  author?: { name: string; handle?: string; avatar?: string };
  /** `""` is the inbox. */
  category: string;
  note?: string;
  createdAt: string;
  /** Client-only: shown while the server fetches the preview. Never stored. */
  pending?: boolean;
};

export type Vault = { categories: string[]; marks: Mark[] };

export const EMPTY_VAULT: Vault = { categories: [], marks: [] };

/** What the reducer understands. `put` inserts or replaces, newest first. */
export type VaultAction =
  | { type: "put"; mark: Mark }
  | { type: "update"; id: string; patch: Partial<Pick<Mark, "category" | "note" | "title">> }
  | { type: "delete"; id: string }
  | { type: "addCategory"; name: string }
  | { type: "renameCategory"; from: string; to: string }
  | { type: "removeCategory"; name: string };

/**
 * What a client sends. Identical to the reducer's actions except that adding is
 * by URL: the server builds the mark, because only the server can fetch the
 * preview.
 */
export type VaultRequest =
  Exclude<VaultAction, { type: "put" }> | { type: "add"; urls: string[]; category?: string; note?: string };

/** Most URLs one request may add. Each one is a preview fetch. */
export const MAX_BATCH = 20;

const TRACKING = /^(utm_\w+|fbclid|gclid|mc_eid|ref_src|ref_url|igshid|si)$/i;

/**
 * One spelling per link, so saving the same thing twice replaces rather than
 * duplicates. Drops tracking parameters and fragments, folds twitter.com into
 * x.com, and strips X's share parameters (`?s=20&t=…`) which differ on every
 * copy of the same post.
 */
export function normalizeUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if (/^(www\.|mobile\.)?(twitter|x)\.com$/.test(url.hostname)) {
    url.hostname = "x.com";
    url.search = "";
  }
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING.test(key)) url.searchParams.delete(key);
  }
  let out = url.toString();
  if (url.pathname !== "/" && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

/** Every http(s) URL in a blob of text — a paste, a dropped selection, a list. */
export function extractUrls(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s<>"'`]+/g) ?? [];
  const seen = new Set<string>();
  for (const raw of found) {
    // Prose punctuation that trails a URL is almost never part of it.
    const url = normalizeUrl(raw.replace(/[.,;:!?)\]}]+$/, ""));
    if (url) seen.add(url);
  }
  return [...seen];
}

/** `{ handle, id }` for a post on X, otherwise null. */
export function xStatus(url: string): { handle: string; id: string } | null {
  const m = /^https:\/\/x\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/.exec(url);
  return m ? { handle: m[1], id: m[2] } : null;
}

export function siteOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function cleanCategory(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, 40);
}

function withCategory(categories: string[], name: string): string[] {
  return !name || categories.includes(name) ? categories : [...categories, name];
}

export function applyAction(vault: Vault, action: VaultAction): Vault {
  switch (action.type) {
    case "put": {
      // Saving a link again moves it to the top with a fresh preview, but keeps
      // its identity and whatever sorting it already had unless told otherwise.
      const old = vault.marks.find((m) => m.url === action.mark.url);
      const mark = old
        ? {
            ...action.mark,
            id: old.id,
            category: action.mark.category || old.category,
            ...(action.mark.note || old.note ? { note: action.mark.note || old.note } : {}),
          }
        : action.mark;
      return {
        categories: withCategory(vault.categories, mark.category),
        marks: [mark, ...vault.marks.filter((m) => m.id !== mark.id && m.url !== mark.url)],
      };
    }
    case "update": {
      const category = action.patch.category === undefined ? undefined : cleanCategory(action.patch.category);
      return {
        categories: category ? withCategory(vault.categories, category) : vault.categories,
        marks: vault.marks.map((m) =>
          m.id !== action.id
            ? m
            : {
                ...m,
                ...action.patch,
                ...(category !== undefined ? { category } : {}),
              },
        ),
      };
    }
    case "delete":
      return { ...vault, marks: vault.marks.filter((m) => m.id !== action.id) };
    case "addCategory":
      return { ...vault, categories: withCategory(vault.categories, cleanCategory(action.name)) };
    case "renameCategory": {
      const to = cleanCategory(action.to);
      if (!to || to === action.from) return vault;
      // Renaming onto an existing name merges the two.
      const categories = vault.categories.includes(to)
        ? vault.categories.filter((c) => c !== action.from)
        : vault.categories.map((c) => (c === action.from ? to : c));
      return {
        categories,
        marks: vault.marks.map((m) => (m.category === action.from ? { ...m, category: to } : m)),
      };
    }
    case "removeCategory":
      // Nothing is lost: the category's marks fall back to the inbox.
      return {
        categories: vault.categories.filter((c) => c !== action.name),
        marks: vault.marks.map((m) => (m.category === action.name ? { ...m, category: "" } : m)),
      };
  }
}

/** A mark existing only on the client while its preview is being fetched. */
export function placeholderMark(url: string, category = "", note?: string): Mark {
  const site = siteOf(url);
  return {
    id: `pending:${url}`,
    url,
    title: url.replace(/^https?:\/\/(www\.)?/, ""),
    description: "",
    site,
    kind: xStatus(url) ? "x" : "link",
    category,
    ...(note ? { note } : {}),
    createdAt: new Date().toISOString(),
    pending: true,
  };
}

/** Case-insensitive match across everything a person might remember about a link. */
export function matches(mark: Mark, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [mark.title, mark.description, mark.url, mark.note, mark.author?.name, mark.author?.handle]
    .filter(Boolean)
    .some((field) => field!.toLowerCase().includes(q));
}

const str = (value: unknown, max: number): string | undefined =>
  typeof value === "string" ? value.slice(0, max) : undefined;

/**
 * The trust boundary: turns an untrusted request body into a request, or null.
 * Only the owner can reach the API, but a bug in the extension should still be
 * a 400 rather than a corrupted file.
 */
export function parseRequest(body: unknown): VaultRequest | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const id = str(b.id, 100);
  const name = cleanCategory(str(b.name, 100) ?? "");
  switch (b.type) {
    case "add": {
      // `urls` may be one string or a list, and each entry may be a bare link
      // or text around one: share sheets often hand over "Look at this https://…".
      const raw = typeof b.urls === "string" ? [b.urls] : Array.isArray(b.urls) ? b.urls : [];
      const found = raw.map((u) => (typeof u === "string" ? extractUrls(u) : []));
      if (found.length === 0 || found.some((list) => list.length === 0)) return null;
      const urls = [...new Set(found.flat())];
      if (urls.length > MAX_BATCH) return null;
      const note = str(b.note, 2000)?.trim();
      const category = cleanCategory(str(b.category, 100) ?? "");
      return {
        type: "add",
        urls,
        // The page calls the empty category "Inbox", so a picker offering that
        // name means the inbox rather than a new category spelled the same.
        category: category.toLowerCase() === "inbox" ? "" : category,
        ...(note ? { note } : {}),
      };
    }
    case "update": {
      if (!id || !b.patch || typeof b.patch !== "object") return null;
      const p = b.patch as Record<string, unknown>;
      const patch: Partial<Pick<Mark, "category" | "note" | "title">> = {};
      if (p.category !== undefined) patch.category = cleanCategory(str(p.category, 100) ?? "");
      if (p.note !== undefined) patch.note = str(p.note, 2000)?.trim() ?? "";
      const title = str(p.title, 300)?.trim();
      if (title) patch.title = title;
      return Object.keys(patch).length ? { type: "update", id, patch } : null;
    }
    case "delete":
      return id ? { type: "delete", id } : null;
    case "addCategory":
    case "removeCategory":
      return name ? { type: b.type, name } : null;
    case "renameCategory": {
      const from = str(b.from, 100);
      const to = cleanCategory(str(b.to, 100) ?? "");
      return from && to ? { type: "renameCategory", from, to } : null;
    }
    default:
      return null;
  }
}

/**
 * `text` cut into alternating plain and matching pieces, odd indexes being the
 * matches. Case-insensitive and literal: the query is never read as a regex.
 */
export function splitMatches(text: string, query: string): string[] {
  const q = query.trim();
  if (!q) return [text];
  return text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"));
}
