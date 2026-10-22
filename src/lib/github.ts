import { env } from "./env";

/**
 * Bookmarks are one JSON file committed to a GitHub repo — by default the very
 * repo this app is deployed from, which Vercel tells us about at runtime.
 * `vercel.json` skips the rebuild when a commit only touches `data/`, so saving
 * a link never redeploys anything.
 */
const API = "https://api.github.com";

export function githubConfig() {
  const token = env("GITHUB_TOKEN");
  const owner = env("VERCEL_GIT_REPO_OWNER");
  const slug = env("VERCEL_GIT_REPO_SLUG");
  const repo = env("GITMARKS_REPO") ?? (owner && slug ? `${owner}/${slug}` : undefined);
  const branch = env("GITMARKS_BRANCH") ?? env("VERCEL_GIT_COMMIT_REF") ?? "main";
  return token && repo ? { token, repo, branch } : null;
}

type Config = NonNullable<ReturnType<typeof githubConfig>>;

let visibility: { repo: string; isPublic: boolean; at: number } | undefined;

/**
 * Whether the repo holding the bookmarks is public — the easiest way to leak
 * them is a template copied without ticking "private". Cached for ten minutes
 * so it costs one GitHub call per instance, not one per request.
 */
export async function isRepoPublic(c: Config): Promise<boolean> {
  if (visibility?.repo === c.repo && Date.now() - visibility.at < 10 * 60 * 1000) return visibility.isPublic;
  const res = await fetch(`${API}/repos/${c.repo}`, { headers: headers(c.token) });
  if (!res.ok)
    throw new Error(`GitHub could not find ${c.repo} (${res.status}). Check GITHUB_TOKEN can read it.`);
  const isPublic = ((await res.json()) as { private?: boolean }).private === false;
  visibility = { repo: c.repo, isPublic, at: Date.now() };
  return isPublic;
}

const headers = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "content-type": "application/json",
});

/** Text and blob sha, or null if the file does not exist. Any other failure throws. */
export async function readFile(c: Config, path: string): Promise<{ text: string; sha: string } | null> {
  const res = await fetch(`${API}/repos/${c.repo}/contents/${path}?ref=${encodeURIComponent(c.branch)}`, {
    headers: headers(c.token),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub read failed (${res.status}). Check GITHUB_TOKEN can read ${c.repo}.`);
  const file = (await res.json()) as { content?: string; sha: string };
  let content = file.content;
  // The contents API leaves `content` empty past 1MB; the blob API goes to 100MB.
  if (!content) {
    const blob = await fetch(`${API}/repos/${c.repo}/git/blobs/${file.sha}`, { headers: headers(c.token) });
    if (!blob.ok) throw new Error(`GitHub read failed (${blob.status})`);
    content = ((await blob.json()) as { content: string }).content;
  }
  return { text: Buffer.from(content, "base64").toString("utf8"), sha: file.sha };
}

export type WriteResult = { ok: true } | { ok: false; error: string; conflict?: boolean };

/**
 * Write with the sha that was read. If the file changed in between, GitHub
 * refuses and the caller re-reads instead of overwriting someone's save.
 */
export async function writeFile(
  c: Config,
  path: string,
  text: string,
  sha: string | null,
  message: string,
): Promise<WriteResult> {
  const res = await fetch(`${API}/repos/${c.repo}/contents/${path}`, {
    method: "PUT",
    headers: headers(c.token),
    body: JSON.stringify({
      message,
      content: Buffer.from(text, "utf8").toString("base64"),
      branch: c.branch,
      ...(sha ? { sha } : {}),
    }),
  });
  if (res.ok) return { ok: true };
  // Never echo the response body: it can repeat the request.
  return {
    ok: false,
    error:
      res.status === 403 || res.status === 404
        ? `GitHub refused the write (${res.status}). The token needs Contents: read and write on ${c.repo}.`
        : `GitHub write failed (${res.status})`,
    conflict: res.status === 409 || res.status === 422,
  };
}
