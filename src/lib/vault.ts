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
  /** Lower case, without the `#`. Absent when there are none. */
  tags?: string[];
  createdAt: string;
  /** The last time it was opened, copied or edited. Absent until the first. */
  openedAt?: string;
  /** Set when archived by hand. Archived by being left unused is worked out, never stored. */
  archivedAt?: string;
  /** Client-only: shown while the server fetches the preview. Never stored. */
  pending?: boolean;
};

/**
 * A note written by hand, like on a sticky note: no link, just text. `html` is
 * the formatted body, limited to the few tags the editor makes (bold, lists…);
 * the server cleans it on the way in and on the way out.
 */
export type Note = {
  id: string;
  title: string;
  html: string;
  pinned?: boolean;
  /** Absent or `""` when it is in no category. Notes are never in the inbox. */
  category?: string;
  /** Lower case, without the `#`. Absent when there are none. */
  tags?: string[];
  color?: NoteColor;
  createdAt: string;
  updatedAt: string;
};

/** The colours a note can be, by name; the page decides the shades. */
export const NOTE_COLORS = [
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
  "blue",
  "purple",
  "pink",
  "gray",
] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];

export type Vault = {
  /**
   * Every category by name, parents before their children. Kept flat so that
   * anything reading only this list (the extension, the Shortcut, the share
   * page) still sees every category, in a sensible order.
   */
  categories: string[];
  marks: Mark[];
  /**
   * Folders inside folders: each nested category's parent. Top-level ones have
   * no entry, which is why a vault from before folders needs no migrating.
   */
  parents?: Record<string, string>;
  /** Device keys carry this. Resetting the key changes it, which revokes every old one. */
  keyVersion?: string;
  /** Written notes, newest first. Absent until the first one. */
  notes?: Note[];
  /** Days unused before a link moves to the archive by itself; 0 is never. Absent is the default. */
  archiveAfterDays?: number;
};

export const ARCHIVE_AFTER_DAYS = 90;
const DAY = 86_400_000;
/**
 * Links saved before the archive existed start its clock on the day it
 * shipped, so nobody opens gitmarks to find half their links gone.
 */
const ARCHIVE_EPOCH = "2026-10-27T00:00:00.000Z";

export const archiveAfter = (vault: Vault) => vault.archiveAfterDays ?? ARCHIVE_AFTER_DAYS;

/** When a link was last saved, opened, copied, edited or restored. */
export function lastUsed(mark: Mark): string {
  return [mark.createdAt, mark.openedAt ?? "", ARCHIVE_EPOCH].reduce((a, b) => (b > a ? b : a));
}

/** Used in the last day: recent enough that opening it again need not be written down. */
export const usedToday = (mark: Mark, now = Date.now()) => now - Date.parse(lastUsed(mark)) < DAY;

/** Whether a link is archived, and how: by hand, or by going unused for `days`. */
export function archived(mark: Mark, days: number, now = Date.now()): "manual" | "unused" | null {
  if (mark.archivedAt) return "manual";
  if (days > 0 && !mark.pending && now - Date.parse(lastUsed(mark)) > days * DAY) return "unused";
  return null;
}

export const EMPTY_VAULT: Vault = { categories: [], marks: [] };

export type MarkPatch = Partial<Pick<Mark, "category" | "note" | "title" | "tags">>;

/** What the reducer understands. `put` inserts or replaces, newest first. */
export type VaultAction =
  | { type: "put"; mark: Mark }
  | { type: "update"; id: string; patch: MarkPatch }
  | { type: "delete"; id: string }
  | { type: "addCategory"; name: string; parent?: string }
  | { type: "renameCategory"; from: string; to: string }
  | { type: "removeCategory"; name: string }
  /** `parent` of `""` moves it to the top level. */
  | { type: "moveCategory"; name: string; parent: string }
  /** Server only: the version is made there, never taken from a request. */
  | { type: "setKeyVersion"; version: string }
  /** `at` is set by the server, never taken from a request. */
  | { type: "archive"; id: string; at: string }
  /** Out of the archive, and counted as used now, so it does not drift straight back. */
  | { type: "restore"; id: string; at: string }
  /** Opened, copied or edited: pushes back when it would be archived for going unused. */
  | { type: "touch"; ids: string[]; at: string }
  | { type: "setArchiveAfter"; days: number }
  /** Inserts at the top, or replaces in place by id. A replaced note keeps its `createdAt`. */
  | { type: "putNote"; note: Note }
  | { type: "deleteNote"; id: string };

