import { useState } from "react";
import { Check, Tray } from "@phosphor-icons/react";

const HUES = [25, 55, 85, 145, 175, 200, 235, 265, 295, 330];
function hue(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length];
}

/**
 * What Android opens when you pick gitmarks from an app's Share menu. One tap
 * on a category saves straight away: the share sheet is a moment between two
 * other things, so there is no separate Save step to remember.
 */
export default function Share({
  url,
  title,
  categories,
  popup = false,
}: {
  url: string;
  title: string;
  categories: string[];
  /** Opened by the bookmarklet: close the window once saved. */
  popup?: boolean;
}) {
  const [state, setState] = useState<{ saving?: string; saved?: string; error?: string }>({});

  async function save(category: string) {
    setState({ saving: category });
    const res = await fetch("/api/vault", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "add", urls: [url], category }),
    }).catch(() => null);
    const data = res && res.ok ? await res.json() : null;
    if (!data?.ok) return setState({ error: data?.error ?? "Could not save. Try again." });
    setState({ saved: category || "Inbox" });
    setTimeout(() => {
      if (popup) return window.close();
      if (history.length > 1) history.back();
      else location.replace("/");
    }, 900);
  }

  if (state.saved) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 px-6 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-signal text-signal-ink">
          <Check size={26} weight="bold" aria-hidden="true" />
        </span>
        <p role="status" className="font-display text-2xl font-semibold tracking-tight">
          Saved to {state.saved}
        </p>
      </div>
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-[480px] flex-col px-5 pb-8 pt-10">
      <p className="font-mono text-xs uppercase tracking-[0.14em] text-ink-muted">Save to gitmarks</p>
      <div className="mt-4 rounded-2xl border border-line bg-surface-raised p-4">
        <p className="line-clamp-2 font-display text-lg font-semibold leading-snug">{title || url}</p>
        <p className="mt-1 truncate text-[13px] text-ink-muted">{url}</p>
      </div>
      <p className="mt-6 text-[14px] text-ink-muted">Tap a category to save:</p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {["", ...categories].map((name) => (
          <button
            key={name || "inbox"}
            type="button"
            disabled={state.saving !== undefined}
            onClick={() => save(name)}
            className="flex h-14 cursor-pointer items-center gap-2.5 rounded-2xl border border-line bg-surface-raised px-4 text-left text-[15px] font-medium transition-opacity disabled:opacity-50"
          >
            {name ? (
              <span
                aria-hidden="true"
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: `oklch(0.7 0.15 ${hue(name)})` }}
              />
            ) : (
              <Tray size={16} aria-hidden="true" />
            )}
            <span className="truncate">{state.saving === name ? "Saving…" : name || "Inbox"}</span>
          </button>
        ))}
      </div>
      {state.error && (
        <p role="alert" className="mt-4 text-[14px] text-red-600 dark:text-red-400">
          {state.error}
        </p>
      )}
    </main>
  );
}
