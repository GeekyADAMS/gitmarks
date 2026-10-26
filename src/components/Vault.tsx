import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  ArrowUpRight,
  Check,
  Copy,
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
  XLogo,
} from "@phosphor-icons/react";
import {
  MAX_BATCH,
  applyAction,
  extractUrls,
  matches,
  placeholderMark,
  splitMatches,
  type Mark,
  type Vault as VaultData,
  type VaultAction,
  type VaultRequest,
} from "@/lib/vault";

/** `all` and `inbox` are views; any other string is a category. */
type View = { kind: "all" } | { kind: "inbox" } | { kind: "category"; name: string };
type Toast = { id: number; message: string; undo?: () => void; error?: boolean };

const DRAG_TYPE = "application/x-vault-mark";
let toastId = 0;

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
  const [query, setQuery] = useState("");
  const [toast, setToast] = useState<Toast | null>(
    loadError ? { id: 0, message: loadError, error: true } : null,
  );
  const [dropping, setDropping] = useState(false);

  const queue = useRef(Promise.resolve());
  const nextKey = useRef(0);
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
    });
  }

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

  const update = (mark: Mark, patch: { note?: string }) =>
    send({ type: "update", id: mark.id, patch }, [{ type: "update", id: mark.id, patch }]);

  const categoryAction = (action: Exclude<VaultAction, { type: "put" | "update" | "delete" }>) =>
    send(action, [action]);

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

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of vault.marks) map.set(m.category, (map.get(m.category) ?? 0) + 1);
    return map;
  }, [vault.marks]);

  const shown = vault.marks.filter(
    (m) =>
      (view.kind === "all" || (view.kind === "inbox" ? m.category === "" : m.category === view.name)) &&
      matches(m, query),
  );

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
              <p className="mt-2 font-mono text-xs tabular-nums text-ink-muted">
                {shown.length} {shown.length === 1 ? "link" : "links"}
                {query && ` matching “${query}”`}
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
              <ConnectButton deviceKey={deviceKey} hosted={hosted} />
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
            <Empty view={activeView} searching={Boolean(query)} hasAny={vault.marks.length > 0} />
          ) : (
            <div className="mt-2 flex items-start gap-4">
              {columns.map((column, i) => (
                <div key={i} className="flex min-w-0 flex-1 flex-col gap-4">
                  {column.map((mark) => (
                    <Card
                      key={mark.id}
                      mark={mark}
                      categories={vault.categories}
                      showCategory={activeView.kind === "all"}
                      query={query}
                      onMove={(c) => move(mark, c)}
                      onNote={(note) => update(mark, { note })}
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
}: {
  vault: VaultData;
  counts: Map<string, number>;
  view: View;
  onView: (view: View) => void;
  onDropMark: (id: string, category: string) => void;
  onDropUrls: (urls: string[], category: string) => void;
  onCategory: (action: Exclude<VaultAction, { type: "put" | "update" | "delete" }>) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const isActive = (v: View) =>
    v.kind === view.kind && (v.kind !== "category" || (view.kind === "category" && v.name === view.name));

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
          onDropMark={(id) => onDropMark(id, "")}
          onDropUrls={(urls) => onDropUrls(urls, "")}
        />
        <li
          aria-hidden="true"
          className="hidden px-3 pb-1.5 pt-5 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-muted md:block"
        >
          Categories
        </li>
        {vault.categories.map((name) =>
          editing === name ? (
            <li key={name} className="shrink-0">
              <CategoryInput
                initial={name}
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
                  onView({ kind: "inbox" });
                }}
              />
            </li>
          ) : (
            <Row
              key={name}
              label={name}
              icon={<Dot name={name} />}
              count={counts.get(name) ?? 0}
              active={isActive({ kind: "category", name })}
              onClick={() => onView({ kind: "category", name })}
              onEdit={() => setEditing(name)}
              onDropMark={(id) => onDropMark(id, name)}
              onDropUrls={(urls) => onDropUrls(urls, name)}
            />
          ),
        )}
        <li className="shrink-0">
          {adding ? (
            <CategoryInput
              initial=""
              onDone={(value) => {
                setAdding(false);
                if (value) {
                  onCategory({ type: "addCategory", name: value });
                  onView({ kind: "category", name: value });
                }
              }}
            />
          ) : (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="flex h-9 w-full cursor-pointer items-center gap-2.5 whitespace-nowrap rounded-xl px-3 text-[14px] text-ink-muted transition-colors hover:text-ink"
            >
              <Plus size={15} aria-hidden="true" />
              New category
            </button>
          )}
        </li>
      </ul>
    </nav>
  );
}

function Row({
  label,
  icon,
  count,
  active,
  onClick,
  onEdit,
  onDropMark,
  onDropUrls,
}: {
  label: string;
  icon: React.ReactNode;
  count: number;
  active: boolean;
  onClick: () => void;
  onEdit?: () => void;
  onDropMark?: (id: string) => void;
  onDropUrls?: (urls: string[]) => void;
}) {
  const [over, setOver] = useState(false);
  const droppable = Boolean(onDropMark);
  return (
    <li
      className="group/row relative shrink-0"
      onDragOver={(e) => {
        if (!droppable) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = e.dataTransfer.types.includes(DRAG_TYPE) ? "move" : "copy";
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (!droppable) return;
        e.preventDefault();
        setOver(false);
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
          aria-label={`Rename ${label}`}
          className="absolute right-1.5 top-1/2 hidden h-6 w-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-ink-muted opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 group-hover/row:opacity-100 md:flex"
        >
          <PencilSimple size={13} aria-hidden="true" />
        </button>
      )}
    </li>
  );
}

function CategoryInput({
  initial,
  onDone,
  onRemove,
}: {
  initial: string;
  onDone: (value: string) => void;
  onRemove?: () => void;
}) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (v: string) => {
    if (done.current) return;
    done.current = true;
    onDone(v.trim());
  };
  return (
    <div className="flex h-9 items-center gap-1 rounded-xl border border-line-strong bg-surface-raised pl-3 pr-1">
      <Dot name={value || "new"} />
      <input
        // eslint-disable-next-line jsx-a11y/no-autofocus -- opened by the click that wants to type here
        autoFocus
        value={value}
        maxLength={40}
        aria-label={initial ? `Rename ${initial}` : "New category name"}
        placeholder="Name"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") finish(value);
          if (e.key === "Escape") finish(initial);
        }}
        onBlur={() => finish(value)}
        className="min-w-0 flex-1 bg-transparent pl-1.5 text-[14px] text-ink outline-none placeholder:text-ink-muted"
      />
      {onRemove && (
        <button
          type="button"
          aria-label={`Delete ${initial}. Its links move to the inbox.`}
          title="Delete category — its links move to the inbox"
          // Fires before the input's blur would close the editor.
          onMouseDown={(e) => {
            e.preventDefault();
            done.current = true;
            onRemove();
          }}
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-ink-muted transition-colors hover:text-red-600"
        >
          <Trash size={14} aria-hidden="true" />
        </button>
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

function Card({
  mark,
  categories,
  showCategory,
  query,
  onMove,
  onNote,
  onDelete,
  onCopied,
}: {
  mark: Mark;
  categories: string[];
  showCategory: boolean;
  query: string;
  onMove: (category: string) => void;
  onNote: (note: string) => void;
  onDelete: () => void;
  onCopied: () => void;
}) {
  const [brokenImage, setBrokenImage] = useState(false);
  const [editingNote, setEditingNote] = useState(false);
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
      className="vault-card group relative overflow-hidden rounded-2xl border border-line bg-surface-raised transition-[border-color,box-shadow,transform] hover:-translate-y-0.5 hover:border-line-strong hover:shadow-[0_18px_40px_-24px_rgba(0,0,0,0.35)]"
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
            categories={categories}
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
  categories,
  onMove,
  quiet = false,
}: {
  current: string;
  categories: string[];
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
        {categories.map((c) => (
          <option key={c} value={c}>
            {c}
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
export const EXTENSION_LINK = "https://chromewebstore.google.com/detail/gitmarks/alnhmhklodcajljkfbonfhkbeaedkalf";

/**
 * A bookmark whose address is a script: on any page, it opens this site's
 * share page with that page's link. Nothing to install, so it covers Safari,
 * Firefox and every browser the extension doesn't.
 */
const bookmarklet = (origin: string) =>
  `javascript:void window.open(${JSON.stringify(`${origin}/share?popup=1&url=`)}+encodeURIComponent(location.href)+"&title="+encodeURIComponent(document.title),"gitmarks","popup,width=440,height=680")`;

function CopyRow({ label, value, shown }: { label: string; value: string; shown: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      }}
      className="flex w-full cursor-pointer items-center gap-3 rounded-xl border border-line-strong bg-surface-raised px-4 py-3 text-left"
    >
      <span className="w-16 shrink-0 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-muted">
        {label}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{shown}</span>
      <span className="shrink-0 text-[13px] text-ink-muted">{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

/** How to save from everywhere else, with the address and key ready to copy. */
function ConnectButton({ deviceKey, hosted }: { deviceKey: string; hosted: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [hint, setHint] = useState(false);
  const origin = useSyncExternalStore(
    () => () => {},
    () => window.location.origin,
    () => "",
  );
  const step = "rounded-2xl border border-line bg-surface-raised p-4";
  const link = "text-ink underline underline-offset-2";
  return (
    <>
      <button
        type="button"
        onClick={() => dialog.current?.showModal()}
        className="flex h-10 cursor-pointer items-center gap-2 rounded-xl border border-line bg-surface-raised px-3 text-[14px] text-ink-muted transition-colors hover:text-ink"
      >
        <DeviceMobile size={16} aria-hidden="true" />
        <span className="hidden sm:inline">Connect</span>
      </button>
      {/* A click on the backdrop closes it. Keyboard users have Escape (native to
          <dialog>) and the Done button, so no key handler is missing. */}
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions */}
      <dialog
        ref={dialog}
        aria-labelledby="connect-title"
        onClick={(e) => e.target === e.currentTarget && e.currentTarget.close()}
        className="m-auto max-h-[calc(100dvh-2rem)] w-[min(560px,calc(100vw-2rem))] rounded-3xl border border-line bg-surface p-0 text-ink backdrop:bg-black/40 backdrop:backdrop-blur-sm"
      >
        <div className="space-y-3 p-6">
          <h2 id="connect-title" className="font-display text-2xl font-semibold tracking-[-0.02em]">
            Save from everywhere
          </h2>
          <p className="text-[14px] text-ink-muted">
            {hosted
              ? "Each device asks for your key once. Keep it private: it can save to your gitmarks."
              : "Each device asks for this address and your key once. Keep the key private: it can save to your gitmarks."}
          </p>
          <div className="space-y-2">
            <CopyRow label="Address" value={origin} shown={origin} />
            <CopyRow
              label="Key"
              value={deviceKey}
              shown={`${deviceKey.slice(0, 6)}••••••••${deviceKey.slice(-4)}`}
            />
          </div>
          <div className={step}>
            <p className="font-medium">iPhone & iPad</p>
            <p className="mt-1 text-[14px] text-ink-muted">
              Add the Shortcut and paste your key when it asks. Then Share → Save to gitmarks from any app.{" "}
              <a className={link} href={SHORTCUT_LINK} target="_blank" rel="noopener noreferrer">
                Get the Shortcut
              </a>
            </p>
          </div>
          <div className={step}>
            <p className="font-medium">Android</p>
            <p className="mt-1 text-[14px] text-ink-muted">
              Open this page in Chrome, then menu → Add to Home screen → Install. gitmarks then appears in
              every app&apos;s Share menu. No key needed.
            </p>
          </div>
          <div className={step}>
            <p className="font-medium">Chrome, Arc, Brave, Edge</p>
            <p className="mt-1 text-[14px] text-ink-muted">
              A toolbar button, right-click saving, and a save button on every post on X. Open it once and
              paste your key.{" "}
              <a className={link} href={EXTENSION_LINK} target="_blank" rel="noopener noreferrer">
                Get the extension
              </a>
            </p>
          </div>
          <div className={step}>
            <p className="font-medium">Safari, Firefox, any browser</p>
            <p className="mt-1 text-[14px] text-ink-muted">
              Drag this button to your bookmarks bar. Click it on any page to save that page.
            </p>
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
              className="mt-3 inline-flex h-9 cursor-grab items-center gap-2 rounded-xl bg-ink px-3.5 text-[13px] font-medium text-surface"
            >
              <LinkSimple size={14} aria-hidden="true" /> Save to gitmarks
            </a>
            {hint && (
              <p role="status" className="mt-2 text-[13px] text-ink-muted">
                Drag it, don&apos;t click it: drop it onto your bookmarks bar.
              </p>
            )}
          </div>
          <form method="dialog" className="pt-1 text-right">
            <button className="cursor-pointer rounded-xl bg-ink px-4 py-2 text-[14px] font-medium text-surface">
              Done
            </button>
          </form>
        </div>
      </dialog>
    </>
  );
}
