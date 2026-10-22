import { defineMiddleware } from "astro:middleware";

/**
 * Headers on every response, and one rule for every write.
 *
 * The CSP's `script-src` allows inline scripts because Astro hydrates islands
 * with inline bootstrap code. What it does lock down is where a script could
 * send data (`connect-src 'self'`), plugins, framing, base-URI rewrites and
 * form targets. Images are open (`img-src https:`) because previews hotlink
 * from wherever the saved page keeps its card.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const HEADERS: Record<string, string> = {
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

/** The Origin a browser sent names a different host from the one it asked. */
function crossSite(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== request.headers.get("host");
  } catch {
    return true; // "null" and other opaque origins
  }
}

export const onRequest = defineMiddleware(async ({ request }, next) => {
  // A write carrying the session cookie must come from this site. SameSite=lax
  // already keeps the cookie off cross-site POSTs; this is the second lock.
  // It compares against the Host header — what the browser actually asked for —
  // because Astro's own idea of the URL can differ behind proxies and locally.
  // Bearer requests (extension, Shortcut) need no Origin: the secret is the proof.
  const write = !["GET", "HEAD", "OPTIONS"].includes(request.method);
  if (write && crossSite(request) && !request.headers.has("authorization")) {
    return new Response("Forbidden", { status: 403 });
  }

  const response = await next();
  for (const [key, value] of Object.entries(HEADERS)) response.headers.set(key, value);
  return response;
});
