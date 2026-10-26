import { useEffect, useEffectEvent, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  ArrowClockwise,
  ArrowUpRight,
  CaretRight,
  Check,
  Copy,
  FolderPlus,
  Hash,
  LinkSimple,
  MagnifyingGlass,
  NotePencil,
  DeviceMobile,
  PencilSimple,
  Plus,
  SignOut,
  SquaresFour,
  Trash,
  Tray,
  X,
  XLogo,
} from "@phosphor-icons/react";
import {
  MAX_BATCH,
  MAX_TAGS,
  applyAction,
  categoryTree,
  cleanTag,
  extractUrls,
  matches,
  parentOf,
  placeholderMark,
  splitMatches,
  withDescendants,
  type Mark,
  type MarkPatch,
  type Vault as VaultData,
  type VaultAction,
  type VaultRequest,
} from "@/lib/vault";

/** `all` and `inbox` are views; any other string is a category. */
type View = { kind: "all" } | { kind: "inbox" } | { kind: "category"; name: string };
type Toast = { id: number; message: string; undo?: () => void; error?: boolean };

const DRAG_TYPE = "application/x-vault-mark";
/** Indents a folder under its parent in the sidebar; on a phone the row is flat. */
const INDENT = "md:pl-[calc(var(--depth)*14px)]";
const depthVar = (depth: number) => ({ "--depth": depth }) as React.CSSProperties;
/** A category being dragged onto another, to nest it there. */
const DRAG_CATEGORY = "application/x-vault-category";
type Tree = { name: string; depth: number }[];
/** Actions that change categories, which the sidebar sends as they are. */
type CategoryAction = Extract<
  VaultAction,
  { type: "addCategory" | "renameCategory" | "removeCategory" | "moveCategory" }
>;
let toastId = 0;

/**
 * How often an open tab picks up saves from other devices. A minute keeps the
 * phone-to-desktop wait short for one GitHub read, about 60 an hour per visible
 * tab against a 5,000-an-hour limit. Hidden tabs do not poll; they refresh on
 * coming back instead.
 */
const REFRESH_MS = 60_000;

/** Folders closed in the sidebar, kept per browser. */
const COLLAPSED = "gitmarks:collapsed";
const collapsedListeners = new Set<() => void>();
function readCollapsed(): string {
  try {
    return localStorage.getItem(COLLAPSED) ?? "[]";
  } catch {
    return "[]";
  }
}
function subscribeCollapsed(listener: () => void) {
  collapsedListeners.add(listener);
  return () => void collapsedListeners.delete(listener);
}
function writeCollapsed(names: Set<string>) {
  try {
    localStorage.setItem(COLLAPSED, JSON.stringify([...names]));
  } catch {
    // Private mode without storage: folders still close, just not across reloads.
  }
  collapsedListeners.forEach((listener) => listener());
}
function useCollapsed(): Set<string> {
  const json = useSyncExternalStore(subscribeCollapsed, readCollapsed, () => "[]");
  return useMemo(() => {
    try {
      const names: unknown = JSON.parse(json);
      return new Set(Array.isArray(names) ? names.filter((n) => typeof n === "string") : []);
    } catch {
      return new Set<string>();
    }
  }, [json]);
}

// --- Small pure helpers -------------------------------------------------------

const HUES = [25, 55, 85, 145, 175, 200, 235, 265, 295, 330];

/** A stable colour per category name, so a category keeps its dot everywhere. */
function hue(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length];
}

