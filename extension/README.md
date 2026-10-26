# gitmarks for Chrome, Arc, Brave and Edge

- **Toolbar button or `Alt+Shift+S`:** save the current tab. Pick a category (keys `1`–`9`), add a note if you like, press `Enter`.
- **Right-click:** "Save link to gitmarks" on any link, "Save page to gitmarks" anywhere else. These go to the Inbox.
- **On X:** a save button sits in every post's action bar, beside like and repost. Click it, then tap a category chip to sort it right there.

Using Safari or Firefox? Use the **Save to gitmarks** button from **Connect** in gitmarks instead: drag it to your bookmarks bar.

## Install

1. Install [gitmarks from the Chrome Web Store](https://chromewebstore.google.com/detail/gitmarks/alnhmhklodcajljkfbonfhkbeaedkalf). It works in Chrome, Arc, Brave and Edge.
2. Pin it: click the puzzle-piece icon in the toolbar, then the pin beside **gitmarks**.
3. In gitmarks, click **Connect** and copy your key. Click the gitmarks icon, paste the key, and **Save settings**. Self-hosting? Change the address to yours first.
4. When the browser asks to let gitmarks read and change data on that site, click **Allow**. That's the only site it can talk to.

### Load it yourself (for development)

1. Download this repository, or clone it.
2. Open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked**, and choose this `extension` folder.
3. Carry on from step 2 above.

To try it against `pnpm dev`, use `http://localhost:4321` as the address.

Your key is kept in the extension's local storage. To revoke it: hosted, uninstall the gitmarks app on GitHub; self-hosted, change `GITMARKS_SECRET` in Vercel and redeploy.

## Publishing

`pnpm extension` builds `gitmarks-extension.zip` for the Chrome Web Store. The
listing text and the permission justifications the store asks for are in
[STORE.md](STORE.md).
