import { SESSION_COOKIE, checkBearer, deviceKey, readDeviceKey, readSession, type Claims } from "./auth";
import { githubConfig, type Repo } from "./github";
import { installationToken, isHosted } from "./hosted";

/**
 * Who is asking, and where their bookmarks live. `store` is null when they
 * live in the local file (self-hosted, no GITHUB_TOKEN).
 */
export type Owner = { claims: Claims; store: Repo | null };

type Cookies = { get(name: string): { value: string } | undefined };

/** The page's cookie, or the bearer token from the extension or Shortcut. Null for anyone else. */
export async function owner(request: Request, cookies: Cookies): Promise<Owner | null> {
  const header = request.headers.get("authorization");
  const claims = readSession(cookies.get(SESSION_COOKIE)?.value) ?? readDeviceKey(header);

  if (!isHosted()) {
    return claims || checkBearer(header) ? { claims: {}, store: githubConfig() } : null;
  }
  if (!claims?.i || !claims.r) return null;
  const token = await installationToken(claims.i, claims.r);
  return token ? { claims, store: { token, repo: claims.r } } : null;
}

/** The key a signed-in owner pastes into the extension and the Shortcut. */
export const keyFor = (o: Owner) => deviceKey(o.claims) ?? "";