function Dot({ name, className = "" }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${className}`}
      style={{ background: `oklch(0.7 0.15 ${hue(name)})` }}
    />
  );
}

function ago(iso: string): string {
  const then = new Date(iso);
  const s = (Date.now() - then.getTime()) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return then.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(then.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}),
  });
}

const favicon = (site: string) => `https://www.google.com/s2/favicons?domain=${site}&sz=64`;

/** Column count by width. Read through a store so SSR and hydration agree. */
function columnsFor(width: number) {
  return width < 640 ? 1 : width < 1120 ? 2 : width < 1600 ? 3 : 4;
}
const subscribeResize = (cb: () => void) => {
  window.addEventListener("resize", cb);
  return () => window.removeEventListener("resize", cb);
};

/**
 * Masonry by hand: each card goes to the currently shortest column, judged by a
 * rough height estimate. Unlike CSS columns this keeps newest-first reading
 * left to right along the top row.
 */
function intoColumns(marks: Mark[], count: number): Mark[][] {
  const columns: Mark[][] = Array.from({ length: count }, () => []);
  const heights = new Array(count).fill(0);
  for (const mark of marks) {
    const i = heights.indexOf(Math.min(...heights));
    columns[i].push(mark);
    heights[i] += 120 + (mark.image ? 190 : 0) + Math.min(mark.description.length, 420) / 2.2;
  }
  return columns;
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

// --- The page ----------------------------------------------------------------

export default function Vault({
  initial,
  loadError,
  deviceKey,
  hosted,
}: {
  initial: VaultData;
  loadError?: string;
  /** What the extension and the Shortcut send. Shown in Connect, to copy. */
  deviceKey: string;
  hosted: boolean;
}) {
  // What the server last confirmed, plus changes still in flight on top of it.
  // Showing `pending` through the same reducer the server runs is what makes
  // every action feel instant without the two ever disagreeing for long.
  const [base, setBase] = useState(initial);
  const [pending, setPending] = useState<{ key: number; action: VaultAction }[]>([]);
  const vault = useMemo(() => pending.reduce((v, p) => applyAction(v, p.action), base), [base, pending]);

  const [view, setView] = useState<View>({ kind: "all" });
  const [tag, setTag] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [key, setKey] = useState(deviceKey);
  // On a touch screen: the card held down, and the drop target under the finger.
  const [carrying, setCarrying] = useState<Mark | null>(null);
  const [hovering, setHovering] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(
    loadError ? { id: 0, message: loadError, error: true } : null,
  );
  const [dropping, setDropping] = useState(false);

  const queue = useRef(Promise.resolve());
  const nextKey = useRef(0);
  /** The last request the server has answered; equal to `nextKey` when nothing is in flight. */
  const doneKey = useRef(0);
  const [refreshing, setRefreshing] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  function notify(message: string, extra: Omit<Toast, "id" | "message"> = {}) {
    setToast({ id: ++toastId, message, ...extra });
  }

  /**
   * Requests go out one at a time, in order. Each server response replaces the
   * base, and the matching optimistic actions are dropped in the same render,
   * so the screen never flickers back to an older state.
   */
  function send(request: VaultRequest, optimistic: VaultAction[]) {
    const key = ++nextKey.current;
    setPending((p) => [...p, ...optimistic.map((action) => ({ key, action }))]);
    queue.current = queue.current.then(async () => {
      let result: { ok: boolean; vault?: VaultData; error?: string };
      try {
        const res = await fetch("/api/vault", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        });
        result =
          res.status === 404
            ? { ok: false, error: "Signed out. Reload to sign in again." }
            : await res.json();
      } catch {
        result = { ok: false, error: "Could not reach the server. Nothing was saved." };
      }
      if (result.ok && result.vault) setBase(result.vault);
      else notify(result.error ?? "Save failed.", { error: true });
      setPending((p) => p.filter((x) => x.key !== key));
      doneKey.current = key;
    });
  }

  /**
   * Loads the vault again, for saves made on other devices. A save of this
   * page's own wins: no refresh starts while one is in flight, and one that
   * starts during the refresh makes it discard what it read.
   */
  async function refresh(quiet = false) {
    const started = nextKey.current;
    if (doneKey.current !== started) return;
    if (!quiet) setRefreshing(true);
    try {
      const res = await fetch("/api/vault", { cache: "no-store" });
      if (res.status === 404) throw new Error("Signed out. Reload to sign in again.");
      const result = (await res.json()) as { ok?: boolean; vault?: VaultData; error?: string };
      if (!result.ok || !result.vault) throw new Error(result.error);
      if (nextKey.current === started) setBase(result.vault);
    } catch (error) {
      if (!quiet) {
        notify(error instanceof Error && error.message ? error.message : "Could not refresh.", {
          error: true,
        });
      }
    } finally {
      setRefreshing(false);
    }
  }

  // Every minute while the tab is in view, and straight away on coming back to it.
  const backgroundRefresh = useEffectEvent(() => {
    if (document.visibilityState === "visible") void refresh(true);
  });
  useEffect(() => {
    const timer = setInterval(backgroundRefresh, REFRESH_MS);
    document.addEventListener("visibilitychange", backgroundRefresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", backgroundRefresh);
    };
  }, []);

  const targetCategory = view.kind === "category" ? view.name : "";

  function add(urls: string[], category = targetCategory, note?: string) {
    if (urls.length === 0) return false;
    for (let i = 0; i < urls.length; i += MAX_BATCH) {
      const chunk = urls.slice(i, i + MAX_BATCH);
      send(
        { type: "add", urls: chunk, category, ...(note ? { note } : {}) },
        [...chunk].reverse().map((url) => ({ type: "put", mark: placeholderMark(url, category, note) })),
      );
    }
    notify(`Saved ${urls.length === 1 ? "link" : `${urls.length} links`} to ${category || "Inbox"}`);
    return true;
  }

  function move(mark: Mark, category: string) {
    if (mark.category === category) return;
    const from = mark.category;
    send({ type: "update", id: mark.id, patch: { category } }, [
      { type: "update", id: mark.id, patch: { category } },
    ]);
    notify(`Moved to ${category || "Inbox"}`, { undo: () => move({ ...mark, category }, from) });
  }

  function remove(mark: Mark) {
    send({ type: "delete", id: mark.id }, [{ type: "delete", id: mark.id }]);
    notify("Deleted", {
      // Restoring re-adds by URL, shown immediately with the mark as it was.
      undo: () =>
        send(
          {
            type: "add",
            urls: [mark.url],
            category: mark.category,
            ...(mark.note ? { note: mark.note } : {}),
          },
          [{ type: "put", mark }],
        ),
    });
  }

  const update = (mark: Mark, patch: MarkPatch) =>
    send({ type: "update", id: mark.id, patch }, [{ type: "update", id: mark.id, patch }]);

  const categoryAction = (action: CategoryAction) => send(action, [action]);

  /** Every old key stops working; the new one is shown in place of it. */
  async function resetKey(): Promise<boolean> {
    try {
      const res = await fetch("/api/vault", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "resetKey" }),
      });
      const result = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        vault?: VaultData;
        key?: string;
        error?: string;
      };
      if (!result.ok || !result.key || !result.vault) throw new Error(result.error);
      setBase(result.vault);
      setKey(result.key);
      return true;
    } catch (error) {
      notify(error instanceof Error && error.message ? error.message : "Could not reset the key.", {
        error: true,
      });
      return false;
    }
  }

  // Paste a link anywhere on the page, or drop one in from another tab.
  useEffect(() => {
    function onPaste(event: ClipboardEvent) {
      if (isTyping(event.target)) return;
      const urls = extractUrls(event.clipboardData?.getData("text") ?? "");
      if (urls.length) {
        event.preventDefault();
        add(urls);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "/" && !isTyping(event.target) && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    }
    const external = (e: DragEvent) =>
      !e.dataTransfer?.types.includes(DRAG_TYPE) &&
      (e.dataTransfer?.types.includes("text/uri-list") || e.dataTransfer?.types.includes("text/plain"));
    function onDragOver(event: DragEvent) {
      if (!external(event)) return;
      event.preventDefault();
      setDropping(true);
    }
    function onDragLeave(event: DragEvent) {
      if (!event.relatedTarget) setDropping(false);
    }
    function onDrop(event: DragEvent) {
      setDropping(false);
      if (!external(event) || event.defaultPrevented) return;
      event.preventDefault();
      const data = event.dataTransfer!;
      add(extractUrls(data.getData("text/uri-list") || data.getData("text/plain")));
    }
    document.addEventListener("paste", onPaste);
    document.addEventListener("keydown", onKey);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("paste", onPaste);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  });

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.error ? 8000 : 5000);
    return () => clearTimeout(timer);
  }, [toast]);

  const tree = useMemo(() => categoryTree(vault), [vault]);

  // A folder counts everything inside it, however deep.
  const counts = useMemo(() => {
    const own = new Map<string, number>();
    for (const m of vault.marks) own.set(m.category, (own.get(m.category) ?? 0) + 1);
    const map = new Map<string, number>([["", own.get("") ?? 0]]);
    for (const name of vault.categories) {
      let n = 0;
      for (const c of withDescendants(vault, name)) n += own.get(c) ?? 0;
      map.set(name, n);
    }
    return map;
  }, [vault]);

  const tags = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of vault.marks) for (const t of m.tags ?? []) map.set(t, (map.get(t) ?? 0) + 1);
    return [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [vault.marks]);

  // A tag nobody has any more stops filtering.
  const activeTag = tag && tags.some(([t]) => t === tag) ? tag : null;
  const inView =
    view.kind === "category" ? withDescendants(vault, view.name) : new Set(view.kind === "inbox" ? [""] : []);
  const shown = vault.marks.filter(
    (m) =>
      (view.kind === "all" || inView.has(m.category)) &&
      (!activeTag || m.tags?.includes(activeTag)) &&
      matches(m, query),
  );

  // While a card is carried on a touch screen, the page must not scroll under
  // the finger, and the drop target under it lights up. React's touch handlers
  // are passive, so these are attached by hand.
  useEffect(() => {
    if (!carrying) return;
    const target = (touch: Touch) =>
      document.elementFromPoint(touch.clientX, touch.clientY)?.closest<HTMLElement>("[data-drop]")?.dataset
        .drop ?? null;
    function onMove(event: TouchEvent) {
      event.preventDefault();
      setHovering(target(event.touches[0]));
    }
    function onEnd(event: TouchEvent) {
      const name = event.changedTouches[0] ? target(event.changedTouches[0]) : null;
      setHovering(null);
      if (name === null) return; // Lifted elsewhere: the tray stays open to tap.
      move(carrying!, name);
      setCarrying(null);
    }
    const noMenu = (event: Event) => event.preventDefault();
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd);
    document.addEventListener("contextmenu", noMenu);
    return () => {
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("contextmenu", noMenu);
    };
  });

  const columnCount = useSyncExternalStore(
    subscribeResize,
    () => columnsFor(window.innerWidth),
    () => 3,
  );
  const columns = intoColumns(shown, columnCount);

  // A category renamed or removed out from under the open view falls back to all.
  const activeView: View =
    view.kind === "category" && !vault.categories.includes(view.name) ? { kind: "all" } : view;

  return (
    <div className="min-h-dvh">
      <div className="mx-auto flex w-full max-w-[1680px] flex-col gap-6 px-4 pb-24 pt-6 md:flex-row md:gap-10 md:px-8 md:pt-10">
        <Sidebar
          vault={vault}
          counts={counts}
          view={activeView}
          onView={setView}
          onDropMark={(id, category) => {
            const mark = vault.marks.find((m) => m.id === id);
            if (mark) move(mark, category);
          }}
          onDropUrls={(urls, category) => add(urls, category)}
          onCategory={categoryAction}
          tree={tree}
          tags={tags}
          activeTag={activeTag}
          onTag={setTag}
        />

        <main id="main-content" className="min-w-0 flex-1">
          <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
            <div>
              <h1 className="font-display text-[2rem] font-semibold leading-none tracking-[-0.03em] md:text-[2.5rem]">
                {activeView.kind === "all"
                  ? "Everything"
                  : activeView.kind === "inbox"
                    ? "Inbox"
                    : activeView.name}
              </h1>
              <p className="mt-2 flex flex-wrap items-center gap-2 font-mono text-xs tabular-nums text-ink-muted">
                <span>
                  {shown.length} {shown.length === 1 ? "link" : "links"}
                  {query && ` matching “${query}”`}
                </span>
                {activeTag && (
                  <button
                    type="button"
                    onClick={() => setTag(null)}
                    aria-label={`Stop filtering by #${activeTag}`}
                    className="flex h-6 cursor-pointer items-center gap-1 rounded-md border border-line-strong bg-surface-raised pl-1.5 pr-1 text-ink"
                  >
                    #{activeTag}
                    <X size={11} aria-hidden="true" />
                  </button>
                )}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <label className="relative">
                <span className="sr-only">Search the vault</span>
                <MagnifyingGlass
                  size={15}
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted"
                />
                <input
                  ref={searchRef}
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      setQuery("");
                      e.currentTarget.blur();
                    }
                  }}
                  placeholder="Search"
                  className="h-10 w-48 rounded-xl border border-line bg-surface-raised pl-9 pr-8 text-[14px] text-ink transition-[width,colors] placeholder:text-ink-muted focus:w-64"
                />
                <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 font-mono text-[11px] text-ink-muted">
                  /
                </kbd>
              </label>
              <button
                type="button"
                aria-label="Refresh"
                title="Refresh"
                onClick={() => refresh()}
                disabled={refreshing}
                className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-xl border border-line bg-surface-raised text-ink-muted transition-colors hover:text-ink disabled:cursor-default"
              >
                <ArrowClockwise
                  size={16}
                  aria-hidden="true"
                  className={refreshing ? "motion-safe:animate-spin" : ""}
                />
              </button>
              <ConnectButton deviceKey={key} hosted={hosted} onReset={resetKey} />
              <button
                type="button"
                aria-label="Sign out"
                title="Sign out"
                onClick={async () => {
                  await fetch("/api/logout", { method: "POST" });
                  window.location.reload();
                }}
                className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-xl border border-line bg-surface-raised text-ink-muted transition-colors hover:text-ink"
              >
                <SignOut size={16} aria-hidden="true" />
              </button>
            </div>
          </header>

          <AddBar category={targetCategory} onAdd={add} />

          {shown.length === 0 ? (
            <Empty
              view={activeView}
              searching={Boolean(query || activeTag)}
              hasAny={vault.marks.length > 0}
            />
          ) : (
            <div className="mt-2 flex items-start gap-4">
              {columns.map((column, i) => (
                <div key={i} className="flex min-w-0 flex-1 flex-col gap-4">
                  {column.map((mark) => (
                    <Card
                      key={mark.id}
                      mark={mark}
                      tree={tree}
                      allTags={tags}
                      showCategory={activeView.kind !== "category" || mark.category !== activeView.name}
                      query={query}
                      onMove={(c) => move(mark, c)}
                      onNote={(note) => update(mark, { note })}
                      onTags={(next) => update(mark, { tags: next })}
                      onTag={setTag}
                      onCarry={() => setCarrying(mark)}
                      onDelete={() => remove(mark)}
                      onCopied={() => notify("Link copied")}
                    />
                  ))}
                </div>
              ))}
            </div>
          )}
        </main>
      </div>

      {carrying && (
        <MoveTray
          mark={carrying}
          tree={tree}
          hovering={hovering}
          onMove={(name) => {
            move(carrying, name);
            setCarrying(null);
          }}
          onCancel={() => setCarrying(null)}
        />
      )}

      {dropping && (
        <div className="pointer-events-none fixed inset-3 z-40 flex items-center justify-center rounded-3xl border-2 border-dashed border-line-strong bg-surface/80 backdrop-blur-sm">
          <p className="font-display text-2xl font-semibold tracking-tight">
            Drop to save to {targetCategory || "Inbox"}
          </p>
        </div>
      )}

      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4"
      >
        {toast && (
          <div
            key={toast.id}
            role={toast.error ? "alert" : "status"}
            className="vault-toast pointer-events-auto flex items-center gap-3 rounded-2xl border border-line bg-surface-overlay py-2.5 pl-4 pr-2.5 text-[14px] shadow-[0_12px_40px_-12px_rgba(0,0,0,0.35)]"
          >
            {toast.error ? (
              <span aria-hidden="true" className="h-2 w-2 rounded-full bg-red-500" />
            ) : (
              <Check size={15} aria-hidden="true" />
            )}
            <span>{toast.message}</span>
            {toast.undo && (
              <button
                type="button"
                onClick={() => {
                  toast.undo?.();
                  setToast(null);
                }}
                className="cursor-pointer rounded-lg border border-line px-2.5 py-1 text-[13px] font-medium transition-colors hover:border-line-strong"
              >
                Undo
              </button>
            )}
          </div>
        )}
      </div>

      <style>{`
        @keyframes vault-in { from { opacity: 0; transform: translateY(8px) scale(.98) } }
        .vault-toast, .vault-card { animation: vault-in .28s cubic-bezier(.2,.8,.2,1) both }
        @keyframes vault-shimmer { to { background-position: -200% 0 } }
        .vault-shimmer {
          background: linear-gradient(90deg, var(--surface-sunken) 30%, var(--surface-raised) 50%, var(--surface-sunken) 70%);
          background-size: 200% 100%;
          animation: vault-shimmer 1.4s linear infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .vault-toast, .vault-card, .vault-shimmer { animation: none }
        }
      `}</style>
    </div>
  );
}