/** What a client sends to save a note. The server sets the times and cleans the HTML. */
export type NoteInput = Pick<Note, "id" | "title" | "html" | "pinned" | "category" | "tags" | "color">;

/**
 * What a client sends. Identical to the reducer's actions except that adding is
 * by URL, because only the server can fetch the preview, that a new key is
 * asked for rather than supplied, and that a note arrives without its times.
 */
export type VaultRequest =
  | Exclude<VaultAction, { type: "put" | "setKeyVersion" | "putNote" | "archive" | "restore" | "touch" }>
  | { type: "archive"; id: string }
  | { type: "restore"; id: string }
  | { type: "touch"; ids: string[] }
  | { type: "add"; urls: string[]; category?: string; note?: string }
  | { type: "resetKey" }
  | { type: "saveNote"; note: NoteInput };

/** Longest note body, in characters of HTML. */
export const MAX_NOTE = 100_000;

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

export const MAX_TAGS = 20;

export function cleanTag(tag: string): string {
  return tag.trim().replace(/^#+/, "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 30);
}

export function cleanTags(tags: string[]): string[] {
  return [...new Set(tags.map(cleanTag).filter(Boolean))].slice(0, MAX_TAGS);
}

// --- Folders -------------------------------------------------------------------

/** A category's parent, or `""` at the top level. A parent that no longer exists counts as none. */
export function parentOf(vault: Vault, name: string): string {
  const parent = vault.parents?.[name];
  return parent && parent !== name && vault.categories.includes(parent) ? parent : "";
}

/** A category and every category inside it, however deep. */
export function withDescendants(vault: Vault, name: string): Set<string> {
  const found = new Set([name]);
  for (let grew = true; grew;) {
    grew = false;
    for (const c of vault.categories) {
      if (!found.has(c) && found.has(parentOf(vault, c))) {
        found.add(c);
        grew = true;
      }
    }
  }
  return found;
}

/** Depth-first, children in the order they are listed. */
export function categoryTree(vault: Vault): { name: string; depth: number }[] {
  const out: { name: string; depth: number }[] = [];
  const seen = new Set<string>();
  const visit = (name: string, depth: number) => {
    if (seen.has(name)) return;
    seen.add(name);
    out.push({ name, depth });
    for (const c of vault.categories) if (parentOf(vault, c) === name) visit(c, depth + 1);
  };
  for (const c of vault.categories) if (!parentOf(vault, c)) visit(c, 0);
  // A loop typed into the file by hand has no root; it still shows, at the top.
  for (const c of vault.categories) visit(c, 0);
  return out;
}

/** The parents map without dead or empty entries; no key at all once nothing is nested. */
function withParents(vault: Vault, parents: Record<string, string>): Vault {
  const clean = Object.fromEntries(
    Object.entries(parents).filter(
      ([child, parent]) =>
        parent && child !== parent && vault.categories.includes(child) && vault.categories.includes(parent),
    ),
  );
  const next: Vault = { ...vault, parents: clean };
  if (!Object.keys(clean).length) delete next.parents;
  return { ...next, categories: categoryTree(next).map((n) => n.name) };
}

/** A note in `category`, or in none: notes are never in the inbox, so `""` drops the field. */
function refile(note: Note, category: string): Note {
  const next = { ...note };
  if (category) next.category = category;
  else delete next.category;
  return next;
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
            ...(action.mark.tags?.length || old.tags?.length
              ? { tags: action.mark.tags?.length ? action.mark.tags : old.tags }
              : {}),
          }
        : action.mark;
      return {
        ...vault,
        categories: withCategory(vault.categories, mark.category),
        marks: [mark, ...vault.marks.filter((m) => m.id !== mark.id && m.url !== mark.url)],
      };
    }
    case "update": {
      const category = action.patch.category === undefined ? undefined : cleanCategory(action.patch.category);
      return {
        ...vault,
        categories: category ? withCategory(vault.categories, category) : vault.categories,
        marks: vault.marks.map((m) => {
          if (m.id !== action.id) return m;
          const next = { ...m, ...action.patch, ...(category !== undefined ? { category } : {}) };
          if (next.tags && !next.tags.length) delete next.tags;
          return next;
        }),
      };
    }
    case "delete":
      return { ...vault, marks: vault.marks.filter((m) => m.id !== action.id) };
    case "addCategory": {
      const name = cleanCategory(action.name);
      if (!name || vault.categories.includes(name)) return vault;
      const next = { ...vault, categories: [...vault.categories, name] };
      return action.parent && vault.categories.includes(action.parent)
        ? withParents(next, { ...vault.parents, [name]: action.parent })
        : next;
    }
    case "moveCategory": {
      const { name, parent } = action;
      if (!vault.categories.includes(name) || parentOf(vault, name) === parent) return vault;
      // Into itself, or into its own child, would cut it off from the tree.
      if (parent && (!vault.categories.includes(parent) || withDescendants(vault, name).has(parent))) {
        return vault;
      }
      return withParents(vault, { ...vault.parents, [name]: parent });
    }
    case "renameCategory": {
      const { from } = action;
      const to = cleanCategory(action.to);
      if (!to || to === from) return vault;
      // Renaming onto an existing name merges the two.
      const merge = vault.categories.includes(to);
      const categories = merge
        ? vault.categories.filter((c) => c !== from)
        : vault.categories.map((c) => (c === from ? to : c));
      const parents: Record<string, string> = {};
      for (const [child, parent] of Object.entries(vault.parents ?? {})) {
        if (merge && child === from) continue;
        parents[child === from ? to : child] = parent === from ? to : parent;
      }
      // Merged into a folder that was inside it, that folder takes its place.
      if (merge && withDescendants(vault, from).has(to)) parents[to] = parentOf(vault, from);
      return withParents(
        {
          ...vault,
          categories,
          marks: vault.marks.map((m) => (m.category === from ? { ...m, category: to } : m)),
          ...(vault.notes
            ? { notes: vault.notes.map((n) => (n.category === from ? { ...n, category: to } : n)) }
            : {}),
        },
        parents,
      );
    }
    case "removeCategory": {
      // Nothing is lost: what was inside moves up a level, to the inbox at the top.
      const up = parentOf(vault, action.name);
      const parents = Object.fromEntries(
        Object.entries(vault.parents ?? {}).map(([child, parent]) => [
          child,
          parent === action.name ? up : parent,
        ]),
      );
      return withParents(
        {
          ...vault,
          categories: vault.categories.filter((c) => c !== action.name),
          marks: vault.marks.map((m) => (m.category === action.name ? { ...m, category: up } : m)),
          ...(vault.notes
            ? { notes: vault.notes.map((n) => (n.category === action.name ? refile(n, up) : n)) }
            : {}),
        },
        parents,
      );
    }
    case "setKeyVersion":
      return { ...vault, keyVersion: action.version };
    case "putNote": {
      const notes = vault.notes ?? [];
      const old = notes.find((n) => n.id === action.note.id);
      const note: Note = { ...action.note, ...(old ? { createdAt: old.createdAt } : {}) };
      const category = cleanCategory(note.category ?? "");
      if (category) note.category = category;
      else delete note.category;
      if (!note.tags?.length) delete note.tags;
      if (!note.color) delete note.color;
      return {
        ...vault,
        // A note filed under a new name makes that category, as a link does.
        categories: category ? withCategory(vault.categories, category) : vault.categories,
        // Editing keeps a note where it is: ticking an item should not reshuffle the grid.
        notes: old ? notes.map((n) => (n.id === note.id ? note : n)) : [note, ...notes],
      };
    }
    case "deleteNote":
      return vault.notes ? { ...vault, notes: vault.notes.filter((n) => n.id !== action.id) } : vault;
    case "archive":
      return {
        ...vault,
        marks: vault.marks.map((m) => (m.id === action.id ? { ...m, archivedAt: action.at } : m)),
      };
    case "restore":
      return {
        ...vault,
        marks: vault.marks.map((m) => {
          if (m.id !== action.id) return m;
          const next = { ...m, openedAt: action.at };
          delete next.archivedAt;
          return next;
        }),
      };
    case "touch": {
      const ids = new Set(action.ids);
      return {
        ...vault,
        marks: vault.marks.map((m) =>
          ids.has(m.id) && (m.openedAt ?? "") < action.at ? { ...m, openedAt: action.at } : m,
        ),
      };
    }
    case "setArchiveAfter":
      return { ...vault, archiveAfterDays: action.days };
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };

