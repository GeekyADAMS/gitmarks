# Chrome Web Store listing

Everything the store's form asks for, ready to paste.

**Name:** gitmarks

**Summary** (132 characters max):
Save any page, link or post on X into your own categories. Stored as commits in a private GitHub repo that you own.

**Category:** Productivity

**Description:**

gitmarks is a bookmark manager that keeps your bookmarks in a private GitHub repo
that you own. There's no gitmarks account and no database.

• Save the current page from the toolbar, or with Alt+Shift+S
• Pick a category with the number keys, add a note, press Enter
• Right-click any link to save it
• On X, a save button sits in every post, beside like and repost

To connect, open gitmarks, click Connect, copy your key, and paste it into the
extension. Works with gitmarks.a9m.pro or your own self-hosted copy.

Free and open source: https://github.com/GeekyADAMS/gitmarks

**Single purpose:** Save the current page, a link, or a post on X to the user's own gitmarks.

**Permission justifications:**

- `activeTab`: to read the current tab's address and title when the user clicks the toolbar button.
- `contextMenus`: for the "Save link to gitmarks" and "Save page to gitmarks" right-click items.
- `storage`: to keep the user's gitmarks address and key on their device.
- Optional host permission: requested once, for the one gitmarks address the user enters, so the extension can send saves to it. No other site.
- Content script on x.com and twitter.com: to add a save button to each post.

**Data use:** The extension sends the address of a page the user chooses to save,
and an optional note, to the user's own gitmarks address. It collects nothing else,
sells nothing, and uses nothing for advertising or creditworthiness.

**Privacy policy URL:** https://github.com/GeekyADAMS/gitmarks/blob/main/PRIVACY.md

**Images:** a 128×128 icon (`icon.png`), and at least one 1280×800 screenshot.