// --- Sidebar -----------------------------------------------------------------

function Sidebar({
  vault,
  counts,
  view,
  onView,
  onDropMark,
  onDropUrls,
  onCategory,
  tree,
  tags,
  activeTag,
  onTag,
}: {
  vault: VaultData;
  counts: Map<string, number>;
  view: View;
  onView: (view: View) => void;
  onDropMark: (id: string, category: string) => void;
  onDropUrls: (urls: string[], category: string) => void;
  onCategory: (action: CategoryAction) => void;
  tree: Tree;
  tags: [string, number][];
  activeTag: string | null;
  onTag: (tag: string | null) => void;
}) {
  /** Where a new category is being typed: `""` at the top level, or inside that folder. */
  const [adding, setAdding] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const collapsed = useCollapsed();

  function toggle(name: string) {
    const next = new Set(collapsed);
    if (!next.delete(name)) next.add(name);
    writeCollapsed(next);
  }

  const isActive = (v: View) =>
    v.kind === view.kind && (v.kind !== "category" || (view.kind === "category" && v.name === view.name));

  const nest = (name: string, parent: string) => onCategory({ type: "moveCategory", name, parent });

  const newInput = (parent: string, depth: number) => (
    <li key={`new:${parent}`} className={`shrink-0 ${INDENT}`} style={depthVar(depth)}>
      <CategoryInput
        initial=""
        label={parent ? `New folder in ${parent}` : "New category name"}
        onDone={(value) => {
          setAdding(null);
          if (value) {
            onCategory({ type: "addCategory", name: value, ...(parent ? { parent } : {}) });
            onView({ kind: "category", name: value });
          }
        }}
      />
    </li>
  );

  const rows: React.ReactNode[] = [];
  /** Below a closed folder, everything deeper than it is skipped. */
  let closedAt = Infinity;
  tree.forEach(({ name, depth }, i) => {
    if (depth > closedAt) return;
    closedAt = Infinity;
    const hasChildren = (tree[i + 1]?.depth ?? -1) > depth;
    const open = !collapsed.has(name);
    if (hasChildren && !open) closedAt = depth;
    const indent = depthVar(depth);
    if (editing === name) {
      const inside = withDescendants(vault, name);
      rows.push(
        <li key={name} className={`shrink-0 ${INDENT}`} style={indent}>
          <CategoryInput
            initial={name}
            label={`Rename ${name}`}
            onDone={(value) => {
              setEditing(null);
              if (value && value !== name) {
                onCategory({ type: "renameCategory", from: name, to: value });
                onView({ kind: "category", name: value });
              }
            }}
            onRemove={() => {
              setEditing(null);
              onCategory({ type: "removeCategory", name });
              const up = parentOf(vault, name);
              onView(up ? { kind: "category", name: up } : { kind: "inbox" });
            }}
            removeHint={`Its links move to ${parentOf(vault, name) || "the inbox"}.`}
            parent={parentOf(vault, name)}
            parents={tree.filter((t) => !inside.has(t.name))}
            onParent={(parent) => nest(name, parent)}
            onSubfolder={() => {
              setEditing(null);
              setAdding(name);
              if (!open) toggle(name);
            }}
          />
        </li>,
      );
    } else {
      rows.push(
        <Row
          key={name}
          label={name}
          style={indent}
          icon={hasChildren ? null : <Dot name={name} />}
          folder={hasChildren ? { open, onToggle: () => toggle(name), hue: hue(name) } : undefined}
          count={counts.get(name) ?? 0}
          active={isActive({ kind: "category", name })}
          onClick={() => onView({ kind: "category", name })}
          onEdit={() => setEditing(name)}
          drop={name}
          onDropMark={(id) => onDropMark(id, name)}
          onDropUrls={(urls) => onDropUrls(urls, name)}
          onDropCategory={(dragged) => nest(dragged, name)}
        />,
      );
    }
    // A new folder is typed in at the end of the folder it goes in.
    const next = tree[i + 1];
    if (
      adding &&
      withDescendants(vault, adding).has(name) &&
      !(next && withDescendants(vault, adding).has(next.name))
    ) {
      rows.push(newInput(adding, (tree.find((t) => t.name === adding)?.depth ?? 0) + 1));
    }
  });

  return (
    <nav
      aria-label="Categories"
      className="md:sticky md:top-10 md:h-[calc(100dvh-5rem)] md:w-56 md:shrink-0 md:overflow-y-auto"
    >
      <p className="hidden px-3 pb-4 font-mono text-xs uppercase tracking-[0.14em] text-ink-muted md:block">
        gitmarks
      </p>
      <ul className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 md:mx-0 md:flex-col md:gap-0.5 md:overflow-visible md:px-0">
        <Row
          label="Everything"
          icon={<SquaresFour size={15} aria-hidden="true" />}
          count={vault.marks.length}
          active={isActive({ kind: "all" })}
          onClick={() => onView({ kind: "all" })}
        />
        <Row
          label="Inbox"
          icon={<Tray size={15} aria-hidden="true" />}
          count={counts.get("") ?? 0}
          active={isActive({ kind: "inbox" })}
          onClick={() => onView({ kind: "inbox" })}
          drop=""
          onDropMark={(id) => onDropMark(id, "")}
          onDropUrls={(urls) => onDropUrls(urls, "")}
        />
        <DropHeading label="Categories" onDropCategory={(dragged) => nest(dragged, "")} />
        {rows}
        {adding === "" ? (
          newInput("", 0)
        ) : (
          <li className="shrink-0">
            <button
              type="button"
              onClick={() => setAdding("")}
              className="flex h-9 w-full cursor-pointer items-center gap-2.5 whitespace-nowrap rounded-xl px-3 text-[14px] text-ink-muted transition-colors hover:text-ink"
            >
              <Plus size={15} aria-hidden="true" />
              New category
            </button>
          </li>
        )}
        {tags.length > 0 && (
          <>
            <li
              aria-hidden="true"
              className="hidden px-3 pb-1.5 pt-5 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-muted md:block"
            >
              Tags
            </li>
            {tags.map(([t, n]) => (
              <Row
                key={`#${t}`}
                label={t}
                icon={<Hash size={13} aria-hidden="true" />}
                count={n}
                active={activeTag === t}
                onClick={() => onTag(activeTag === t ? null : t)}
              />
            ))}
          </>
        )}
      </ul>
    </nav>
  );
}