/**
 * A note's words without the formatting, for search and for telling an empty
 * note. Plain text out, never HTML: it is only ever matched or shown as text.
 */
export function noteText(html: string): string {
  return html
    .split(/<\/(?:p|div|li|h2|h3|blockquote)>|<br\s*\/?>/i)
    .map((line) => line.split(/<[^>]*>/).join(""))
    .join("\n")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e: string) => ENTITIES[e])
    .trim();
}

export function noteMatches(note: Note, query: string): boolean {
  const q = query.trim().toLowerCase();
  const tags = (note.tags ?? []).map((t) => `#${t}`).join(" ");
  return !q || `${note.title}\n${noteText(note.html)}\n${tags}`.toLowerCase().includes(q);
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
  return [
    mark.title,
    mark.description,
    mark.url,
    mark.note,
    mark.author?.name,
    mark.author?.handle,
    ...(mark.tags ?? []).map((t) => `#${t}`),
  ]
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
      const patch: MarkPatch = {};
      if (p.category !== undefined) patch.category = cleanCategory(str(p.category, 100) ?? "");
      if (p.note !== undefined) patch.note = str(p.note, 2000)?.trim() ?? "";
      if (Array.isArray(p.tags)) {
        patch.tags = cleanTags(p.tags.slice(0, 100).filter((t): t is string => typeof t === "string"));
      }
      const title = str(p.title, 300)?.trim();
      if (title) patch.title = title;
      return Object.keys(patch).length ? { type: "update", id, patch } : null;
    }
    case "delete":
      return id ? { type: "delete", id } : null;
    case "addCategory": {
      const parent = cleanCategory(str(b.parent, 100) ?? "");
      return name ? { type: "addCategory", name, ...(parent ? { parent } : {}) } : null;
    }
    case "removeCategory":
      return name ? { type: "removeCategory", name } : null;
    case "moveCategory":
      return name && typeof b.parent === "string"
        ? { type: "moveCategory", name, parent: cleanCategory(str(b.parent, 100) ?? "") }
        : null;
    case "resetKey":
      return { type: "resetKey" };
    case "saveNote": {
      const n = b.note as Record<string, unknown> | null;
      if (!n || typeof n !== "object") return null;
      const noteId = str(n.id, 100);
      if (!noteId || !/^[\w-]+$/.test(noteId) || typeof n.html !== "string" || n.html.length > MAX_NOTE) {
        return null;
      }
      const category = cleanCategory(str(n.category, 100) ?? "");
      const tags = Array.isArray(n.tags)
        ? cleanTags(n.tags.slice(0, 100).filter((t): t is string => typeof t === "string"))
        : [];
      const color = NOTE_COLORS.find((c) => c === n.color);
      return {
        type: "saveNote",
        note: {
          id: noteId,
          title: str(n.title, 300)?.trim() ?? "",
          html: n.html,
          ...(n.pinned === true ? { pinned: true } : {}),
          ...(category && category.toLowerCase() !== "inbox" ? { category } : {}),
          ...(tags.length ? { tags } : {}),
          ...(color ? { color } : {}),
        },
      };
    }
    case "deleteNote":
      return id ? { type: "deleteNote", id } : null;
    case "archive":
    case "restore":
      return id ? { type: b.type === "archive" ? "archive" : "restore", id } : null;
    case "touch": {
      const ids = Array.isArray(b.ids) ? b.ids.filter((x): x is string => typeof x === "string") : [];
      return ids.length && ids.length <= 200 ? { type: "touch", ids: ids.map((x) => x.slice(0, 100)) } : null;
    }
    case "setArchiveAfter":
      return Number.isInteger(b.days) && (b.days as number) >= 0 && (b.days as number) <= 3650
        ? { type: "setArchiveAfter", days: b.days as number }
        : null;
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
