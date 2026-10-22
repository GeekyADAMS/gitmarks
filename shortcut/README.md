# gitmarks on iPhone and iPad

A Shortcut puts gitmarks in the Share menu of every app — X, Safari, YouTube,
Instagram, Reddit. Tap **Share → Save to gitmarks**, pick a category, done.

![Share → Save to gitmarks → pick a category → saved](../docs/images/iphone-flow.jpg)

## Install it (two minutes)

**[Get the Shortcut →](https://www.icloud.com/shortcuts/e1abbf4623e14ebaa4b2dcd4cf62f78f)**

1. Open the link on your iPhone or iPad and tap **Add Shortcut**. It's called **Save to GitMarks**.
2. In the **Shortcuts** app, long-press **Save to GitMarks** and choose **Edit**.
3. Replace the placeholders. Each one appears twice, once in each **Get Contents of URL** action:

   | Find                | Replace with                                                             | Where                                                                       |
   | ------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
   | `<your-url>`        | your gitmarks address, without `https://`, e.g. `my-gitmarks.vercel.app` | the **URL** of both actions                                                 |
   | `<your app secret>` | your `GITMARKS_SECRET`                                                   | the **Authorization** header of both actions (tap **›** to see the headers) |

   Keep the word `Bearer` and the space after it, so the header reads `Bearer abc123…`. Keep the `/api/vault` path, and the `?list=categories` on the first URL.

4. Tap **Done**. Then, in any app, tap **Share → Save to GitMarks** and pick a category. The first time, iOS asks whether it may connect to your address: tap **Always Allow**.

It's already set up for the Share sheet, accepts links and text, and saves your clipboard when you run it from the home screen. If something doesn't work, see [Troubleshooting](#troubleshooting).

## Or build it yourself

The same Shortcut from scratch, in about five minutes. Building it yourself also means you know exactly what it sends. The steps below put your address and secret in two variables at the top, so each one appears only once.

Open **Shortcuts**, tap **+**, and name it **Save to gitmarks**. That name is what shows in the Share sheet and on the confirmation notification.

To add an action, type its name into the **Search** box at the bottom and tap it. Blue words inside an action are fields you can tap.

**1. Your address**

- **Text** → type your address, e.g. `https://my-gitmarks.vercel.app`
- **Set Variable** → name it `Site`

**2. Your secret**

- **Text** → paste your `GITMARKS_SECRET`
- **Set Variable** → name it `Secret`

**3. Fetch your categories**

- **Get Contents of URL** → in the URL field, insert the `Site` variable (tap the field, choose it from the bar above the keyboard), then type `/api/vault?list=categories` right after it.
- Tap **›** to expand it. Leave **Method** as GET. Under **Headers**, tap **Add new header**:
  - Key: `Authorization`
  - Value: type `Bearer` and a space, then insert the `Secret` variable.

**4. Pick one**

- **Choose from List** → it should read _Choose from Contents of URL_. Optionally set **Prompt** to `Save to…`

**5. Save the link**

- **Get Contents of URL** → URL: the `Site` variable followed by `/api/vault`
- Expand it. **Method:** POST. Add the same `Authorization` header as in step 3.
- **Request Body:** JSON. Tap **Add new field → Text** three times:

  | Key        | Value                           |
  | ---------- | ------------------------------- |
  | `type`     | `add`                           |
  | `urls`     | the **Shortcut Input** variable |
  | `category` | the **Chosen Item** variable    |

**6. Confirm**

- **Show Notification** → `Saved to ` followed by **Chosen Item**.

**7. Put it in the Share menu**

- Tap the round settings button at the top right of the editor and turn on **Show in Share Sheet**.
- A block appears at the top of your actions: _Receive Any input from Share Sheet_. Tap **Any**, keep only **URLs** and **Text**, then tap **Done**.
- In the same block, change **If there's no input** to **Get Clipboard**. Running the Shortcut from the home screen or with Back Tap then saves the link you last copied.

### Want it faster?

Delete steps 3–4 and set `category` to `Inbox`. Saving becomes a single tap, and you sort later on the web.

### Back Tap

Go to **Settings → Accessibility → Touch → Back Tap → Double Tap** and choose **Save to gitmarks**. Now you can copy a link anywhere, double-tap the back of your phone, and it's saved.

## Sharing your own copy

If you publish a fork and want to share a link of your own:

1. Build the Shortcut as above.
2. In its settings, under **Setup**, add an import question for each of the two Text actions in steps 1 and 2.
3. Tap **Share → Copy iCloud Link**.

Before you share, clear your own secret out of the Text action in step 2. iCloud links include the values you leave in.

## Troubleshooting

- **"Your gitmarks rejected that secret" or a 404:** the `Authorization` header must be exactly `Bearer`, one space, then your secret, in **both** actions. Also check the address has no typo and no trailing slash before `/api`.
- **The category list is empty or shows raw text:** the first action's URL must end in `/api/vault?list=categories`.
- **"Couldn't connect to server":** open your gitmarks address in Safari to check it's up. iOS also needs that one-time **Always Allow**.
- **Saved, but in the wrong place:** choosing **Inbox** files the link unsorted. Move it later on the web page.

## What it sends

The Shortcut is just two HTTP requests, so it's easy to check or rebuild:

```http
GET  {Site}/api/vault?list=categories
Authorization: Bearer {Secret}
→ ["Inbox", "Design", "Reading"]

POST {Site}/api/vault
Authorization: Bearer {Secret}
Content-Type: application/json

{ "type": "add", "urls": "Look at this https://x.com/…", "category": "Design" }
```

`urls` can be a single string or a list. Links are pulled out of any text around them, because apps often share "Look at this https://…" instead of a bare link. A category of `Inbox` means the inbox.
