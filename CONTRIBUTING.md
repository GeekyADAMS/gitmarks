# Contributing

Thanks for looking. gitmarks is small on purpose, and the bar for changes is what
keeps it that way. Please read **Scope** before writing code.

## Scope

gitmarks is a **single-person, no-database** bookmark tool that you deploy yourself.
Changes that fit:

- better previews, better saving flows, accessibility, performance, clearer docs
- fixes, especially anything security-related (but report vulnerabilities privately: see [SECURITY.md](SECURITY.md))

Changes that don't, and will be closed politely:

- multiple users, sharing, teams, or accounts
- a database, or any storage beyond the git file
- analytics, tracking, or third-party scripts in the page
- a new dependency for something a few lines of code can do

If you're unsure, open a feature request describing the problem first. It's cheaper
than a PR that gets declined.

## Setup

```bash
pnpm install
cp .env.example .env          # set GITMARKS_SECRET; `pnpm secret` prints one
pnpm dev                      # http://localhost:4321
```

Without `GITHUB_TOKEN`, bookmarks go to `.gitmarks-local.json`, which git ignores.
Nothing touches GitHub.

## Before you open a PR

```bash
pnpm verify    # format check, lint, types, unit tests, build, smoke test
```

CI runs the same commands on Node 22 (≥ 22.23.4) and 24, plus CodeQL and a dependency review.
All of them must pass, and every PR needs a maintainer's approving review before it
can merge.

- **One change per PR.** Refactors go separately from features.
- **Logic changes need a test** that fails without the change. Unit tests sit next to the code (`*.test.ts`). Anything about how the server behaves to the outside world goes in `test/smoke.mjs`.
- **Changes to auth, fetching, headers or the API** must say in the PR what the security impact is. Those files are listed in `CODEOWNERS` for the closest review.
- **Update the docs** whenever behaviour, setup or the API changes. The iPhone Shortcut depends on the API's exact shape, so it's a contract (see [shortcut/README.md](shortcut/README.md#what-it-sends)).
- Commit messages: imperative and specific, saying why as well as what. "Refuse NAT64 addresses in previews", not "fix bug".

## Where things live

| Path                                   | What it is                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `src/lib/vault.ts`                     | Types, URL normalising, request validation, and the reducer. Shared by the server and the page, with no I/O. |
| `src/lib/server.ts`                    | Loading and saving (GitHub or a local file), compare-and-swap retries, link previews                         |
| `src/lib/net.ts`                       | `safeFetch`: SSRF protection for preview fetches                                                             |
| `src/lib/auth.ts`                      | The secret, sessions, the bearer token, login throttling                                                     |
| `src/lib/github.ts`                    | The GitHub Contents API, repo visibility                                                                     |
| `src/middleware.ts`                    | Security headers and the cross-site write check                                                              |
| `src/pages/api/`                       | `vault` (read and write), `login`, `logout`                                                                  |
| `src/pages/index.astro`, `share.astro` | The app, and Android's share target                                                                          |
| `src/components/`                      | React islands (`Vault`, `Login`, `Share`) and Astro layout pieces                                            |
| `extension/`                           | The Chrome/Arc/Brave/Edge extension (plain JS, no build step)                                                |
| `shortcut/`                            | The iPhone Shortcut: install and build guide                                                                 |
| `test/smoke.mjs`                       | Boots the production build and checks it from outside                                                        |

## Design rules

- Colour comes from the semantic tokens in `src/styles/global.css` (`bg-surface`, `text-ink`, …). Never write `dark:` variants for them.
- `text-ink-muted` has only just enough contrast on `--surface` (4.59:1). Don't put it on darker fills.
- There is one focus style, set in the global CSS. Don't suppress it per component.

## Code of conduct

Participation is covered by the [Code of Conduct](CODE_OF_CONDUCT.md). Robust
technical criticism is welcome. Criticism of people isn't.