/** The "Categories" heading, which takes a dragged folder back to the top level. */
function DropHeading({ label, onDropCategory }: { label: string; onDropCategory: (name: string) => void }) {
  const [over, setOver] = useState(false);
  return (
    <li
      aria-hidden="true"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DRAG_CATEGORY)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const name = e.dataTransfer.getData(DRAG_CATEGORY);
        if (!name) return;
        e.preventDefault();
        onDropCategory(name);
      }}
      className={`hidden rounded-lg px-3 pb-1.5 pt-5 font-mono text-[11px] uppercase tracking-[0.14em] transition-colors md:block ${
        over ? "text-ink" : "text-ink-muted"
      }`}
    >
      {label}
      {over && <span className="ml-2 normal-case tracking-normal">· move to top</span>}
    </li>
  );
}

function Row({
  label,
  icon,
  count,
  active,
  onClick,
  onEdit,
  drop,
  onDropMark,
  onDropUrls,
  onDropCategory,
  style,
  folder,
}: {
  label: string;
  icon: React.ReactNode;
  count: number;
  active: boolean;
  onClick: () => void;
  onEdit?: () => void;
  /** The category a card dropped here goes to, for touch drags as well as mouse ones. */
  drop?: string;
  onDropMark?: (id: string) => void;
  onDropUrls?: (urls: string[]) => void;
  /** Another category dropped here goes inside this one. */
  onDropCategory?: (name: string) => void;
  style?: React.CSSProperties;
  /** A folder with folders inside, which opens and closes. Its caret sits where the dot would. */
  folder?: { open: boolean; onToggle: () => void; hue: number };
}) {
  const [over, setOver] = useState(false);
  const droppable = Boolean(onDropMark);
  return (
    <li
      className={`group/row relative shrink-0 ${style ? INDENT : ""}`}
      style={style}
      data-drop={drop}
      onDragOver={(e) => {
        const category = e.dataTransfer.types.includes(DRAG_CATEGORY);
        if (!droppable || (category && !onDropCategory)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = category || e.dataTransfer.types.includes(DRAG_TYPE) ? "move" : "copy";
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (!droppable) return;
        e.preventDefault();
        setOver(false);
        const category = e.dataTransfer.getData(DRAG_CATEGORY);
        if (category) {
          if (category !== label) onDropCategory?.(category);
          return;
        }
        const id = e.dataTransfer.getData(DRAG_TYPE);
        if (id) onDropMark?.(id);
        else
          onDropUrls?.(
            extractUrls(e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain")),
          );
      }}
    >
      <button
        type="button"
        onClick={onClick}
        aria-current={active ? "page" : undefined}
        onDoubleClick={onEdit}
        draggable={Boolean(onDropCategory)}
        onDragStart={(e) => {
          if (!onDropCategory) return;
          e.dataTransfer.setData(DRAG_CATEGORY, label);
          e.dataTransfer.effectAllowed = "move";
        }}
        className={`flex h-9 w-full cursor-pointer items-center gap-2.5 whitespace-nowrap rounded-xl border px-3 text-left text-[14px] transition-all ${
          over
            ? "scale-[1.03] border-line-strong bg-surface-raised text-ink shadow-sm"
            : active
              ? "border-line bg-surface-raised font-medium text-ink shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
              : "border-transparent text-ink-muted hover:text-ink"
        }`}
      >
        <span className="flex w-4 justify-center">{icon}</span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span
          className={`font-mono text-[11px] tabular-nums text-ink-muted ${onEdit ? "md:group-hover/row:opacity-0" : ""}`}
        >
          {count}
        </span>
      </button>
      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          aria-label={`Edit ${label}`}
          className="absolute right-1.5 top-1/2 hidden h-6 w-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-ink-muted opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 group-hover/row:opacity-100 md:flex"
        >
          <PencilSimple size={13} aria-hidden="true" />
        </button>
      )}
      {folder && (
        <button
          type="button"
          onClick={folder.onToggle}
          aria-expanded={folder.open}
          aria-label={`${folder.open ? "Close" : "Open"} ${label}`}
          className="absolute left-[9px] top-1/2 flex h-6 w-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md hover:bg-surface-sunken md:left-[calc(var(--depth)*14px_+_9px)]"
          style={{ color: `oklch(0.62 0.15 ${folder.hue})` }}
        >
          <CaretRight
            size={12}
            weight="bold"
            aria-hidden="true"
            className={`transition-transform ${folder.open ? "rotate-90" : ""}`}
          />
        </button>
      )}
    </li>
  );
}

/**
 * Typing a category's name, new or renamed. Renaming also offers what has no
 * drag on a phone or a keyboard: which folder it sits in, a folder inside it,
 * and deleting it.
 */
