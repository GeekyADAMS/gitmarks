// Boots the production build and checks it from the outside, the way a
// stranger, a browser and the phone Shortcut would see it. Needs `pnpm build`
// first. Uses no network: the one link it saves points at a blocked address,
// which also proves the preview fetcher refuses internal targets, and hosted
// mode signs in against a fake GitHub that runs in this process.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const ENTRY = resolve("dist/server/entry.mjs");
const SECRET = "smoke-test-secret-0123456789abcdef";
let failures = 0;

async function boot(port, extraEnv) {
  // A scratch working directory, so the local bookmark file never lands in the repo.
  const cwd = mkdtempSync(join(tmpdir(), "gitmarks-smoke-"));
  const child = spawn(process.execPath, [ENTRY], {
    cwd,
    env: { PATH: process.env.PATH, HOST: "127.0.0.1", PORT: String(port), ...extraEnv },
    stdio: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(base);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return { base, stop: () => (child.kill(), rmSync(cwd, { recursive: true, force: true })) };
}

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.log(`  ✗ ${name}\n    ${error.message}`);
  }
}

console.log("unconfigured");
{
  const { base, stop } = await boot(4711, { GITMARKS_SECRET: "too-short" });
  await check("a short secret shows setup with a secret made for you, not a login", async () => {
    const html = await (await fetch(base)).text();
    assert.match(html, /One setting, then you/);
    const made = /data-copy="([^"]+)"/.exec(html)?.[1] ?? "";
    assert.ok(made.length >= 40, "no generated secret");
    assert.notEqual(made, /data-copy="([^"]+)"/.exec(await (await fetch(base)).text())?.[1]);
  });
  await check("the API does not exist", async () => {
    assert.equal((await fetch(`${base}/api/vault`)).status, 404);
  });
  stop();
}

console.log("configured");
{
  const { base, stop } = await boot(4712, { GITMARKS_SECRET: SECRET });
  const bearer = { authorization: `Bearer ${SECRET}`, "content-type": "application/json" };
  let cookie = "";

  await check("security headers on every response", async () => {
    const res = await fetch(base);
    for (const header of [
      "content-security-policy",
      "x-content-type-options",
      "x-frame-options",
      "referrer-policy",
    ]) {
      assert.ok(res.headers.get(header), `missing ${header}`);
    }
    assert.match(res.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.equal(res.headers.get("cache-control"), "private, no-store");
  });

  await check("strangers get a login, and a 404 from the API", async () => {
    assert.match(await (await fetch(base)).text(), /Paste your GITMARKS_SECRET/);
    assert.equal((await fetch(`${base}/api/vault`)).status, 404);
    assert.equal(
      (await fetch(`${base}/api/vault`, { headers: { authorization: "Bearer wrong" } })).status,
      404,
    );
    const forged = `${Date.now() + 1e9}.${"0".repeat(64)}`;
    assert.equal(
      (await fetch(`${base}/api/vault`, { headers: { cookie: `gitmarks_session=${forged}` } })).status,
      404,
    );
  });

  await check("a wrong secret is refused", async () => {
    const res = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ secret: "nope" }),
    });
    assert.equal(res.status, 401);
  });

  await check("the right secret sets an HttpOnly, SameSite=Lax session", async () => {
    const res = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ secret: SECRET }),
    });
    assert.equal(res.status, 200);
    const set = res.headers.get("set-cookie") ?? "";
    assert.match(set, /HttpOnly/i);
    assert.match(set, /SameSite=Lax/i);
    cookie = set.split(";")[0];
  });

  await check("a cross-site write with the cookie is refused", async () => {
    const res = await fetch(`${base}/api/vault`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ type: "addCategory", name: "x" }),
    });
    assert.equal(res.status, 403);
  });

  await check("a same-site write with the cookie works", async () => {
    const res = await fetch(`${base}/api/vault`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: base },
      body: JSON.stringify({ type: "addCategory", name: "Reading" }),
    });
    assert.equal((await res.json()).ok, true);
  });

  await check("the Shortcut's request saves, and an internal address is never fetched", async () => {
    const res = await fetch(`${base}/api/vault`, {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ type: "add", urls: "look http://127.0.0.1:9/secret?s=1", category: "Inbox" }),
    });
    const data = await res.json();
    assert.equal(data.ok, true);
    const mark = data.vault.marks[0];
    assert.equal(mark.category, "");
    // No preview could be fetched, so the title falls back to the URL itself.
    assert.equal(mark.title, "127.0.0.1:9/secret?s=1");
    assert.equal(mark.description, "");
  });

  await check("the Shortcut's picker gets a bare list, Inbox first", async () => {
    const list = await (await fetch(`${base}/api/vault?list=categories`, { headers: bearer })).json();
    assert.deepEqual(list, ["Inbox", "Reading"]);
  });

  await check("the page hands out a device key that works, without showing the secret", async () => {
    const html = await (await fetch(base, { headers: { cookie } })).text();
    assert.ok(!html.includes(SECRET), "the secret is on the page");
    const key = /gm_[\w.-]+/.exec(html)?.[0];
    assert.ok(key, "no device key on the page");
    const res = await fetch(`${base}/api/vault?list=categories`, {
      headers: { authorization: `Bearer ${key}` },
    });
    assert.equal(res.status, 200);
    const forged = `${key.slice(0, -2)}xx`;
    assert.equal(
      (await fetch(`${base}/api/vault`, { headers: { authorization: `Bearer ${forged}` } })).status,
      404,
    );
  });

  await check("bad requests are rejected, not stored", async () => {
    for (const body of [
      { type: "add", urls: ["javascript:alert(1)"] },
      { type: "put", mark: {} },
      "not json",
    ]) {
      const res = await fetch(`${base}/api/vault`, {
        method: "POST",
        headers: bearer,
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400);
    }
  });

  await check("Android's share page offers the categories for a shared link", async () => {
    const text = encodeURIComponent("check this https://example.com/post");
    const html = await (await fetch(`${base}/share?text=${text}`, { headers: { cookie } })).text();
    assert.match(html, /Tap a category/);
    // The link is pulled out of the shared text and shown as-is, in its own line.
    const shown = /<p class="mt-1 truncate[^"]*">([^<]*)<\/p>/.exec(html)?.[1];
    assert.equal(shown, "https://example.com/post");
    assert.match(await (await fetch(`${base}/share?text=words`, { headers: { cookie } })).text(), /No link/);
  });

  await check("the share page asks strangers to sign in", async () => {
    assert.match(
      await (await fetch(`${base}/share?text=https://example.com`)).text(),
      /Paste your GITMARKS_SECRET/,
    );
  });

  stop();
}

