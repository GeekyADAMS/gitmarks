import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { env } from "./env";

/**
 * `GITMARKS_SECRET` signs everything this server hands out: session cookies,
 * device keys and sign-in state. Self-hosted, it is also the password typed on
 * the page — one thing to generate and paste is the difference between a
 * template people finish setting up and one they don't.
 *
 * That only holds up if the secret is long and random, so a short one is
 * refused outright rather than accepted with a warning.
 */
export const SESSION_COOKIE = "gitmarks_session";
export const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
export const MIN_SECRET_LENGTH = 24;

export function secret(): string | undefined {
  const value = env("GITMARKS_SECRET");
  return value && value.length >= MIN_SECRET_LENGTH ? value : undefined;
}

/** Constant-time, and length-blind: both sides are hashed to 32 bytes first. */
export function same(a: string, b: string): boolean {
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * Who a session or device key belongs to. Self-hosted there is one owner, so
 * it is empty. Hosted, it names the GitHub App installation, the one repo the
 * bookmarks live in, and the GitHub user who signed in. A device key also
 * carries `k`, the vault's key version when it was made.
 */
export type Claims = { i?: number; r?: string; u?: number; k?: string };

/**
 * `body.signature`, where the body is base64url JSON. The purpose is part of
 * what is signed, so a token minted for one job is worthless for another.
 */
export function seal(purpose: string, claims: object): string | null {
  const key = secret();
  if (!key) return null;
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${body}.${mac(purpose, body, key)}`;
}

/** The claims, if the token is genuine, for this purpose, and unexpired. */
export function unseal<T extends object>(purpose: string, token: string | undefined, now = Date.now()) {
  const key = secret();
  const dot = token?.lastIndexOf(".") ?? -1;
  if (!key || !token || dot < 1) return null;
  const body = token.slice(0, dot);
  if (!same(mac(purpose, body, key), token.slice(dot + 1))) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & { exp?: number };
    return typeof claims.exp === "number" && claims.exp <= now ? null : claims;
  } catch {
    return null;
  }
}

const mac = (purpose: string, body: string, key: string) =>
  createHmac("sha256", key).update(`${purpose}:${body}`).digest("base64url");

/** A session carries its own expiry, signed so it can be neither forged nor extended. */
export function createSession(claims: Claims = {}, now = Date.now()): string | null {
  return seal("session", { ...claims, exp: now + SESSION_MS });
}

export function readSession(token: string | undefined, now = Date.now()): Claims | null {
  return unseal<Claims>("session", token, now);
}

/**
 * What the extension and the phone Shortcut send as their bearer token. It
 * never expires, because a Shortcut that silently stops working is worse.
 * Instead it carries the vault's key version, and Reset key in Connect changes
 * that version, which turns every older key away. Until the first reset there
 * is no version, so keys made before resets existed are still the current one.
 */
export function deviceKey(claims: Claims): string | null {
  const { i, r, u, k } = claims;
  const sealed = seal("device", { i, r, u, ...(k ? { k } : {}) });
  return sealed && `gm_${sealed}`;
}

export function readDeviceKey(header: string | null): Claims | null {
  const key = header?.match(/^Bearer gm_(\S+)$/)?.[1];
  return key ? unseal<Claims>("device", key) : null;
}

/** Self-hosted only: the secret typed on the page. */
export function checkPassword(attempt: string): boolean {
  const key = secret();
  return Boolean(key) && same(attempt.trim(), key!);
}

/** Self-hosted only: devices set up before device keys existed send the secret itself. */
export function checkBearer(header: string | null): boolean {
  const key = secret();
  return Boolean(key && header) && same(header!, `Bearer ${key}`);
}

/** `secure` follows the request, so the cookie works on http://localhost and is HTTPS-only everywhere else. */
export function sessionCookie(secure: boolean, maxAge = SESSION_MS / 1000) {
  return {
    httpOnly: true,
    // `lax`, so opening your vault from a link in another app arrives signed in,
    // and so the sign-in cookie survives the redirect back from GitHub.
    // Writes are same-site fetches, which `lax` still protects.
    sameSite: "lax" as const,
    secure,
    path: "/",
    maxAge,
  };
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
