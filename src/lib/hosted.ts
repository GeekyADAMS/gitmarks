import { sign } from "node:crypto";
import { env } from "./env";
import { api, headers } from "./github";
import type { Claims } from "./auth";

/**
 * Hosted mode: one deployment serves everyone, through a GitHub App.
 *
 * Nothing about anyone is stored here. A person installs the app on one
 * private repo and signs in with GitHub; the server checks which installation
 * and repo belong to them and puts exactly that in a signed cookie. On each
 * request it mints a short-lived installation token, narrowed to that one repo
 * and to Contents, and reads or writes the bookmarks file with it.
 *
 * Self-hosting stays the default for anyone who sets none of these.
 */
export function app() {
  const clientId = env("GITHUB_APP_CLIENT_ID");
  const clientSecret = env("GITHUB_APP_CLIENT_SECRET");
  // Pasted into a dashboard as one line, a PEM's newlines arrive as "\n".
  const privateKey = env("GITHUB_APP_PRIVATE_KEY")?.replace(/\\n/g, "\n");
  const slug = env("GITHUB_APP_SLUG");
  return clientId && clientSecret && privateKey && slug ? { clientId, clientSecret, privateKey, slug } : null;
}

export type App = NonNullable<ReturnType<typeof app>>;

export const isHosted = () => app() !== null;

export const STATE_COOKIE = "gitmarks_state";

/** Only a path on this site, so a sign-in can never bounce someone elsewhere. */
export const safePath = (to: string | null | undefined) => (to && /^\/(?![/\\])/.test(to) ? to : "/");

const web = () => env("GITHUB_WEB_URL") ?? "https://github.com";

export const authorizeUrl = (a: App, state: string) =>
  `${web()}/login/oauth/authorize?client_id=${encodeURIComponent(a.clientId)}&state=${encodeURIComponent(state)}`;

export const installUrl = (a: App) => `${web()}/apps/${a.slug}/installations/new`;

/** A ten-minute JWT that proves this server is the app. Exported for tests. */
export function appJwt(a: App, now = Date.now()): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const t = Math.floor(now / 1000);
  // Backdated a minute against clock drift, as GitHub recommends.
  const data = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat: t - 60, exp: t + 540, iss: a.clientId })}`;
  return `${data}.${sign("sha256", Buffer.from(data), a.privateKey).toString("base64url")}`;
}

// ponytail: per-instance cache, one entry per installation and repo. An LRU
// if a single instance ever holds enough people for the map to matter.
const tokens = new Map<string, { token: string; until: number }>();

/**
 * A token for one repo, Contents only, valid for an hour and reused until five
 * minutes before it runs out. Null when the app was uninstalled or lost access
 * to the repo, which signs the person out.
 */
export async function installationToken(installation: number, repo: string): Promise<string | null> {
  const a = app();
  if (!a) return null;
  const key = `${installation}:${repo}`;
  const cached = tokens.get(key);
  if (cached && cached.until > Date.now()) return cached.token;
  const res = await fetch(`${api()}/app/installations/${installation}/access_tokens`, {
    method: "POST",
    headers: headers(appJwt(a)),
    body: JSON.stringify({
      repositories: [repo.split("/")[1]],
      permissions: { contents: "write", metadata: "read" },
    }),
  });
  if ([401, 403, 404, 422].includes(res.status)) {
    tokens.delete(key);
    return null;
  }
  if (!res.ok) throw new Error(`GitHub could not issue a token (${res.status}).`);
  const { token, expires_at } = (await res.json()) as { token: string; expires_at: string };
  tokens.set(key, { token, until: Date.parse(expires_at) - 5 * 60 * 1000 });
  return token;
}

export type SignIn =
  | { ok: true; claims: Required<Claims> }
  | { ok: false; reason: "denied" | "install" | "many" | "public"; installation?: number; repo?: string };

type Installation = { id: number; account?: { id?: number } };
type RepoInfo = { full_name: string; private: boolean; permissions?: { push?: boolean } };

/**
 * Turn the code GitHub sent back into who this is and which repo is theirs.
 *
 * GitHub warns that the `installation_id` it adds to the setup redirect can be
 * spoofed, so it is ignored: the installation comes from the signed-in user's
 * own token. Only an installation on their personal account counts, and only
 * a private repo they can push to — so nobody reaches a repo through gitmarks
 * that they could not already write to themselves.
 */
export async function signIn(a: App, code: string): Promise<SignIn> {
  const exchange = await fetch(`${web()}/login/oauth/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: a.clientId, client_secret: a.clientSecret, code }),
  });
  const userToken = exchange.ok
    ? ((await exchange.json()) as { access_token?: string }).access_token
    : undefined;
  if (!userToken) return { ok: false, reason: "denied" };

  try {
    const get = async <T>(path: string): Promise<T> => {
      const res = await fetch(`${api()}${path}`, { headers: headers(userToken) });
      if (!res.ok) throw new Error(`GitHub sign-in failed (${res.status}).`);
      return (await res.json()) as T;
    };
    const user = await get<{ id: number }>("/user");
    const { installations } = await get<{ installations: Installation[] }>("/user/installations");
    const mine = installations.find((i) => i.account?.id === user.id);
    if (!mine) return { ok: false, reason: "install" };

    const { repositories } = await get<{ repositories: RepoInfo[] }>(
      `/user/installations/${mine.id}/repositories?per_page=100`,
    );
    const writable = repositories.filter((r) => r.permissions?.push === true);
    if (writable.length === 0) return { ok: false, reason: "install", installation: mine.id };
    if (writable.length > 1) return { ok: false, reason: "many", installation: mine.id };
    const [repo] = writable;
    if (!repo.private) return { ok: false, reason: "public", installation: mine.id, repo: repo.full_name };
    return { ok: true, claims: { i: mine.id, r: repo.full_name, u: user.id } };
  } finally {
    // Its job is done, so it is revoked rather than left to expire.
    void fetch(`${api()}/applications/${a.clientId}/token`, {
      method: "DELETE",
      headers: {
        authorization: `Basic ${Buffer.from(`${a.clientId}:${a.clientSecret}`).toString("base64")}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ access_token: userToken }),
    }).catch(() => {});
  }
}
