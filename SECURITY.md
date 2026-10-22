# Security

## Reporting a vulnerability

Please **don't open a public issue.** Report it privately through
[GitHub's advisory form](https://github.com/GeekyADAMS/gitmarks/security/advisories/new).
Include what an attacker needs, what they get, and steps to reproduce. You'll get an
acknowledgement within 72 hours and a fix or a plan within 14 days. Credit is given in
the advisory unless you'd rather not have it.

Only the latest commit on `main` is supported. gitmarks.a9m.pro runs `main`. A
self-hosted deployment belongs to the person who deployed it, so fixes reach it when
they pull from upstream.

## Threat model

gitmarks runs two ways, and the model differs only in who signs in.

**Self-hosted.** What's protected: your bookmarks, your `GITMARKS_SECRET`, and your
`GITHUB_TOKEN`. Who's trusted: whoever holds the secret. There is exactly one user
per deployment.

**Hosted** (gitmarks.a9m.pro, or anyone running with `GITHUB_APP_*` set). What's
protected: every user's bookmarks from every other user, and from anyone else.
Who's trusted: GitHub, to say who signed in and which installation is theirs, and
the operator, who holds the app's private key and so could mint a token for any
repo that installed the app. Someone who wants nobody but themselves to hold that
power should self-host.

Either way, everyone else on the internet is untrusted, and that includes the web
pages you save, since their content is fetched and parsed.

### Controls

| Risk                                      | Control                                                                                                                                                                                                                                                                                                                                                                                        | Where                                   |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Someone guesses their way in              | A single secret of at least 24 characters (32+ random recommended). Anything shorter and the app refuses to start. Failed logins are throttled.                                                                                                                                                                                                                                                | `src/lib/auth.ts`                       |
| Timing attacks on comparisons             | Every comparison hashes both sides to SHA-256 and compares with `timingSafeEqual`, so neither content nor length leaks.                                                                                                                                                                                                                                                                        | `same()` in `auth.ts`                   |
| Session forgery or extension              | Sessions are `claims.HMAC(secret, "session:" + claims)`, carrying their own expiry, `HttpOnly`, `SameSite=Lax`, `Secure` over HTTPS, and last 30 days. The purpose is signed in, so a token minted for one job (session, device key, sign-in state) is useless as another. Rotating the secret ends every session and key.                                                                     | `auth.ts`                               |
| Reaching someone else's repo (hosted)     | The repo is never taken from the request. It comes from the signed session or device key, which the server wrote after asking GitHub, with the user's own token, which installations are theirs. Only an installation on the user's personal account counts, and only a private repo they can push to. GitHub's `installation_id` on the setup redirect is ignored, because it can be spoofed. | `src/lib/hosted.ts`, `owner.ts`         |
| Over-broad GitHub access (hosted)         | The app asks for Contents only. Each request mints an installation token narrowed to the one repo and to Contents, which expires within the hour. The user's own GitHub token is used once at sign-in and then revoked. Uninstalling the app ends every session and key.                                                                                                                       | `hosted.ts`                             |
| Login CSRF (hosted)                       | The OAuth `state` is a random nonce, and the same nonce sits signed in an `HttpOnly` cookie. The callback needs both to match, so a sign-in started in another browser can't finish in yours. Redirects after sign-in are limited to paths on the same site.                                                                                                                                   | `src/pages/api/auth/`                   |
| Probing for the API                       | Anything unauthenticated gets the same plain 404 as a route that doesn't exist.                                                                                                                                                                                                                                                                                                                | `src/pages/api/vault.ts`                |
| CSRF                                      | `SameSite=Lax` keeps the cookie off cross-site POSTs. As a second check, any cookie-authenticated write whose `Origin` names a different host than `Host` is rejected.                                                                                                                                                                                                                         | `src/middleware.ts`                     |
| SSRF through link previews                | The server fetches only `http(s)` URLs whose every resolved address is public. Loopback, private, link-local (including cloud metadata), CGNAT, multicast, documentation and NAT64 ranges are refused. Redirects are followed by hand, at most 5, and each hop is checked again.                                                                                                               | `src/lib/net.ts`                        |
| Malicious page content                    | Previews are parsed with cheerio and stored as plain strings. React escapes all output, and there's no `dangerouslySetInnerHTML` anywhere. Saved URLs must be `http(s)`, so a `javascript:` link can't be stored. Preview reads stop at `</head>` or 2 MB, and time out after 6 s.                                                                                                             | `src/lib/server.ts`, `src/lib/vault.ts` |
| XSS impact                                | A CSP restricts where scripts can connect (`connect-src 'self'`), plus `object-src 'none'`, `base-uri 'none'`, `form-action 'self'` and `frame-ancestors 'none'`.                                                                                                                                                                                                                              | `src/middleware.ts`                     |
| Malformed or hostile requests             | Every request body passes an allow-list parser before anything acts on it: types, lengths, batch size, URL schemes.                                                                                                                                                                                                                                                                            | `parseRequest` in `vault.ts`            |
| Bookmarks leaking through a public repo   | The app checks the repo's visibility and pauses saving if it's public, unless `GITMARKS_ALLOW_PUBLIC=true`.                                                                                                                                                                                                                                                                                    | `src/lib/github.ts`                     |
| Lost writes when two devices save at once | Each write is compare-and-swap on the file's blob sha. A conflict re-reads and re-applies the change rather than overwriting.                                                                                                                                                                                                                                                                  | `src/lib/server.ts`                     |
| Caching or indexing                       | Responses are `Cache-Control: private, no-store`, every page except the hosted landing page carries `noindex`, and `Referrer-Policy: no-referrer` is set.                                                                                                                                                                                                                                      | `middleware.ts`, `Shell.astro`          |
| Leaking secrets in errors                 | GitHub error bodies are never echoed back, because they can repeat the request. Settings are read from `process.env` only, never inlined into the build.                                                                                                                                                                                                                                       | `github.ts`, `env.ts`                   |
| Supply chain                              | CI actions are pinned to commit SHAs, workflows get read-only tokens, Dependabot runs on npm and Actions, dependency review blocks known-vulnerable additions, and CodeQL runs with `security-extended`.                                                                                                                                                                                       | `.github/`                              |
| Device keys                               | The extension and Shortcut send a `gm_` key: signed claims, never the secret. Self-hosted, the page can show it without showing the secret. Devices set up before keys existed may still send the secret itself.                                                                                                                                                                               | `auth.ts`                               |
| Browser extension                         | It has no host access until you grant your one gitmarks origin at setup, and no `innerHTML` anywhere. The key lives in extension-local storage.                                                                                                                                                                                                                                                | `extension/`                            |

### Known limitations

These are accepted and documented rather than hidden:

- **DNS rebinding.** The SSRF check and the fetch resolve DNS separately, so a hostile DNS server could answer differently the second time. Closing that needs a connect-time lookup hook. The API only acts for the secret holder, which limits the risk to someone who already has full access.
- **Login throttling is per instance.** On serverless, each instance counts failures on its own. The real protection is the secret's length; the throttle only slows down noise.
- **`script-src 'unsafe-inline'`.** Astro hydrates islands with inline bootstrap scripts. The CSP still blocks exfiltration over `fetch` and other connections, though not through image URLs (`img-src https:`, needed for previews).
- **Device keys don't expire, and can't be revoked one at a time.** A Shortcut that quietly stops working is worse for most people. To revoke keys: self-hosted, change the secret and redeploy; hosted, uninstall the app on GitHub and connect again. Both revoke every device.
- **Per-instance caches (hosted).** Installation tokens and repo visibility are cached in memory per serverless instance. After an uninstall, an instance that already holds a token keeps getting GitHub's refusals, and shows them as errors, until that token expires (under an hour). GitHub has revoked it either way.
- **Hosted previews fetch for anyone signed in.** Any GitHub user who installs the app can make the server fetch public URLs, up to 20 per save. The SSRF guard still keeps those fetches off private networks; there is no per-user rate limit yet.
- **Hosted request logs.** The Android share page and the bookmarks-bar button put the saved link in the page address, so it can appear in the host's request logs. See [PRIVACY.md](PRIVACY.md).

### Third parties your deployment talks to

| Service                                                       | When                        | What it learns                                                |
| ------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------- |
| GitHub API                                                    | every read and write        | your bookmarks (it hosts the repo)                            |
| The saved site                                                | when a link is saved        | that something fetched that URL, with a `gitmarks` user agent |
| `api.fxtwitter.com`, then `publish.twitter.com` as a fallback | saving a post on X          | which post was saved                                          |
| `www.google.com/s2/favicons`                                  | your browser, showing cards | the domains on screen                                         |
| Preview image hosts                                           | your browser, showing cards | your IP address. Requests carry no referrer.                  |

### If you deploy it

- Keep the repo **private**. The app checks, but don't rely on it alone.
- Scope the GitHub token to **this repo only**, with **Contents: read and write** and nothing else. Give it an expiry and renew it.
- Generate the secret with a password manager or `pnpm secret`. Never reuse a password.
- The iPhone Shortcut stores your key on your phone. Before sharing a copy of the Shortcut, clear the key out of it.

### If you run a hosted gitmarks

- The GitHub App's private key can mint a token for every repo that installed the app. Keep it only in your host's encrypted environment variables, and delete `.env.github-app` once it's pasted.
- Keep the app's permissions at Contents only. Asking for more prompts every user to approve it again, and should.