function CategoryInput({
  initial,
  label,
  onDone,
  onRemove,
  removeHint,
  parent,
  parents,
  onParent,
  onSubfolder,
}: {
  initial: string;
  label: string;
  onDone: (value: string) => void;
  onRemove?: () => void;
  removeHint?: string;
  parent?: string;
  /** Where it may move: never into itself or a folder of its own. */
  parents?: Tree;
  onParent?: (parent: string) => void;
  onSubfolder?: () => void;
}) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (v: string) => {
    if (done.current) return;
    done.current = true;
    onDone(v.trim());
  };
  // Buttons here act on mouse-down, before the input's blur would close the editor.
  const press = (fn: () => void) => (e: React.MouseEvent) => {
    e.preventDefault();
    done.current = true;
    fn();
  };
  return (
    <div
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) finish(value);
      }}
      className="rounded-xl border border-line-strong bg-surface-raised"
    >
      <div className="flex h-9 items-center gap-1 pl-3 pr-1">
        <Dot name={value || "new"} />
        <input
          // eslint-disable-next-line jsx-a11y/no-autofocus -- opened by the click that wants to type here
          autoFocus
          value={value}
          maxLength={40}
          aria-label={label}
          placeholder="Name"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") finish(value);
            if (e.key === "Escape") finish(initial);
          }}
          className="min-w-0 flex-1 bg-transparent pl-1.5 text-[14px] text-ink outline-none placeholder:text-ink-muted"
        />
        {onRemove && (
          <button
            type="button"
            aria-label={`Delete ${initial}. ${removeHint}`}
            title={`Delete category. ${removeHint}`}
            onMouseDown={press(onRemove)}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-ink-muted transition-colors hover:text-red-600"
          >
            <Trash size={14} aria-hidden="true" />
          </button>
        )}
      </div>
      {onParent && parents && (
        <div className="flex items-center gap-1 border-t border-line py-1 pl-3 pr-1 text-[12px] text-ink-muted">
          <label className="flex min-w-0 flex-1 items-center gap-1.5">
            In
            <select
              value={parent ?? ""}
              onChange={(e) => {
                done.current = true;
                onParent(e.target.value);
                onDone(value.trim());
              }}
              className="min-w-0 flex-1 cursor-pointer truncate rounded-md bg-transparent py-1 text-ink"
            >
              <option value="">Top level</option>
              {parents.map((t) => (
                <option key={t.name} value={t.name}>
                  {"\u00a0\u00a0".repeat(t.depth)}
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          {onSubfolder && (
            <button
              type="button"
              onMouseDown={press(onSubfolder)}
              title="New folder inside this one"
              className="flex h-7 cursor-pointer items-center gap-1 rounded-lg px-1.5 transition-colors hover:text-ink"
            >
              <FolderPlus size={14} aria-hidden="true" /> Folder
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// --- Adding ------------------------------------------------------------------

function AddBar({ category, onAdd }: { category: string; onAdd: (urls: string[]) => boolean }) {
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);

  function submit(text: string) {
    if (onAdd(extractUrls(text))) setValue("");
    else setInvalid(true);
  }

  return (
    <form
      className="group/add mt-6"
      onSubmit={(e) => {
        e.preventDefault();
        submit(value);
      }}
    >
      <label className="flex h-14 items-center gap-3 rounded-2xl border border-line bg-surface-raised pl-4 pr-2 shadow-[0_1px_2px_rgba(0,0,0,0.03),0_8px_24px_-16px_rgba(0,0,0,0.18)] transition-[border-color,box-shadow] focus-within:border-line-strong focus-within:shadow-[0_1px_2px_rgba(0,0,0,0.03),0_16px_40px_-18px_rgba(0,0,0,0.28)]">
        <LinkSimple size={18} aria-hidden="true" className="shrink-0 text-ink-muted" />
        <span className="sr-only">Add links</span>
        <input
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setInvalid(false);
          }}
          onPaste={(e) => {
            // Pasting a link into an empty bar is the whole gesture: save it.
            const text = e.clipboardData.getData("text");
            if (!value && extractUrls(text).length) {
              e.preventDefault();
              submit(text);
            }
          }}
          aria-invalid={invalid}
          aria-describedby={invalid ? "vault-add-error" : undefined}
          placeholder="Paste a link — or several — anywhere on this page"
          className="h-full min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-muted"
        />
        <span className="hidden items-center gap-1.5 whitespace-nowrap rounded-lg border border-line px-2.5 py-1 text-[12px] text-ink-muted sm:flex">
          {category ? <Dot name={category} /> : <Tray size={12} aria-hidden="true" />}
          {category || "Inbox"}
        </span>
        <button
          type="submit"
          disabled={!value.trim()}
          className="h-10 cursor-pointer rounded-xl bg-ink px-4 text-[14px] font-medium text-surface transition-opacity disabled:cursor-default disabled:opacity-30"
        >
          Save
        </button>
      </label>
      <p id="vault-add-error" className="mt-2 min-h-5 px-1 text-[13px] text-ink-muted">
        {invalid ? (
          <span className="text-red-600 dark:text-red-400">That doesn’t look like a link.</span>
        ) : (
          <span className="opacity-0 transition-opacity group-focus-within/add:opacity-100">
            Enter to save · drop links from other tabs straight onto a category
          </span>
        )}
      </p>
    </form>
  );
}

// --- Cards -------------------------------------------------------------------

/** How long a finger rests on a card before it picks it up. */
const HOLD_MS = 420;

function Card({
  mark,
  tree,
  allTags,
  showCategory,
  query,
  onMove,
  onNote,
  onTags,
  onTag,
  onCarry,
  onDelete,
  onCopied,
}: {
  mark: Mark;
  tree: Tree;
  allTags: [string, number][];
  showCategory: boolean;
  query: string;
  onMove: (category: string) => void;
  onNote: (note: string) => void;
  onTags: (tags: string[]) => void;
  onTag: (tag: string) => void;
  /** A touch screen's drag: the card was held down, so offer somewhere to drop it. */
  onCarry: () => void;
  onDelete: () => void;
  onCopied: () => void;
}) {
  const [brokenImage, setBrokenImage] = useState(false);
  const [editingNote, setEditingNote] = useState(false);
  const [editingTags, setEditingTags] = useState(false);
  const hold = useRef<{ timer: number; x: number; y: number; fired: boolean } | null>(null);
  const letGo = () => {
    if (hold.current) clearTimeout(hold.current.timer);
  };
  const image = mark.image && !brokenImage ? mark.image : undefined;
  // An image that fails before hydration fires its error event with no React
  // handler attached yet, so check on mount as well.
  const catchEarlyError = (el: HTMLImageElement | null) => {
    if (el?.complete && el.naturalWidth === 0) setBrokenImage(true);
  };
  const isX = mark.kind === "x";
  const hl = (text: string) => <Highlight text={text} query={query} />;
  // A match past the clamp would be hidden, so a matching description opens up.
  const descriptionHit = splitMatches(mark.description, query).length > 1;

  if (mark.pending) {
    return (
      <article
        aria-busy="true"
        className="vault-card overflow-hidden rounded-2xl border border-line bg-surface-raised"
      >
        <div className="vault-shimmer h-36" />
        <div className="space-y-2.5 p-4">
          <div className="vault-shimmer h-3 w-1/3 rounded" />
          <div className="vault-shimmer h-4 w-4/5 rounded" />
          <p className="truncate pt-1 font-mono text-[11px] text-ink-muted">Fetching {mark.title}</p>
        </div>
      </article>
    );
  }

  return (
    <article
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, mark.id);
        e.dataTransfer.setData("text/uri-list", mark.url);
        e.dataTransfer.effectAllowed = "copyMove";
      }}
      // Mouse drags are the browser's own. Touch has none, so holding a card
      // still for a moment picks it up instead; moving first is a scroll.
      onTouchStart={(e) => {
        if (e.touches.length !== 1 || isTyping(e.target)) return;
        const { clientX: x, clientY: y } = e.touches[0];
        letGo();
        hold.current = {
          x,
          y,
          fired: false,
          timer: window.setTimeout(() => {
            if (!hold.current) return;
            hold.current.fired = true;
            navigator.vibrate?.(10);
            onCarry();
          }, HOLD_MS),
        };
      }}
      onTouchMove={(e) => {
        const h = hold.current;
        const t = e.touches[0];
        if (h && !h.fired && Math.hypot(t.clientX - h.x, t.clientY - h.y) > 10) letGo();
      }}
      onTouchEnd={letGo}
      onTouchCancel={letGo}
      // The tap that ends a hold must not also open the link.
      onClickCapture={(e) => {
        if (hold.current?.fired) {
          e.preventDefault();
          e.stopPropagation();
        }
        hold.current = null;
      }}
      className="vault-card group relative overflow-hidden rounded-2xl border border-line bg-surface-raised transition-[border-color,box-shadow,transform] [-webkit-touch-callout:none] hover:-translate-y-0.5 hover:border-line-strong hover:shadow-[0_18px_40px_-24px_rgba(0,0,0,0.35)] pointer-coarse:select-none"
    >
      {image && !isX && (
        <img
          src={image}
          alt=""
          loading="lazy"
          draggable={false}
          onError={() => setBrokenImage(true)}
          ref={catchEarlyError}
          className="aspect-[1.91/1] w-full border-b border-line object-cover"
        />
      )}

      <div className="p-4">
        {isX ? (
          <div className="mb-3 flex items-center gap-2.5">
            {mark.author?.avatar ? (
              <img
                src={mark.author.avatar}
                alt=""
                draggable={false}
                className="h-9 w-9 rounded-full border border-line"
              />
            ) : (
              <span className="flex h-9 w-9 items-center justify-center rounded-full border border-line">
                <XLogo size={14} aria-hidden="true" />
              </span>
            )}
            <div className="min-w-0 flex-1 leading-tight">
              <p className="truncate text-[14px] font-semibold">{hl(mark.author?.name ?? "Post on X")}</p>
              {mark.author?.handle && (
                <p className="truncate text-[13px] text-ink-muted">@{hl(mark.author.handle)}</p>
              )}
            </div>
            <XLogo size={15} aria-hidden="true" className="shrink-0 text-ink-muted" />
          </div>
        ) : (
          <div className="mb-2 flex items-center gap-2 text-[12px] text-ink-muted">
            <img src={favicon(mark.site)} alt="" draggable={false} className="h-4 w-4 rounded-[4px]" />
            <span className="truncate">{hl(mark.site)}</span>
          </div>
        )}

        <h2
          className={
            isX ? "sr-only" : "font-display text-[1.0625rem] font-semibold leading-snug tracking-[-0.01em]"
          }
        >
          <a
            href={mark.url}
            target="_blank"
            rel="noopener noreferrer"
            draggable={false}
            // Stretched over the whole card, so any blank part of it opens the link.
            className="outline-none after:absolute after:inset-0 after:rounded-2xl after:content-[''] focus-visible:after:outline focus-visible:after:outline-2 focus-visible:after:outline-[var(--focus-ring)]"
          >
            {hl(mark.title)}
            {!isX && (
              <ArrowUpRight
                size={13}
                aria-hidden="true"
                className="ml-1 inline -translate-y-px opacity-0 transition-opacity group-hover:opacity-60"
              />
            )}
          </a>
        </h2>

        {mark.description && (
          <p
            className={
              isX
                ? `whitespace-pre-line text-[15px] leading-[1.5] ${descriptionHit ? "" : "line-clamp-[12]"}`
                : `mt-1.5 text-[14px] leading-[1.5] text-ink-muted ${descriptionHit ? "" : "line-clamp-3"}`
            }
          >
            {hl(mark.description)}
          </p>
        )}

        {image && isX && (
          <img
            src={image}
            alt=""
            loading="lazy"
            draggable={false}
            onError={() => setBrokenImage(true)}
            ref={catchEarlyError}
            className="mt-3 max-h-80 w-full rounded-xl border border-line object-cover"
          />
        )}

        {editingTags ? (
          <TagEditor
            initial={mark.tags ?? []}
            suggestions={allTags.map(([t]) => t)}
            onDone={(next) => {
              setEditingTags(false);
              if (next.join("\n") !== (mark.tags ?? []).join("\n")) onTags(next);
            }}
          />
        ) : (
          mark.tags && (
            <ul className="relative z-10 mt-3 flex flex-wrap gap-1.5">
              {mark.tags.map((t) => (
                <li key={t}>
                  <button
                    type="button"
                    onClick={() => onTag(t)}
                    title={`Show everything tagged #${t}`}
                    className="cursor-pointer rounded-md bg-surface-sunken px-1.5 py-0.5 font-mono text-[11.5px] text-ink-muted transition-colors hover:text-ink"
                  >
                    #{hl(t)}
                  </button>
                </li>
              ))}
            </ul>
          )
        )}

        {editingNote ? (
          <NoteEditor
            initial={mark.note ?? ""}
            onDone={(note) => {
              setEditingNote(false);
              if (note !== (mark.note ?? "")) onNote(note);
            }}
          />
        ) : (
          mark.note && (
            <p className="mt-3 border-l-2 border-line-strong pl-3 text-[13.5px] leading-[1.5] whitespace-pre-line">
              {hl(mark.note)}
            </p>
          )
        )}

        <footer className="relative z-10 mt-4 flex items-center gap-1">
          <CategoryPicker
            current={mark.category}
            tree={tree}
            onMove={onMove}
            // Inside a category every card would repeat its name, so it recedes.
            quiet={!showCategory && Boolean(mark.category)}
          />
          <time
            dateTime={mark.createdAt}
            suppressHydrationWarning
            className="ml-1 font-mono text-[11px] tabular-nums text-ink-muted"
          >
            {ago(mark.createdAt)}
          </time>
          <div className="ml-auto flex items-center opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
            <IconButton label="Edit tags" onClick={() => setEditingTags(true)}>
              <Hash size={15} aria-hidden="true" />
            </IconButton>
            <IconButton label="Edit note" onClick={() => setEditingNote(true)}>
              <NotePencil size={15} aria-hidden="true" />
            </IconButton>
            <IconButton
              label="Copy link"
              onClick={async () => {
                await navigator.clipboard.writeText(mark.url);
                onCopied();
              }}
            >
              <Copy size={15} aria-hidden="true" />
            </IconButton>
            <IconButton label="Delete" onClick={onDelete} danger>
              <Trash size={15} aria-hidden="true" />
            </IconButton>
          </div>
        </footer>
      </div>
    </article>
  );
}

/** Search matches marked in the signal colour, the one the site keeps for "look here". */
function Highlight({ text, query }: { text: string; query: string }) {
  const parts = splitMatches(text, query);
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    i % 2 ? (
      <mark key={i} className="rounded-[3px] bg-signal px-[1px] text-signal-ink">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

const NEW = "\u0000new";

/** A chip with a native select laid over it: the OS picker, the site's look. */
function CategoryPicker({
  current,
  tree,
  onMove,
  quiet = false,
}: {
  current: string;
  tree: Tree;
  /** Moving to a name that does not exist yet creates it. */
  onMove: (category: string) => void;
  quiet?: boolean;
}) {
  return (
    <span
      className={`relative flex h-7 max-w-[11rem] items-center gap-1.5 rounded-lg border px-2 text-[12px] transition-colors hover:border-line-strong ${
        quiet ? "border-transparent text-ink-muted" : "border-line text-ink"
      }`}
    >
      {current ? <Dot name={current} /> : <Tray size={12} aria-hidden="true" />}
      <span className="truncate">{current || "Inbox"}</span>
      <select
        aria-label="Move to category"
        value={current}
        onChange={(e) => {
          const name = e.target.value === NEW ? window.prompt("New category")?.trim() : e.target.value;
          if (name !== undefined) onMove(name);
        }}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        <option value="">Inbox</option>
        {tree.map((c) => (
          <option key={c.name} value={c.name}>
            {"\u00a0\u00a0\u00a0".repeat(c.depth)}
            {c.name}
          </option>
        ))}
        <option value={NEW}>New category…</option>
      </select>
    </span>
  );
}

function IconButton({
  label,
  onClick,
  danger = false,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-ink-muted transition-colors ${
        danger ? "hover:text-red-600 dark:hover:text-red-400" : "hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

function NoteEditor({ initial, onDone }: { initial: string; onDone: (note: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <textarea
      // eslint-disable-next-line jsx-a11y/no-autofocus -- opened by the click that wants to type here
      autoFocus
      value={value}
      rows={3}
      maxLength={2000}
      aria-label="Note"
      placeholder="Why did you keep this?"
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onDone(value.trim())}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.blur();
        if (e.key === "Escape") {
          setValue(initial);
          onDone(initial);
        }
      }}
      className="relative z-10 mt-3 w-full resize-none rounded-xl border border-line-strong bg-surface-raised p-3 text-[13.5px] leading-[1.5] text-ink outline-none placeholder:text-ink-muted"
    />
  );
}

/** Tags as chips: Enter or a comma ends one, Backspace on an empty field takes the last back. */
function TagEditor({
  initial,
  suggestions,
  onDone,
}: {
  initial: string[];
  suggestions: string[];
  onDone: (tags: string[]) => void;
}) {
  const [tags, setTags] = useState(initial);
  const [value, setValue] = useState("");
  const listId = useId();
  const withTyped = () => {
    const t = cleanTag(value);
    return t && !tags.includes(t) ? [...tags, t].slice(0, MAX_TAGS) : tags;
  };
  return (
    <div
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onDone(withTyped());
      }}
      className="relative z-10 mt-3 flex flex-wrap items-center gap-1.5 rounded-xl border border-line-strong bg-surface-raised p-2"
    >
      {tags.map((t) => (
        <button
          key={t}
          type="button"
          aria-label={`Remove #${t}`}
          onClick={() => setTags(tags.filter((x) => x !== t))}
          className="flex cursor-pointer items-center gap-1 rounded-md bg-surface-sunken px-1.5 py-0.5 font-mono text-[11.5px] text-ink"
        >
          #{t}
          <X size={10} aria-hidden="true" />
        </button>
      ))}
      <input
        // eslint-disable-next-line jsx-a11y/no-autofocus -- opened by the click that wants to type here
        autoFocus
        value={value}
        list={listId}
        aria-label="Add a tag"
        placeholder={tags.length ? "" : "Add tags"}
        onChange={(e) => {
          // A comma typed or pasted ends the tag before it.
          const parts = e.target.value.split(",");
          if (parts.length > 1) {
            const added = parts
              .slice(0, -1)
              .map(cleanTag)
              .filter((t) => t && !tags.includes(t));
            setTags([...tags, ...new Set(added)].slice(0, MAX_TAGS));
          }
          setValue(parts[parts.length - 1]);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (value.trim()) {
              setTags(withTyped());
              setValue("");
            } else onDone(tags);
          }
          if (e.key === "Backspace" && !value && tags.length) setTags(tags.slice(0, -1));
          if (e.key === "Escape") onDone(initial);
        }}
        className="min-w-[6rem] flex-1 bg-transparent font-mono text-[12.5px] text-ink outline-none placeholder:font-sans placeholder:text-ink-muted"
      />
      <datalist id={listId}>
        {suggestions
          .filter((t) => !tags.includes(t))
          .map((t) => (
            <option key={t} value={t} />
          ))}
      </datalist>
    </div>
  );
}

/**
 * Where a held card goes on a touch screen: slide the finger onto a category,
 * or let go and tap one. Pinned to the bottom, so the targets are always in
 * reach, however far down the page the card was.
 */
function MoveTray({
  mark,
  tree,
  hovering,
  onMove,
  onCancel,
}: {
  mark: Mark;
  tree: Tree;
  hovering: string | null;
  onMove: (category: string) => void;
  onCancel: () => void;
}) {
  const targets = [{ name: "", depth: 0 }, ...tree];
  return (
    <div className="fixed inset-0 z-[60] flex flex-col justify-end">
      <button
        type="button"
        aria-label="Cancel moving"
        onClick={onCancel}
        className="absolute inset-0 cursor-default bg-black/30 backdrop-blur-[2px]"
      />
      <div
        role="dialog"
        aria-label={`Move ${mark.title}`}
        className="vault-toast relative max-h-[60dvh] overflow-y-auto rounded-t-3xl border border-line bg-surface p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-[0_-20px_60px_-20px_rgba(0,0,0,0.4)]"
      >
        <p className="truncate px-1 text-[13px] text-ink-muted">
          Move <span className="text-ink">{mark.title}</span> to
        </p>
        <ul className="mt-3 grid grid-cols-2 gap-2">
          {targets.map(({ name, depth }) => (
            <li key={name || "inbox"} data-drop={name}>
              <button
                type="button"
                onClick={() => onMove(name)}
                aria-current={mark.category === name ? "true" : undefined}
                className={`flex h-12 w-full cursor-pointer items-center gap-2 rounded-2xl border px-3 text-left text-[14px] transition-all ${
                  hovering === name
                    ? "scale-[1.03] border-ink bg-surface-raised text-ink shadow-md"
                    : mark.category === name
                      ? "border-line-strong bg-surface-sunken text-ink-muted"
                      : "border-line bg-surface-raised text-ink"
                }`}
              >
                {name ? <Dot name={name} /> : <Tray size={14} aria-hidden="true" />}
                <span className="min-w-0 flex-1 truncate">
                  {depth > 0 && <span className="text-ink-muted">{"› ".repeat(depth)}</span>}
                  {name || "Inbox"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Empty({ view, searching, hasAny }: { view: View; searching: boolean; hasAny: boolean }) {
  const kbd = "rounded-md border border-line bg-surface-raised px-1.5 py-0.5 font-mono text-[12px] text-ink";
  return (
    <div className="mt-6 flex flex-col items-center justify-center rounded-3xl border border-dashed border-line-strong px-6 py-24 text-center">
      <LinkSimple size={28} aria-hidden="true" className="text-ink-muted" />
      <p className="mt-4 font-display text-xl font-semibold tracking-tight">
        {searching
          ? "Nothing matches that."
          : !hasAny
            ? "Your vault is empty."
            : view.kind === "category"
              ? `Nothing in ${view.name} yet.`
              : "Inbox zero."}
      </p>
      {!searching && (
        <p className="mt-2 max-w-sm text-[14px] leading-relaxed text-ink-muted">
          Press <kbd className={kbd}>⌘V</kbd> anywhere to save a link
          {view.kind === "category" ? " here" : ""}, drag one in from another tab, or drop cards onto a
          category to sort them.
        </p>
      )}
    </div>
  );
}

// --- Connecting devices -------------------------------------------------------

export const SHORTCUT_LINK = "https://www.icloud.com/shortcuts/6d21e0a023ad4bcf9dab29756d07253f";
export const EXTENSION_LINK =
  "https://chromewebstore.google.com/detail/gitmarks/alnhmhklodcajljkfbonfhkbeaedkalf";

/**
 * A bookmark whose address is a script: on any page, it opens this site's
 * share page with that page's link. Nothing to install, so it covers Safari,
 * Firefox and every browser the extension doesn't.
 */
const bookmarklet = (origin: string) =>
  `javascript:void window.open(${JSON.stringify(`${origin}/share?popup=1&url=`)}+encodeURIComponent(location.href)+"&title="+encodeURIComponent(document.title),"gitmarks","popup,width=440,height=680")`;

function CopyButton({
  value,
  label = "Copy",
  strong = false,
}: {
  value: string;
  label?: string;
  strong?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      }}
      className={`flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium transition-colors ${
        strong ? "bg-ink text-surface" : "border border-line-strong text-ink hover:bg-surface-sunken"
      }`}
    >
      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      {copied ? "Copied" : label}
    </button>
  );
}

type Device = "ios" | "android" | "chrome" | "other";

const DEVICES: { id: Device; tab: string; name: string }[] = [
  { id: "ios", tab: "iPhone", name: "iPhone & iPad" },
  { id: "android", tab: "Android", name: "Android" },
  { id: "chrome", tab: "Chrome", name: "Chrome, Arc, Brave, Edge" },
  { id: "other", tab: "Others", name: "Safari, Firefox, any browser" },
];

/** Opens on the tab for the device in hand. */
function guessDevice(): Device {
  const ua = navigator.userAgent;
  if (/iPhone|iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "ios";
  if (/Android/.test(ua)) return "android";
  if (/Firefox/.test(ua) || (/Safari/.test(ua) && !/Chrome|Chromium/.test(ua))) return "other";
  return "chrome";
}

function Steps({ children }: { children: React.ReactNode }) {
  return <ol className="space-y-3">{children}</ol>;
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3 text-[14px] leading-relaxed">
      <span
        aria-hidden="true"
        className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-sunken font-mono text-[11px] text-ink-muted"
      >
        {n}
      </span>
      <span className="min-w-0">{children}</span>
    </li>
  );
}

function GetLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-2 inline-flex h-9 items-center gap-1.5 rounded-lg bg-ink px-3.5 text-[13px] font-medium text-surface"
    >
      {children}
      <ArrowUpRight size={13} aria-hidden="true" />
    </a>
  );
}

/** How to save from everywhere else, with the key ready to copy and to reset. */
function ConnectButton({
  deviceKey,
  hosted,
  onReset,
}: {
  deviceKey: string;
  hosted: boolean;
  onReset: () => Promise<boolean>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [device, setDevice] = useState<Device>("chrome");
  const [reset, setReset] = useState<"idle" | "confirm" | "working" | "done">("idle");
  const [hint, setHint] = useState(false);
  const origin = useSyncExternalStore(
    () => () => {},
    () => window.location.origin,
    () => "",
  );
  const label = "font-mono text-[11px] uppercase tracking-[0.14em] text-ink-muted";
  const strong = "font-medium text-ink";
  const name = DEVICES.find((d) => d.id === device)!.name;

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setDevice(guessDevice());
          dialog.current?.showModal();
        }}
        aria-label="Connect"
        title="Connect your devices"
        className="flex h-10 cursor-pointer items-center gap-2 rounded-xl border border-line bg-surface-raised px-3 text-[14px] text-ink-muted transition-colors hover:text-ink"
      >
        <DeviceMobile size={16} aria-hidden="true" />
        <span className="hidden sm:inline">Connect</span>
      </button>
      {/* A click on the backdrop closes it. Keyboard users have Escape (native to
          <dialog>) and the close button, so no key handler is missing. */}
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions */}
      <dialog
        ref={dialog}
        aria-labelledby="connect-title"
        onClick={(e) => e.target === e.currentTarget && e.currentTarget.close()}
        onClose={() => {
          setReset("idle");
          setHint(false);
        }}
        className="m-auto max-h-[calc(100dvh-2rem)] w-[min(520px,calc(100vw-2rem))] rounded-3xl border border-line bg-surface p-0 text-ink backdrop:bg-black/40 backdrop:backdrop-blur-sm"
      >
        <div className="p-6 sm:p-7">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 id="connect-title" className="font-display text-2xl font-semibold tracking-[-0.02em]">
                Save from everywhere
              </h2>
              <p className="mt-1.5 text-[14px] text-ink-muted">
                Connect your phone and browsers in a minute.
              </p>
            </div>
            <form method="dialog">
              <button
                aria-label="Close"
                className="-mr-2 -mt-1 flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink"
              >
                <X size={16} aria-hidden="true" />
              </button>
            </form>
          </div>

          {/* The key, and what to do if it leaks. */}
          <section
            aria-labelledby="key-title"
            className="mt-6 rounded-2xl border border-line bg-surface-raised"
          >
            <div className="p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <h3 id="key-title" className={label}>
                    Your key
                  </h3>
                  <p className="mt-1.5 truncate font-mono text-[14px]">
                    {deviceKey.slice(0, 6)}••••••••{deviceKey.slice(-4)}
                  </p>
                </div>
                <CopyButton value={deviceKey} label="Copy key" strong />
              </div>
              <p className="mt-3 text-[13px] text-ink-muted">
                The Shortcut and the extension ask for it once. Keep it private: anyone with it can save to
                your gitmarks.
              </p>
              {!hosted && (
                <div className="mt-4 flex items-center justify-between gap-3 border-t border-line pt-4">
                  <div className="min-w-0">
                    <p className={label}>Address</p>
                    <p className="mt-1.5 truncate font-mono text-[14px]">{origin}</p>
                  </div>
                  <CopyButton value={origin} />
                </div>
              )}
            </div>

            <div className="border-t border-line p-4">
              {reset === "idle" && (
                <div className="flex items-center justify-between gap-3">
                  <p className="text-[13px] text-ink-muted">Shared your key by mistake?</p>
                  <button
                    type="button"
                    onClick={() => setReset("confirm")}
                    className="h-9 shrink-0 cursor-pointer rounded-lg border border-red-500/40 px-3 text-[13px] font-medium text-red-600 transition-colors hover:bg-red-500/10 dark:text-red-400"
                  >
                    Reset key
                  </button>
                </div>
              )}

              {(reset === "confirm" || reset === "working") && (
                <div role="group" aria-labelledby="reset-title">
                  <p id="reset-title" className="text-[14px] font-medium">
                    Make a new key?
                  </p>
                  <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
                    The current key stops working straight away. Your iPhone Shortcut and browser extension
                    stop saving until you paste the new key into them. We&apos;ll show you how.
                  </p>
                  <div className="mt-3 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setReset("idle")}
                      disabled={reset === "working"}
                      className="h-9 cursor-pointer rounded-lg px-3 text-[13px] font-medium text-ink-muted hover:text-ink disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={reset === "working"}
                      onClick={async () => {
                        setReset("working");
                        setReset((await onReset()) ? "done" : "confirm");
                      }}
                      className="h-9 cursor-pointer rounded-lg bg-red-600 px-3 text-[13px] font-medium text-white disabled:cursor-wait disabled:opacity-60"
                    >
                      {reset === "working" ? "Making a new key…" : "Make a new key"}
                    </button>
                  </div>
                </div>
              )}

              {reset === "done" && (
                <div role="status">
                  <p className="flex items-center gap-2 text-[14px] font-medium">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 text-white">
                      <Check size={12} weight="bold" aria-hidden="true" />
                    </span>
                    New key made. The old one no longer works.
                  </p>
                  <p className="mt-3 text-[13px] text-ink-muted">
                    Copy it, then replace the old key on each device:
                  </p>
                  <div className="mt-3">
                    <CopyButton value={deviceKey} label="Copy new key" strong />
                  </div>
                  <ul className="mt-4 space-y-3 text-[13px] leading-relaxed">
                    <li>
                      <p className={strong}>iPhone & iPad</p>
                      <p className="text-ink-muted">
                        Open the Shortcuts app, tap <span className={strong}>•••</span> on{" "}
                        <span className={strong}>Save to gitmarks</span>, and paste the new key over the old
                        one (the text starting with <span className="font-mono">gm_</span>). Tap{" "}
                        <span className={strong}>Done</span>.
                      </p>
                    </li>
                    <li>
                      <p className={strong}>Chrome, Arc, Brave, Edge</p>
                      <p className="text-ink-muted">
                        Click the gitmarks icon in the toolbar, then <span className={strong}>⚙︎</span>. Paste
                        the new key into <span className={strong}>Your key</span> and click{" "}
                        <span className={strong}>Save settings</span>.
                      </p>
                    </li>
                    <li>
                      <p className={strong}>Android, and the bookmarks bar button</p>
                      <p className="text-ink-muted">Nothing to do. They don&apos;t use a key.</p>
                    </li>
                  </ul>
                  <div className="mt-4 flex justify-end">
                    <button
                      type="button"
                      onClick={() => setReset("idle")}
                      className="h-9 cursor-pointer rounded-lg border border-line-strong px-3 text-[13px] font-medium hover:bg-surface-sunken"
                    >
                      All replaced
                    </button>
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* One device at a time, as numbered steps. */}
          <section aria-labelledby="devices-title" className="mt-7">
            <h3 id="devices-title" className={label}>
              Set up a device
            </h3>
            <div className="mt-3 grid grid-cols-4 gap-1 rounded-xl bg-surface-sunken p-1">
              {DEVICES.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  aria-pressed={device === d.id}
                  onClick={() => setDevice(d.id)}
                  className={`h-8 cursor-pointer rounded-lg text-[13px] font-medium transition-colors ${
                    device === d.id ? "bg-surface-raised text-ink shadow-sm" : "text-ink-muted hover:text-ink"
                  }`}
                >
                  {d.tab}
                </button>
              ))}
            </div>

            <div className="mt-5 px-1">
              <p className="mb-4 text-[15px] font-medium">{name}</p>
              {device === "ios" && (
                <Steps>
                  <Step n={1}>
                    Open the Shortcut link in Safari.
                    <br />
                    <GetLink href={SHORTCUT_LINK}>Get the Shortcut</GetLink>
                  </Step>
                  <Step n={2}>
                    Paste your key when it asks, then tap <span className={strong}>Add Shortcut</span>.
                  </Step>
                  <Step n={3}>
                    In any app, tap <span className={strong}>Share</span>, then{" "}
                    <span className={strong}>Save to gitmarks</span>.
                  </Step>
                </Steps>
              )}
              {device === "android" && (
                <Steps>
                  <Step n={1}>Open this page in Chrome on your phone.</Step>
                  <Step n={2}>
                    Tap the <span className={strong}>⋮</span> menu, then{" "}
                    <span className={strong}>Add to Home screen</span> →{" "}
                    <span className={strong}>Install</span>.
                  </Step>
                  <Step n={3}>
                    In any app, tap <span className={strong}>Share</span>, then{" "}
                    <span className={strong}>gitmarks</span>. No key needed.
                  </Step>
                </Steps>
              )}
              {device === "chrome" && (
                <Steps>
                  <Step n={1}>
                    Add the extension, then pin it to the toolbar.
                    <br />
                    <GetLink href={EXTENSION_LINK}>Get the extension</GetLink>
                  </Step>
                  <Step n={2}>
                    Click its icon, paste your key, and click <span className={strong}>Save settings</span>.
                  </Step>
                  <Step n={3}>
                    Save with the toolbar button, a right-click, or the button on every post on X.
                  </Step>
                </Steps>
              )}
              {device === "other" && (
                <Steps>
                  <Step n={1}>
                    Drag this button onto your bookmarks bar.
                    <br />
                    <a
                      href="#save-to-gitmarks"
                      // React refuses `javascript:` URLs in JSX, so the real address is set directly.
                      ref={(el) => {
                        if (el && origin) el.setAttribute("href", bookmarklet(origin));
                      }}
                      onClick={(e) => {
                        e.preventDefault();
                        setHint(true);
                      }}
                      draggable
                      className="mt-2 inline-flex h-9 cursor-grab items-center gap-2 rounded-lg bg-ink px-3.5 text-[13px] font-medium text-surface"
                    >
                      <LinkSimple size={14} aria-hidden="true" /> Save to gitmarks
                    </a>
                    {hint && (
                      <span role="status" className="mt-2 block text-[13px] text-ink-muted">
                        Drag it, don&apos;t click it: drop it onto your bookmarks bar.
                      </span>
                    )}
                  </Step>
                  <Step n={2}>Click it on any page to save that page. No key needed.</Step>
                </Steps>
              )}
            </div>
          </section>
        </div>
      </dialog>
    </>
  );
}
