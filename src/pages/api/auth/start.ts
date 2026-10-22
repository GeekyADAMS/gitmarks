import type { APIRoute } from "astro";
import { randomBytes } from "node:crypto";
import { seal, sessionCookie } from "@/lib/auth";
import { STATE_COOKIE, app, authorizeUrl, safePath } from "@/lib/hosted";

/**
 * Sign in with GitHub. Also the GitHub App's setup URL, so installing the app
 * lands here and carries straight on into signing in.
 *
 * The state sent to GitHub is a random nonce; the cookie holds the same nonce,
 * signed, with where to go afterwards. The callback needs both to match, so a
 * sign-in started in someone else's browser cannot be finished in yours.
 */
export const GET: APIRoute = ({ url, cookies, redirect }) => {
  const a = app();
  if (!a) return new Response("Not found", { status: 404 });
  const nonce = randomBytes(16).toString("base64url");
  const state = seal("state", {
    n: nonce,
    to: safePath(url.searchParams.get("to")),
    exp: Date.now() + 600_000,
  });
  if (!state) return new Response("GITMARKS_SECRET is not set.", { status: 500 });
  cookies.set(STATE_COOKIE, state, sessionCookie(url.protocol === "https:", 600));
  return redirect(authorizeUrl(a, nonce), 302);
};
