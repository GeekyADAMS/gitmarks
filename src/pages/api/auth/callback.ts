import type { APIRoute } from "astro";
import { SESSION_COOKIE, createSession, same, sessionCookie, unseal } from "@/lib/auth";
import { STATE_COOKIE, app, safePath, signIn } from "@/lib/hosted";

/** Where GitHub sends people back after they approve gitmarks. */
export const GET: APIRoute = async ({ url, cookies, redirect }) => {
  const a = app();
  if (!a) return new Response("Not found", { status: 404 });
  const state = unseal<{ n: string; to: string }>("state", cookies.get(STATE_COOKIE)?.value);
  cookies.delete(STATE_COOKIE, { path: "/" });
  const code = url.searchParams.get("code");
  if (!state || !same(state.n, url.searchParams.get("state") ?? "")) return redirect("/?error=state", 302);
  if (!code) return redirect("/?error=denied", 302);

  const result = await signIn(a, code).catch(() => null);
  if (!result) return redirect("/?error=github", 302);
  if (!result.ok) {
    const params = new URLSearchParams({ error: result.reason });
    if (result.installation) params.set("installation", String(result.installation));
    if (result.repo) params.set("repo", result.repo);
    return redirect(`/?${params}`, 302);
  }
  cookies.set(SESSION_COOKIE, createSession(result.claims)!, sessionCookie(url.protocol === "https:"));
  return redirect(safePath(state.to), 302);
};