console.log("hosted");
{
  const github = await fakeGitHub(4790);
  const { base, stop } = await boot(4713, {
    GITMARKS_SECRET: SECRET,
    GITHUB_APP_CLIENT_ID: "Iv1.smoke",
    GITHUB_APP_CLIENT_SECRET: "smoke-client-secret",
    // As a dashboard keeps it: one line, with the newlines escaped.
    GITHUB_APP_PRIVATE_KEY: github.privateKey.replace(/\n/g, "\\n"),
    GITHUB_APP_SLUG: "gitmarks-smoke",
    GITHUB_API_URL: github.url,
    GITHUB_WEB_URL: github.url,
  });
  const manual = { redirect: "manual" };

  /** Start a sign-in and come back from GitHub with `code`, the way a browser would. */
  async function signIn(code, to = "/") {
    const start = await fetch(`${base}/api/auth/start?to=${encodeURIComponent(to)}`, manual);
    const state = new URL(start.headers.get("location")).searchParams.get("state");
    const stateCookie = start.headers.get("set-cookie").split(";")[0];
    const back = await fetch(`${base}/api/auth/callback?code=${code}&state=${state}`, {
      ...manual,
      headers: { cookie: stateCookie },
    });
    const session = (back.headers.get("set-cookie") ?? "")
      .split(/,(?=\s*\w+=)/)
      .find((c) => c.trim().startsWith("gitmarks_session="));
    return { location: back.headers.get("location"), cookie: session?.split(";")[0].trim() };
  }

  let cookie = "";
  let key = "";

  await check("strangers get the landing page, which search engines may index", async () => {
    const html = await (await fetch(base)).text();
    assert.match(html, /Two clicks on GitHub/);
    assert.ok(html.includes(`${github.url}/apps/gitmarks-smoke/installations/new`), "no install link");
    assert.ok(!html.includes("noindex"), "the landing page is hidden from search");
    assert.equal((await fetch(`${base}/api/vault`)).status, 404);
  });

  await check("sign-in sends people to GitHub with a nonce bound to their browser", async () => {
    const res = await fetch(`${base}/api/auth/start`, manual);
    assert.equal(res.status, 302);
    const to = new URL(res.headers.get("location"));
    assert.equal(`${to.origin}${to.pathname}`, `${github.url}/login/oauth/authorize`);
    assert.equal(to.searchParams.get("client_id"), "Iv1.smoke");
    assert.ok(to.searchParams.get("state").length >= 20);
    assert.match(res.headers.get("set-cookie"), /gitmarks_state=.*HttpOnly/i);
  });

  await check("a callback that did not start in this browser is refused", async () => {
    const start = await fetch(`${base}/api/auth/start`, manual);
    const stateCookie = start.headers.get("set-cookie").split(";")[0];
    const res = await fetch(`${base}/api/auth/callback?code=good&state=someone-elses`, {
      ...manual,
      headers: { cookie: stateCookie },
    });
    assert.equal(res.headers.get("location"), "/?error=state");
    assert.ok(!(res.headers.get("set-cookie") ?? "").includes("gitmarks_session="));
    const none = await fetch(`${base}/api/auth/callback?code=good&state=x`, manual);
    assert.equal(none.headers.get("location"), "/?error=state");
  });

  await check("signing in finds the one private repo, and revokes GitHub's user token", async () => {
    const result = await signIn("good", "/share?text=https%3A%2F%2Fexample.com");
    assert.equal(result.location, "/share?text=https%3A%2F%2Fexample.com");
    assert.ok(result.cookie, "no session");
    cookie = result.cookie;
    // Revoking is fire-and-forget, so give the request a moment to land.
    for (let i = 0; i < 20 && !github.revoked.length; i++) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(github.revoked, ["utok-good"]);
  });

  await check("a session reads and writes that repo, through a token narrowed to it", async () => {
    const res = await fetch(`${base}/api/vault`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: base },
      body: JSON.stringify({ type: "addCategory", name: "Reading" }),
    });
    assert.equal((await res.json()).ok, true);
    const stored = JSON.parse(github.files.get("alice/bookmarks:data/vault.json").text);
    assert.deepEqual(stored.categories, ["Reading"]);
    assert.deepEqual(github.scopes.at(-1), { repositories: ["bookmarks"], contents: "write" });
    // The default branch, so an empty repo's first save is its first commit.
    assert.equal(github.lastBranch, undefined);
  });

  await check("the device key works from the Shortcut, and cannot be pointed at another repo", async () => {
    const html = await (await fetch(base, { headers: { cookie } })).text();
    key = /gm_[\w.-]+/.exec(html)?.[0];
    assert.ok(key, "no device key on the page");
    const list = await fetch(`${base}/api/vault?list=categories`, {
      headers: { authorization: `Bearer ${key}` },
    });
    assert.deepEqual(await list.json(), ["Inbox", "Reading"]);
    const [body, signature] = key.slice(3).split(".");
    const claims = JSON.parse(Buffer.from(body, "base64url").toString());
    const other = Buffer.from(JSON.stringify({ ...claims, r: "bob/secrets" })).toString("base64url");
    const res = await fetch(`${base}/api/vault`, {
      headers: { authorization: `Bearer gm_${other}.${signature}` },
    });
    assert.equal(res.status, 404);
  });

  await check("there is no shared password to guess", async () => {
    const res = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ secret: SECRET }),
    });
    assert.equal(res.status, 404);
    assert.equal(
      (await fetch(`${base}/api/vault`, { headers: { authorization: `Bearer ${SECRET}` } })).status,
      404,
    );
  });

  await check("an app that can see several repos is sent back to narrow it down", async () => {
    const result = await signIn("many");
    assert.equal(result.location, "/?error=many&installation=99");
    assert.equal(result.cookie, undefined);
    const html = await (await fetch(`${base}${result.location}`)).text();
    assert.match(html, /more than one of your repos/);
    const fix = /<a href="([^"]+)"[^>]*>\s*Fix it on GitHub/.exec(html)?.[1];
    assert.equal(fix, "https://github.com/settings/installations/99");
  });

  await check("an installation on someone else's account does not count", async () => {
    const result = await signIn("org");
    assert.equal(result.location, "/?error=install");
    assert.equal(result.cookie, undefined);
  });

  await check("a public repo is refused before anything is saved to it", async () => {
    const result = await signIn("public");
    assert.equal(result.location, "/?error=public&installation=99&repo=alice%2Fbookmarks");
    assert.equal(result.cookie, undefined);
  });

  await check("uninstalling the app on GitHub cuts off every session and key", async () => {
    github.uninstalled = true;
    // A fresh process, so no token is cached from before.
    stop();
    const again = await boot(4714, {
      GITMARKS_SECRET: SECRET,
      GITHUB_APP_CLIENT_ID: "Iv1.smoke",
      GITHUB_APP_CLIENT_SECRET: "smoke-client-secret",
      GITHUB_APP_PRIVATE_KEY: github.privateKey,
      GITHUB_APP_SLUG: "gitmarks-smoke",
      GITHUB_API_URL: github.url,
      GITHUB_WEB_URL: github.url,
    });
    assert.equal((await fetch(`${again.base}/api/vault`, { headers: { cookie } })).status, 404);
    assert.equal(
      (await fetch(`${again.base}/api/vault`, { headers: { authorization: `Bearer ${key}` } })).status,
      404,
    );
    assert.match(await (await fetch(again.base, { headers: { cookie } })).text(), /Two clicks on GitHub/);
    again.stop();
  });

  github.close();
}

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall smoke checks passed");

