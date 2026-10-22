# Privacy

This covers **gitmarks.a9m.pro**, the hosted gitmarks. If you
[host gitmarks yourself](README.md#host-it-yourself), your copy talks to GitHub and
to the sites you save, and to nobody else (see [SECURITY.md](SECURITY.md#third-parties-your-deployment-talks-to)).

## The short version

Your bookmarks live in a private GitHub repo that you own. gitmarks.a9m.pro has no
database and keeps no copy of them. It can open only the one repo you chose when
you connected it, and only that repo's files.

## What gitmarks.a9m.pro can see

- **Your GitHub user ID**, once, when you sign in, to check which installation and
  repo are yours. It is written into your sign-in cookie, not stored anywhere else.
- **The one repo you connected**, and only its contents. The GitHub App asks for
  _Contents: read and write_ and nothing else. Each request uses a token GitHub
  issues for that repo alone, which expires within the hour.
- **The links you save**, while saving them: to fetch the title, description and
  image you see on each card, the server visits the link (posts on X go through
  `api.fxtwitter.com`). The result is written to your repo, not kept.

## What it keeps

Nothing about you, in any database. There is none. The only things that persist are:

- **Your sign-in cookie**, in your browser, for 30 days. It is signed so it can't be
  altered, and names your installation, your repo and your GitHub user ID.
- **Your device key**, wherever you paste it: the extension, the iPhone Shortcut.
- **Request logs** kept by the hosting provider (Vercel) for a short time, like any
  website: IP address, time, and the page asked for. The Android share page and the
  bookmarks-bar button pass the link being saved in the page address, so those links
  can appear in these logs.

## Leaving

Uninstall the gitmarks app on GitHub (Settings → Applications → gitmarks →
Uninstall). That ends every session and every device key at once. Your bookmarks
stay in your repo as `data/vault.json`. Delete the repo too if you want them gone.

## Questions

Open an issue on [GitHub](https://github.com/GeekyADAMS/gitmarks/issues), or for
anything sensitive, use the [private advisory form](https://github.com/GeekyADAMS/gitmarks/security/advisories/new).
