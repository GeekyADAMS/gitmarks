import type { APIRoute } from "astro";
import {
  SESSION_COOKIE,
  checkPassword,
  createSession,
  isThrottled,
  recordFailure,
  sessionCookie,
} from "@/lib/auth";

export const POST: APIRoute = async ({ request, cookies, clientAddress, url }) => {
  const key = clientAddress ?? "unknown";
  if (isThrottled(key)) {
    return Response.json({ ok: false, error: "Too many attempts. Try again later." }, { status: 429 });
  }
  const body = (await request.json().catch(() => null)) as { secret?: unknown } | null;
  const attempt = typeof body?.secret === "string" ? body.secret : "";
  if (!checkPassword(attempt)) {
    recordFailure(key);
    return Response.json({ ok: false, error: "That is not the secret." }, { status: 401 });
  }
  const token = createSession();
  if (!token) return Response.json({ ok: false, error: "Not configured." }, { status: 500 });
  cookies.set(SESSION_COOKIE, token, sessionCookie(url.protocol === "https:"));
  return Response.json({ ok: true });
};