/**
 * Just enough of GitHub for a sign-in and a save: OAuth, the user's
 * installations, app tokens (whose JWT it verifies), and one repo's contents
 * with sha checks. Each `code` is a different person.
 */
async function fakeGitHub(port) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const ALICE = 7;
  const people = {
    good: { installations: [{ id: 99, account: { id: ALICE } }], repos: [repo("alice/bookmarks")] },
    many: {
      installations: [{ id: 99, account: { id: ALICE } }],
      repos: [repo("alice/bookmarks"), repo("alice/diary")],
    },
    org: { installations: [{ id: 5, account: { id: 1000 } }], repos: [repo("acme/bookmarks")] },
    public: { installations: [{ id: 99, account: { id: ALICE } }], repos: [repo("alice/bookmarks", false)] },
  };
  function repo(full_name, isPrivate = true) {
    return { full_name, private: isPrivate, permissions: { push: true } };
  }
  const state = { files: new Map(), revoked: [], scopes: [], uninstalled: false, lastBranch: "unset" };
  const tokens = new Map(); // installation token → repo name it is scoped to

  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const json = (status, data) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    const url = new URL(req.url, "http://x");
    const auth = req.headers.authorization ?? "";
    const userCode = auth.startsWith("Bearer utok-") ? auth.slice("Bearer utok-".length) : null;
    const person = userCode && people[userCode];

    if (req.method === "POST" && url.pathname === "/login/oauth/access_token") {
      const { code, client_secret } = JSON.parse(body);
      if (client_secret !== "smoke-client-secret" || !people[code])
        return json(200, { error: "bad_verification_code" });
      return json(200, { access_token: `utok-${code}` });
    }
    if (req.method === "DELETE" && url.pathname === "/applications/Iv1.smoke/token") {
      state.revoked.push(JSON.parse(body).access_token);
      return json(204, {});
    }
    if (url.pathname === "/user") return person ? json(200, { id: ALICE }) : json(401, {});
    if (url.pathname === "/user/installations")
      return person ? json(200, { installations: person.installations }) : json(401, {});
    const repos = /^\/user\/installations\/(\d+)\/repositories$/.exec(url.pathname);
    if (repos) return person ? json(200, { repositories: person.repos }) : json(401, {});

    const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname);
    if (mint && req.method === "POST") {
      const [header, payload, signature] = auth.replace("Bearer ", "").split(".");
      const genuine = verify(
        "sha256",
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature ?? "", "base64url"),
      );
      if (!genuine || JSON.parse(Buffer.from(payload, "base64url")).iss !== "Iv1.smoke") return json(401, {});
      if (state.uninstalled || mint[1] !== "99") return json(404, {});
      const { repositories, permissions } = JSON.parse(body);
      state.scopes.push({ repositories, contents: permissions.contents });
      const token = `itok-${tokens.size}`;
      tokens.set(token, repositories[0]);
      return json(201, { token, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }

    const scoped = tokens.get(auth.replace("Bearer ", ""));
    const target = /^\/repos\/([^/]+)\/([^/]+)(\/contents\/(.+))?$/.exec(url.pathname);
    if (target) {
      if (state.uninstalled || scoped !== target[2]) return json(401, {});
      if (!target[3]) return json(200, { private: true });
      const id = `${target[1]}/${target[2]}:${target[4]}`;
      const file = state.files.get(id);
      if (req.method === "GET") {
        return file
          ? json(200, { content: Buffer.from(file.text).toString("base64"), sha: file.sha })
          : json(404, {});
      }
      const { content, sha, branch } = JSON.parse(body);
      state.lastBranch = branch;
      if ((file?.sha ?? undefined) !== sha) return json(file ? 409 : 422, {});
      const text = Buffer.from(content, "base64").toString();
      state.files.set(id, { text, sha: createHash("sha1").update(text).digest("hex") });
      return json(200, {});
    }
    json(404, {});
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return Object.assign(state, {
    url: `http://127.0.0.1:${port}`,
    privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
    close: () => server.close(),
  });
}
