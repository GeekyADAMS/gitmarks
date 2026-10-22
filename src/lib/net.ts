import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * The server fetches whatever URL is saved, to build its preview. Unchecked,
 * that is a server-side request forgery: a saved `http://169.254.169.254/` or
 * `http://localhost:…` would have the server read its own network. So every
 * hop — the first request and each redirect — must resolve only to public
 * addresses before it is fetched.
 *
 * ponytail: the check and the fetch resolve DNS separately, so a hostile DNS
 * server could answer differently the second time (DNS rebinding). Closing that
 * needs a custom connect-time lookup; the API is owner-only, which bounds the
 * risk to someone who already holds the secret.
 */

const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. cloud metadata
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 3], // multicast, reserved, broadcast
];

const v4ToInt = (ip: string) => ip.split(".").reduce((n, octet) => (n << 8) + Number(octet), 0) >>> 0;

function v4Blocked(ip: string): boolean {
  const n = v4ToInt(ip);
  return V4_BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (v4ToInt(base) & mask);
  });
}

/** True for any address a preview fetch must never reach. */
export function isBlockedAddress(ip: string): boolean {
  if (isIP(ip) === 4) return v4Blocked(ip);
  if (isIP(ip) !== 6) return true;
  const v6 = ip.toLowerCase();
  // IPv4-mapped (::ffff:a.b.c.d) is judged as the IPv4 address it carries.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return v4Blocked(mapped[1]);
  return (
    v6 === "::" ||
    v6 === "::1" ||
    /^f[cd]/.test(v6) || // unique local fc00::/7
    /^fe[89ab]/.test(v6) || // link-local fe80::/10
    /^ff/.test(v6) || // multicast
    v6.startsWith("64:ff9b:") || // NAT64, which can reach IPv4 internals
    v6.startsWith("2001:db8:") // documentation
  );
}

async function assertPublic(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http(s) is fetched.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((a) => isBlockedAddress(a.address))) {
    throw new Error(`Refusing to fetch ${url.hostname}: not a public address.`);
  }
}

/**
 * `fetch`, but only to public addresses, following at most five redirects by
 * hand so that each hop is checked too. Throws on anything else.
 */
export async function safeFetch(input: string, init: RequestInit = {}): Promise<Response> {
  let url = new URL(input);
  for (let hop = 0; hop <= 5; hop++) {
    await assertPublic(url);
    const res = await fetch(url, { ...init, redirect: "manual" });
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location) return res;
    void res.body?.cancel();
    url = new URL(location, url);
  }
  throw new Error("Too many redirects.");
}
