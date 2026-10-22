# Security

## Reporting a vulnerability

Please **don't open a public issue.** Report it privately through
[GitHub's advisory form](https://github.com/GeekyADAMS/gitmarks/security/advisories/new).
Include what an attacker needs, what they get, and steps to reproduce. You'll get an
acknowledgement within 72 hours and a fix or a plan within 14 days. Credit is given in
the advisory unless you'd rather not have it.

Only the latest commit on `main` is supported. gitmarks is a template, not a hosted
service: every deployment belongs to the person who deployed it, so fixes reach them
when they pull from upstream.

## Threat model

**What's being protected:** your bookmarks, your `GITMARKS_SECRET`, and your
`GITHUB_TOKEN`.

**Who's trusted:** whoever holds the secret. There is exactly one user per deployment.
Everyone else on the internet is untrusted, and that includes the web pages you save,
since their content is fetched and parsed.

### Controls

| Risk                                      | Control                                                                                                                                                                                                                                                                            | Where                                   |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Someone guesses their way in              | A single secret of at least 24 characters (32+ random recommended). Anything shorter and the app refuses to start. Failed logins are throttled.                                                                                                                                    | `src/lib/auth.ts`                       |
| Timing attacks on comparisons             | Every comparison hashes both sides to SHA-256 and compares with `timingSafeEqual`, so neither content nor length leaks.                                                                                                                                                            | `same()` in `auth.ts`                   |
| Session forgery or extension              | Sessions are `expiry.HMAC(secret, expiry)`, `HttpOnly`, `SameSite=Lax`, `Secure` over HTTPS, and last 30 days. Rotating the secret ends every session.                                                                                                                             | `auth.ts`                               |
| Probing for the API                       | Anything unauthenticated gets the same plain 404 as a route that doesn't exist.                                                                                                                                                                                                    | `src/pages/api/vault.ts`                |
| CSRF                                      | `SameSite=Lax` keeps the cookie off cross-site POSTs. As a second check, any cookie-authenticated write whose `Origin` names a different host than `Host` is rejected.                                                                                                             | `src/middleware.ts`                     |
| SSRF through link previews                | The server fetches only `http(s)` URLs whose every resolved address is public. Loopback, private, link-local (including cloud metadata), CGNAT, multicast, documentation and NAT64 ranges are refused. Redirects are followed by hand, at most 5, and each hop is checked again.   | `src/lib/net.ts`                        |
| Malicious page content                    | Previews are parsed with cheerio and stored as plain strings. React escapes all output, and there's no `dangerouslySetInnerHTML` anywhere. Saved URLs must be `http(s)`, so a `javascript:` link can't be stored. Preview reads stop at `</head>` or 2 MB, and time out after 6 s. | `src/lib/server.ts`, `src/lib/vault.ts` |
| XSS impact                                | A CSP restricts where scripts can connect (`connect-src 'self'`), plus `object-src 'none'`, `base-uri 'none'`, `form-action 'self'` and `frame-ancestors 'none'`.                                                                                                                  | `src/middleware.ts`                     |
| Malformed or hostile requests             | Every request body passes an allow-list parser before anything acts on it: types, lengths, batch size, URL schemes.                                                                                                                                                                | `parseRequest` in `vault.ts`            |
| Bookmarks leaking through a public repo   | The app checks the repo's visibility and pauses saving if it's public, unless `GITMARKS_ALLOW_PUBLIC=true`.                                                                                                                                                                        | `src/lib/github.ts`                     |
| Lost writes when two devices save at once | Each write is compare-and-swap on the file's blob sha. A conflict re-reads and re-applies the change rather than overwriting.                                                                                                                                                      | `src/lib/server.ts`                     |
| Caching or indexing                       | Responses are `Cache-Control: private, no-store`, pages carry `noindex`, and `Referrer-Policy: no-referrer` is set.                                                                                                                                                                | `middleware.ts`, `Shell.astro`          |
| Leaking secrets in errors                 | GitHub error bodies are never echoed back, because they can repeat the request. Settings are read from `process.env` only, never inlined into the build.                                                                                                                           | `github.ts`, `env.ts`                   |
| Supply chain                              | CI actions are pinned to commit SHAs, workflows get read-only tokens, Dependabot runs on npm and Actions, dependency review blocks known-vulnerable additions, and CodeQL runs with `security-extended`.                                                                           | `.github/`                              |
| Browser extension                         | It has no host access until you grant your one gitmarks origin at setup, and no `innerHTML` anywhere. The secret lives in extension-local storage.                                                                                                                                 | `extension/`                            |

### Known limitations

These are accepted and documented rather than hidden:

- **DNS rebinding.** The SSRF check and the fetch resolve DNS separately, so a hostile DNS server could answer differently the second time. Closing that needs a connect-time lookup hook. The API only acts for the secret holder, which limits the risk to someone who already has full access.
- **Login throttling is per instance.** On serverless, each instance counts failures on its own. The real protection is the secret's length; the throttle only slows down noise.
- **`script-src 'unsafe-inline'`.** Astro hydrates islands with inline bootstrap scripts. The CSP still blocks exfiltration over `fetch` and other connections, though not through image URLs (`img-src https:`, needed for previews).
- **One secret, many places.** The same secret is the password and the device token. Rotating it (change the env var, redeploy) means updating the extension and Shortcut too. That trade-off was made deliberately to keep setup simple.

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
- The iPhone Shortcut stores the secret on your phone. Before sharing a copy of the Shortcut, clear the secret out of it.
