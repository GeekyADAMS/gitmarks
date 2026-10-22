// Registers the GitHub App that hosted mode signs people in with, in one
// click, using GitHub's manifest flow. Only whoever runs a hosted gitmarks
// needs this; self-hosting does not.
//
//   node scripts/create-github-app.mjs https://gitmarks.a9m.pro [app-name]
//
// It opens GitHub with every setting filled in. Click "Create GitHub App" and
// the four values hosted mode needs are written to .env.github-app (readable
// only by you, and ignored by git). Paste them into your host, then delete it.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { execFile } from "node:child_process";

const [site, name = "gitmarks"] = process.argv.slice(2);
if (!site || !/^https?:\/\/[^/]+$/.test(site)) {
  console.error("Usage: node scripts/create-github-app.mjs https://your-domain [app-name]");
  process.exit(1);
}

const PORT = 3999;
const local = `http://127.0.0.1:${PORT}`;
const state = randomBytes(16).toString("hex");
const manifest = {
  name,
  url: site,
  description: "Private, categorised bookmarks saved as commits to one repo you choose.",
  public: true,
  hook_attributes: { url: `${site}/api/github/webhook`, active: false },
  redirect_url: `${local}/done`,
  callback_urls: [`${site}/api/auth/callback`],
  // After installing, GitHub sends people here, which signs them straight in.
  setup_url: `${site}/api/auth/start`,
  setup_on_update: true,
  request_oauth_on_install: false,
  // Contents is all gitmarks reads or writes. Metadata comes with it.
  default_permissions: { contents: "write" },
  default_events: [],
};

const escape = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const page = `<!doctype html><meta charset="utf-8"><title>Create the gitmarks GitHub App</title>
<form action="https://github.com/settings/apps/new?state=${state}" method="post">
  <input type="hidden" name="manifest" value="${escape(JSON.stringify(manifest))}">
  <p>Sending you to GitHub…</p><button>Continue</button>
</form><script>document.forms[0].submit()</script>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, local);
  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(page);
  }
  if (url.pathname !== "/done") return res.writeHead(404).end();
  if (url.searchParams.get("state") !== state) return res.writeHead(400).end("State mismatch. Start again.");
  const code = url.searchParams.get("code") ?? "";
  if (!/^[\w-]{1,100}$/.test(code)) return res.writeHead(400).end("GitHub sent no code. Start again.");

  const conversion = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json" },
  });
  if (!conversion.ok) {
    res.writeHead(502).end(`GitHub said ${conversion.status}. Start again.`);
    return finish(1);
  }
  const app = await conversion.json();
  const env = [
    `GITHUB_APP_CLIENT_ID="${app.client_id}"`,
    `GITHUB_APP_CLIENT_SECRET="${app.client_secret}"`,
    `GITHUB_APP_SLUG="${app.slug}"`,
    `GITHUB_APP_PRIVATE_KEY="${app.pem.trim().replace(/\n/g, "\\n")}"`,
  ].join("\n");
  writeFileSync(".env.github-app", `${env}\n`, { mode: 0o600 });

  res.writeHead(200, { "content-type": "text/html" });
  res.end(
    `<!doctype html><meta charset="utf-8"><p>Created <b>${escape(app.slug)}</b>. Back to the terminal.</p>`,
  );
  console.log(`\nCreated https://github.com/apps/${app.slug}`);
  console.log("Wrote .env.github-app. Add each line to your host's environment variables,");
  console.log("along with a GITMARKS_SECRET (`pnpm secret`), redeploy, then delete the file.");
  finish(0);
});

function finish(code) {
  server.close();
  setTimeout(() => process.exit(code), 100);
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Opening ${local} — if nothing opens, visit it yourself.`);
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  execFile(opener, [local], () => {});
});
