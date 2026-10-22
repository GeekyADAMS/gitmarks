<h1 align="center">gitmarks</h1>

<p align="center">
  <strong>Private, categorised bookmarks that live in your own GitHub repo.</strong><br>
  Save from the web, a browser extension, the X timeline, and the iPhone and Android share sheets.<br>
  No database, no server to run. Every save is a commit.
</p>

<p align="center">
  <a href="https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FGeekyADAMS%2Fgitmarks&project-name=gitmarks&repository-name=gitmarks&env=GITMARKS_SECRET&envDescription=Your%20password%20and%20device%20token%3A%2032%2B%20random%20characters&envLink=https%3A%2F%2Fgithub.com%2FGeekyADAMS%2Fgitmarks%23setup"><img src="https://vercel.com/button" alt="Deploy with Vercel"></a>
  &nbsp;
  <a href="https://github.com/GeekyADAMS/gitmarks/actions/workflows/ci.yml"><img src="https://github.com/GeekyADAMS/gitmarks/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/GeekyADAMS/gitmarks/actions/workflows/codeql.yml"><img src="https://github.com/GeekyADAMS/gitmarks/actions/workflows/codeql.yml/badge.svg" alt="CodeQL"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/licence-MIT-171717" alt="MIT licence"></a>
</p>

![gitmarks in dark mode: categories on the left, rich previews of posts, videos and articles in a masonry grid](docs/images/hero.jpg)

## Why

X only lets you sort bookmarks into folders if you pay for Premium. Most bookmark
apps want an account and keep your data on their servers. gitmarks sorts
everything, not just X: posts, videos, articles, repos. It keeps all of it as one
JSON file in a private repo that you own. Version history, diffs, rollback and
export come free from git.

## Save from anywhere

![On iPhone: tap Share, choose Save to gitmarks, pick a category, and a notification confirms it was saved](docs/images/iphone-flow.jpg)

| Where                           | How                                                                                                                        |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **The web page**                | Press ⌘V anywhere, paste several links at once, or drag links in from other tabs. Drop cards onto categories to sort them. |
| **Chrome · Arc · Brave · Edge** | A toolbar button (`Alt+Shift+S`), right-click on any link, and a save button on [every post on X](extension/#readme).      |
| **iPhone · iPad**               | A Shortcut in the Share sheet of every app, with a category picker. → [Set it up](shortcut/#readme)                        |
| **Android**                     | Install the page to your home screen, and gitmarks joins every app's Share menu. One tap on a category saves.              |

<p align="center"><img src="docs/images/android-share.png" width="300" alt="Android share page: the shared link with a grid of categories to tap"></p>

## What else

- **Rich previews.** Posts on X show text, author and media. Everything else shows its card image, title and description.
- **Search that shows its work.** Matches are highlighted in the title, the text, your notes and the author.
- **Instant.** Every change appears at once, then settles on the server's answer.
- **Undo** on every move and delete. Notes on any card. Rename and merge categories.
- **Light and dark**, following your system.

![Search for "cod" highlights every match in a long post](docs/images/search.jpg)

## Setup

About five minutes, on free tiers of Vercel and GitHub.

**1. Deploy.** Click **Deploy with Vercel** above. Vercel copies this repo into your GitHub account, so **keep "Create private Git Repository" ticked**: your bookmarks will live there. It asks for one value:

- `GITMARKS_SECRET`: 32+ random characters (a password manager's generator, or `pnpm secret`). It's your password, your extension and phone token, and the key that signs your session.

**2. Connect your repo.** Open your new deployment. It names the exact repo your token needs:

1. [Create a fine-grained GitHub token](https://github.com/settings/personal-access-tokens/new).
2. Under **Repository access**, choose **Only select repositories**, then your new gitmarks repo.
3. Under **Permissions**, set **Contents** to **Read and write**. Nothing else.
4. In Vercel, go to **Settings → Environment Variables**, add it as `GITHUB_TOKEN`, then redeploy.

**3. Sign in and connect your devices.** Sign in with your secret (it lasts 30 days on each device), then click **Connect** for the extension, the iPhone Shortcut and Android.

If the repo is ever public, gitmarks pauses saving and tells you, so your bookmarks can't be quietly published.

## How it works

![Four clients send requests to one serverless function, which fetches previews and commits data/vault.json to your private repo](docs/images/architecture.svg)

- **The JSON file is the database.** Each write sends the sha it read. If the file changed in between, say your phone and laptop saving at once, the server re-reads and re-applies the change instead of overwriting.
- **No redeploys.** `vercel.json` skips the build when a commit only touches `data/`.
- **One reducer, both sides.** The page applies every change with the same function the server runs (`src/lib/vault.ts`), so the instant view and the stored result can't disagree.
- **Honest limits.** A save takes about a second, because that's the GitHub API's round trip. It's built for one person, not a team.

## Security

Anyone without the secret gets a 404. Sessions are signed and expire. Writes from
other sites are rejected. Link previews can only reach the public internet, never
your server's own network. The full threat model, every control, and the known
limitations are in [SECURITY.md](SECURITY.md). Please report vulnerabilities
privately.

## Settings

| Variable                | Required  |                                                         |
| ----------------------- | --------- | ------------------------------------------------------- |
| `GITMARKS_SECRET`       | yes       | At least 24 characters; 32+ random recommended          |
| `GITHUB_TOKEN`          | on Vercel | Fine-grained, this repo only, Contents: read and write  |
| `GITMARKS_REPO`         | no        | `owner/name`. Defaults to the repo Vercel deployed from |
| `GITMARKS_BRANCH`       | no        | Defaults to the deployed branch, then `main`            |
| `GITMARKS_ALLOW_PUBLIC` | no        | `true` to keep saving to a public repo on purpose       |

## Develop

```bash
pnpm install
cp .env.example .env     # set GITMARKS_SECRET
pnpm dev                 # http://localhost:4321
pnpm verify              # format, lint, types, tests, build, smoke test
```

Without `GITHUB_TOKEN`, bookmarks are saved to `.gitmarks-local.json`, which git
ignores. Contributions are welcome within the project's scope: read
[CONTRIBUTING.md](CONTRIBUTING.md) first.

## Licence

[MIT](LICENSE)
