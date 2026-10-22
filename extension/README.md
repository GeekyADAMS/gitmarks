# gitmarks for Chrome, Arc, Brave and Edge

- **Toolbar button or `Alt+Shift+S`:** save the current tab. Pick a category (keys `1`–`9`), add a note if you like, press `Enter`.
- **Right-click:** "Save link to gitmarks" on any link, "Save page to gitmarks" anywhere else. These go to the Inbox.
- **On X:** a save button sits in every post's action bar, beside like and repost. Click it, then tap a category chip to sort it right there.

## Install

1. Download this repository, or clone it.
2. Open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked**, and choose this `extension` folder.
3. Pin it: click the puzzle-piece icon in the toolbar, then the pin beside **gitmarks**.
4. Click the gitmarks icon. Enter your gitmarks address (for example `https://my-gitmarks.vercel.app`) and your `GITMARKS_SECRET`, then **Save settings**.
5. When the browser asks to let gitmarks read and change data on that site, click **Allow**. That's the only site it can talk to.

To try it against `pnpm dev`, use `http://localhost:4321` as the address.

Your secret is kept in the extension's local storage. To revoke it, change `GITMARKS_SECRET` in Vercel and redeploy.
