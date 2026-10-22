import { useState } from "react";
import { Eye, EyeSlash } from "@phosphor-icons/react";

export default function Login() {
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret }),
    });
    const data = await res.json().catch(() => ({ ok: false, error: "Unexpected response." }));
    setBusy(false);
    if (data.ok) window.location.reload();
    else setError(data.error ?? "That is not the secret.");
  }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-[340px]">
        <h1 className="font-display text-3xl font-semibold tracking-[-0.03em]">gitmarks</h1>
        <p className="mt-1.5 text-[14px] text-ink-muted">Paste your GITMARKS_SECRET to sign in.</p>
        <div className="relative mt-5">
          <input
            type={revealed ? "text" : "password"}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            // eslint-disable-next-line jsx-a11y/no-autofocus -- the page's only control
            autoFocus
            autoComplete="current-password"
            aria-label="Secret"
            aria-invalid={Boolean(error)}
            className="h-11 w-full rounded-xl border border-line bg-surface-raised pl-3 pr-11 text-ink transition-colors focus:border-line-strong"
          />
          <button
            type="button"
            onClick={() => setRevealed((v) => !v)}
            aria-label={revealed ? "Hide secret" : "Show secret"}
            aria-pressed={revealed}
            className="absolute right-1 top-1/2 flex h-9 w-9 -translate-y-1/2 cursor-pointer items-center justify-center rounded-lg text-ink-muted hover:text-ink"
          >
            {revealed ? <EyeSlash size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
          </button>
        </div>
        <button
          type="submit"
          disabled={busy || !secret}
          className="mt-3 h-11 w-full cursor-pointer rounded-xl bg-ink text-[14px] font-medium text-surface transition-opacity disabled:cursor-default disabled:opacity-30"
        >
          {busy ? "Checking…" : "Open"}
        </button>
        {error && (
          <p role="alert" className="mt-3 text-[13px] text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        <p className="mt-6 text-[12px] text-ink-muted">You stay signed in for 30 days on this device.</p>
      </form>
    </div>
  );
}
