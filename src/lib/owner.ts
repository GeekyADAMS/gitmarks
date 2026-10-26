import { SESSION_COOKIE, checkBearer, deviceKey, readDeviceKey, readSession, type Claims } from "./auth";
import { githubConfig, type Repo } from "./github";
import { installationToken, isHosted } from "./hosted";
import type { Vault } from "./vault";

/**
 * Who is asking, and where their bookmarks live. `store` is null when they
 * live in the local file (self-hosted, no GITHUB_TOKEN). `viaKey` is true for
 * the extension and the Shortcut, whose key has to be checked against the vault.
 */
export type Owner = { claims: Claims; store: Repo | null; viaKey: boolean };

type Cookies = { get(name: string): { value: string } | undefined };

/** The page's cookie, or the bearer token from the extension or Shortcut. Null for anyone else. */
export async function owner(request: Request, cookies: Cookies): Promise<Owner | null> {
  const header = request.headers.get("authorization");
  const session = readSession(cookies.get(SESSION_COOKIE)?.value);
  const key = session ? null : readDeviceKey(header);
  const claims = session ?? key;
  const viaKey = Boolean(key);

  if (!isHosted()) {
    // A device set up before keys existed sends the secret itself, which no reset can revoke.
    if (claims) return { claims, store: githubConfig(), viaKey };
    return checkBearer(header) ? { claims: {}, store: githubConfig(), viaKey: false } : null;
  }
  if (!claims?.i || !claims.r) return null;
  const token = await installationToken(claims.i, claims.r);
  return token ? { claims, store: { token, repo: claims.r }, viaKey } : null;
}

/** False for a device key made before the last reset. Sessions are never turned away by it. */
export const keyIsCurrent = (o: Owner, vault: Vault) =>
  !o.viaKey || (o.claims.k ?? "") === (vault.keyVersion ?? "");

/** The key a signed-in owner pastes into the extension and the Shortcut. */
export const keyFor = (o: Owner, vault: Vault) => deviceKey({ ...o.claims, k: vault.keyVersion }) ?? "";
