import { env } from "./env";

/**
 * Bookmarks are one JSON file committed to a GitHub repo. Self-hosted, that is
 * by default the very repo this app is deployed from, which Vercel tells us
 * about at runtime; `vercel.json` skips the rebuild when a commit only touches
 * `data/`, so saving a link never redeploys anything. Hosted, it is the one
 * repo each person gave the GitHub App, reached with a token minted per request.
 */
export const api = () => env("GITHUB_API_URL") ?? "https://api.github.com";

/** A repo and a token that can write to it. No branch means the repo's default branch. */
export type Repo = { token: string; repo: string; branch?: string };

/** The self-hosted repo, from the environment. */
export function githubConfig(): Repo | null {
  const token = env("GITHUB_TOKEN");
  const owner = env("VERCEL_GIT_REPO_OWNER");
  const slug = env("VERCEL_GIT_REPO_SLUG");
  const repo = env("GITMARKS_REPO") ?? (owner && slug ? `${owner}/${slug}` : undefined);
  const branch = env("GITMARKS_BRANCH") ?? env("VERCEL_GIT_COMMIT_REF") ?? "main";
  return token && repo ? { token, repo, branch } : null;
}

export const headers = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "content-type": "application/json",
});

/** What went wrong, in words that say what to do. Never the response body: it can repeat the request. */
function refused(action: string, status: number, c: Repo): string {
  if (status === 401) return `GitHub ${action} failed (401): the token has expired or been revoked.`;
  if (status === 403 || status === 404) {
    return `GitHub ${action} failed (${status}): gitmarks needs Contents: read and write on ${c.repo}.`;
  }
  return `GitHub ${action} failed (${status}).`;
}

// ponytail: one entry per repo for the life of the instance; an LRU if a
// hosted instance ever holds enough repos for that to matter.
const visibility = new Map<string, { isPublic: boolean; at: number }>();

/**
 * Whether the repo holding the bookmarks is public — the easiest way to leak
 * them is a repo made without ticking "private". Cached for ten minutes, so it
 * costs one GitHub call per instance, not one per request.
 */
export async function isRepoPublic(c: Repo): Promise<boolean> {
  const cached = visibility.get(c.repo);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.isPublic;
  const res = await fetch(`${api()}/repos/${c.repo}`, { headers: headers(c.token) });
  if (!res.ok) throw new Error(refused("lookup", res.status, c));
  const isPublic = ((await res.json()) as { private?: boolean }).private === false;
  visibility.set(c.repo, { isPublic, at: Date.now() });
  return isPublic;
}

/** Text and blob sha, or null if the file does not exist. Any other failure throws. */
export async function readFile(c: Repo, path: string): Promise<{ text: string; sha: string } | null> {
  const ref = c.branch ? `?ref=${encodeURIComponent(c.branch)}` : "";
  const res = await fetch(`${api()}/repos/${c.repo}/contents/${path}${ref}`, { headers: headers(c.token) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(refused("read", res.status, c));
  const file = (await res.json()) as { content?: string; sha: string };
  let content = file.content;
  // The contents API leaves `content` empty past 1MB; the blob API goes to 100MB.
  if (!content) {
    const blob = await fetch(`${api()}/repos/${c.repo}/git/blobs/${file.sha}`, { headers: headers(c.token) });
    if (!blob.ok) throw new Error(refused("read", blob.status, c));
    content = ((await blob.json()) as { content: string }).content;
  }
  return { text: Buffer.from(content, "base64").toString("utf8"), sha: file.sha };
}

export type WriteResult = { ok: true } | { ok: false; error: string; conflict?: boolean };

/**
 * Write with the sha that was read. If the file changed in between, GitHub
 * refuses and the caller re-reads instead of overwriting someone's save.
 * In an empty repo, the first write is the repo's first commit.
 */
export async function writeFile(
  c: Repo,
  path: string,
  text: string,
  sha: string | null,
  message: string,
): Promise<WriteResult> {
  const res = await fetch(`${api()}/repos/${c.repo}/contents/${path}`, {
    method: "PUT",
    headers: headers(c.token),
    body: JSON.stringify({
      message,
      content: Buffer.from(text, "utf8").toString("base64"),
      ...(c.branch ? { branch: c.branch } : {}),
      ...(sha ? { sha } : {}),
    }),
  });
  if (res.ok) return { ok: true };
  return {
    ok: false,
    error: refused("write", res.status, c),
    conflict: res.status === 409 || res.status === 422,
  };
}
