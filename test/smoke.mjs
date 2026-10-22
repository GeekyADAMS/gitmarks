// Boots the production build and checks it from the outside, the way a
// stranger, a browser and the phone Shortcut would see it. Needs `pnpm build`
// first. Uses no network: the one link it saves points at a blocked address,
// which also proves the preview fetcher refuses internal targets.
import { spawn } from "node:child_process";
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
  await check("a short secret shows setup, not a login", async () => {
    assert.match(await (await fetch(base)).text(), /Add your secret/);
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
    assert.match(html, /example\.com\/post/);
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

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall smoke checks passed");
