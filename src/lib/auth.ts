import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { env } from "./env";

/**
 * One secret, `GITMARKS_SECRET`, does three jobs: it is the password typed on
 * the page, the bearer token the extension and the phone Shortcut send, and
 * the key that signs session cookies. One thing to generate and paste is the
 * difference between a template people finish setting up and one they don't.
 *
 * That only holds up if the secret is long and random, so a short one is
 * refused outright rather than accepted with a warning.
 */
export const SESSION_COOKIE = "gitmarks_session";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
export const MIN_SECRET_LENGTH = 24;

export function secret(): string | undefined {
  const value = env("GITMARKS_SECRET");
  return value && value.length >= MIN_SECRET_LENGTH ? value : undefined;
}

/** Constant-time, and length-blind: both sides are hashed to 32 bytes first. */
function same(a: string, b: string): boolean {
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

export function checkPassword(attempt: string): boolean {
  const key = secret();
  return Boolean(key) && same(attempt.trim(), key!);
}

export function checkBearer(header: string | null): boolean {
  const key = secret();
  return Boolean(key && header) && same(header!, `Bearer ${key}`);
}

const sign = (value: string, key: string) =>
  createHmac("sha256", key).update(`session:${value}`).digest("hex");

/** A token carrying its own expiry, signed so it can be neither forged nor extended. */
export function createSession(now = Date.now()): string | null {
  const key = secret();
  if (!key) return null;
  const expires = String(now + SESSION_MS);
  return `${expires}.${sign(expires, key)}`;
}

export function checkSession(token: string | undefined, now = Date.now()): boolean {
  const key = secret();
  if (!key || !token) return false;
  const [expires, signature] = token.split(".");
  if (!expires || !signature) return false;
  return same(sign(expires, key), signature) && Number(expires) > now;
}

/** `secure` follows the request, so the cookie works on http://localhost and is HTTPS-only everywhere else. */
export function sessionCookie(secure: boolean) {
  return {
    httpOnly: true,
    // `lax`, so opening your vault from a link in another app arrives signed in.
    // Writes are same-site fetches, which `lax` still protects.
    sameSite: "lax" as const,
    secure,
    path: "/",
    maxAge: SESSION_MS / 1000,
  };
}

/** The page's cookie, or the bearer token from the extension or Shortcut. */
export function isOwner(request: Request, cookie: string | undefined): boolean {
  return checkSession(cookie) || checkBearer(request.headers.get("authorization"));
}

// ponytail: per-process throttle. On serverless each instance counts on its
// own, which is fine only because the secret is too long to guess anyway.
const failures = new Map<string, { count: number; until: number }>();

export function isThrottled(key: string, now = Date.now()): boolean {
  const entry = failures.get(key);
  if (!entry || now > entry.until) return false;
  return entry.count >= 10;
}

export function recordFailure(key: string, now = Date.now()): void {
  const entry = failures.get(key);
  const count = entry && now <= entry.until ? entry.count + 1 : 1;
  failures.set(key, { count, until: now + 15 * 60 * 1000 });
}
