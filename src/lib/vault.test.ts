import { describe, expect, it } from "vitest";
import {
  EMPTY_VAULT,
  applyAction,
  archiveAfter,
  archived,
  categoryTree,
  matches,
  noteMatches,
  noteText,
  withDescendants,
  extractUrls,
  normalizeUrl,
  parseRequest,
  splitMatches,
  xStatus,
  type Mark,
  type Note,
  type Vault,
} from "./vault";
import { cleanHtml, parseMeta } from "./server";

const mark = (over: Partial<Mark> = {}): Mark => ({
  id: "a",
  url: "https://example.com/a",
  title: "A",
  description: "",
  site: "example.com",
  kind: "link",
  category: "",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

describe("normalizeUrl", () => {
  it("gives one spelling per post on X", () => {
    const expected = "https://x.com/jack/status/20";
    expect(normalizeUrl("https://twitter.com/jack/status/20?s=20&t=abc")).toBe(expected);
    expect(normalizeUrl("https://mobile.twitter.com/jack/status/20/")).toBe(expected);
    expect(normalizeUrl("https://www.x.com/jack/status/20#reply")).toBe(expected);
  });

  it("drops tracking parameters but keeps meaningful ones", () => {
    expect(normalizeUrl("https://a.com/p?id=3&utm_source=x&fbclid=y")).toBe("https://a.com/p?id=3");
  });

  it("rejects anything that is not http(s)", () => {
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeUrl("not a url")).toBeNull();
  });
});

describe("extractUrls", () => {
  it("pulls every link out of prose, without trailing punctuation, deduplicated", () => {
    const text = "see https://a.com/x, and (https://b.com/y). Also https://a.com/x!";
    expect(extractUrls(text)).toEqual(["https://a.com/x", "https://b.com/y"]);
  });
});

describe("xStatus", () => {
  it("recognises posts and nothing else", () => {
    expect(xStatus("https://x.com/jack/status/20")).toEqual({ handle: "jack", id: "20" });
    expect(xStatus("https://x.com/jack")).toBeNull();
  });
});

describe("applyAction", () => {
  const vault: Vault = {
    categories: ["Design", "Code"],
    marks: [
      mark({ id: "1", url: "https://a.com", category: "Design", note: "keep" }),
      mark({ id: "2", url: "https://b.com" }),
    ],
  };

  it("re-saving a link moves it to the top but keeps its id, category and note", () => {
    const next = applyAction(vault, {
      type: "put",
      mark: mark({ id: "new", url: "https://a.com", title: "Fresh" }),
    });
    expect(next.marks.map((m) => m.id)).toEqual(["1", "2"]);
    expect(next.marks[0]).toMatchObject({ title: "Fresh", category: "Design", note: "keep" });
  });

  it("putting into an unknown category creates it", () => {
    const next = applyAction(EMPTY_VAULT, { type: "put", mark: mark({ category: "Reading" }) });
    expect(next.categories).toEqual(["Reading"]);
  });

  it("moving to the inbox clears the category without touching the list", () => {
    const next = applyAction(vault, { type: "update", id: "1", patch: { category: "" } });
    expect(next.marks[0].category).toBe("");
    expect(next.categories).toEqual(["Design", "Code"]);
  });

  it("renaming carries the links along, and renaming onto an existing name merges", () => {
    const renamed = applyAction(vault, { type: "renameCategory", from: "Design", to: "UI" });
    expect(renamed.categories).toEqual(["UI", "Code"]);
    expect(renamed.marks[0].category).toBe("UI");

    const merged = applyAction(vault, { type: "renameCategory", from: "Design", to: "Code" });
    expect(merged.categories).toEqual(["Code"]);
    expect(merged.marks[0].category).toBe("Code");
  });

  it("removing a category loses no links: they fall back to the inbox", () => {
    const next = applyAction(vault, { type: "removeCategory", name: "Design" });
    expect(next.categories).toEqual(["Code"]);
    expect(next.marks).toHaveLength(2);
    expect(next.marks[0].category).toBe("");
  });
});

describe("parseRequest", () => {
  it("normalises and deduplicates the URLs of an add", () => {
    expect(
      parseRequest({
        type: "add",
        urls: ["https://twitter.com/a/status/1?s=1", "https://x.com/a/status/1"],
      }),
    ).toEqual({ type: "add", urls: ["https://x.com/a/status/1"], category: "" });
  });

  it("rejects a batch holding anything that is not a link", () => {
    expect(parseRequest({ type: "add", urls: ["https://a.com", "javascript:x"] })).toBeNull();
    expect(parseRequest({ type: "add", urls: [] })).toBeNull();
    expect(parseRequest({ type: "put", mark: {} })).toBeNull();
    expect(parseRequest(null)).toBeNull();
  });

  it("takes what an iPhone share sheet sends: one string, links inside text, 'Inbox'", () => {
    expect(
      parseRequest({
        type: "add",
        urls: "Look at this https://x.com/a/status/1?s=20 lol",
        category: "Inbox",
      }),
    ).toEqual({ type: "add", urls: ["https://x.com/a/status/1"], category: "" });
  });

  it("never lets an empty title through to blank a mark", () => {
    expect(parseRequest({ type: "update", id: "1", patch: { title: "  " } })).toBeNull();
  });
});

describe("parseMeta", () => {
  it("prefers Open Graph, resolves relative images and decodes entities", () => {
    const html = `<html><head>
      <title>Fallback</title>
      <meta property="og:title" content="Ben &amp; Jerry">
      <meta name="description" content="Plain">
      <meta property="og:image" content="/card.png">
    </head></html>`;
    expect(parseMeta(html, "https://a.com/post")).toEqual({
      title: "Ben & Jerry",
      description: "Plain",
      image: "https://a.com/card.png",
    });
  });

  it("falls back to <title> when there are no cards", () => {
    expect(parseMeta("<title> Just a page </title>", "https://a.com")).toEqual({
      title: "Just a page",
    });
  });
});

describe("splitMatches", () => {
  it("puts matches at odd indexes, keeping the original casing", () => {
    expect(splitMatches("Vibe coding is vibes", "vibe")).toEqual(["", "Vibe", " coding is ", "vibe", "s"]);
  });

  it("reads the query literally, not as a pattern", () => {
    expect(splitMatches("a.b axb (c)", "a.b")).toEqual(["", "a.b", " axb (c)"]);
    expect(splitMatches("cost $5 (c)", "(c)")).toEqual(["cost $5 ", "(c)", ""]);
  });

  it("leaves text alone when there is no query", () => {
    expect(splitMatches("anything", "  ")).toEqual(["anything"]);
  });
});

describe("vaults from before tags and folders", () => {
  const legacy: Vault = {
    categories: ["Reading", "Tools", "Design"],
    marks: [mark({ id: "a", category: "Tools" }), mark({ id: "b", url: "https://example.com/b" })],
  };

  it("come through every old action unchanged in shape", () => {
    const steps = [
      { type: "put", mark: mark({ id: "c", url: "https://example.com/c", category: "Reading" }) },
      { type: "update", id: "a", patch: { note: "hi" } },
      { type: "addCategory", name: "Later" },
      { type: "renameCategory", from: "Tools", to: "Kit" },
      { type: "removeCategory", name: "Design" },
      { type: "delete", id: "b" },
    ] as const;
    const after = steps.reduce(applyAction, legacy);
    expect(Object.keys(after).sort()).toEqual(["categories", "marks"]);
    expect(after.categories).toEqual(["Reading", "Kit", "Later"]);
    expect(after.marks.every((m) => !("tags" in m))).toBe(true);
  });

  it("are all top level, in the order they were made", () => {
    expect(categoryTree(legacy)).toEqual([
      { name: "Reading", depth: 0 },
      { name: "Tools", depth: 0 },
      { name: "Design", depth: 0 },
    ]);
  });

  it("keep fields this version does not touch", () => {
    const v = { ...legacy, keyVersion: "v1" };
    expect(applyAction(v, { type: "addCategory", name: "X" }).keyVersion).toBe("v1");
    expect(applyAction(v, { type: "delete", id: "a" }).keyVersion).toBe("v1");
  });
});

describe("folders", () => {
  const base: Vault = {
    categories: ["Work", "Home", "Design", "Ideas"],
    marks: [mark({ id: "a", category: "Design" })],
  };
  const nested = applyAction(applyAction(base, { type: "moveCategory", name: "Design", parent: "Work" }), {
    type: "moveCategory",
    name: "Ideas",
    parent: "Design",
  });

  it("nest, keeping each folder right after its parent in the flat list", () => {
    expect(nested.parents).toEqual({ Design: "Work", Ideas: "Design" });
    expect(nested.categories).toEqual(["Work", "Design", "Ideas", "Home"]);
    expect(categoryTree(nested).map((c) => `${c.depth}:${c.name}`)).toEqual([
      "0:Work",
      "1:Design",
      "2:Ideas",
      "0:Home",
    ]);
    expect([...withDescendants(nested, "Work")]).toEqual(["Work", "Design", "Ideas"]);
  });

  it("refuse to go inside themselves", () => {
    expect(applyAction(nested, { type: "moveCategory", name: "Work", parent: "Ideas" })).toBe(nested);
    expect(applyAction(nested, { type: "moveCategory", name: "Work", parent: "Work" })).toBe(nested);
    expect(applyAction(nested, { type: "moveCategory", name: "Work", parent: "Nope" })).toBe(nested);
  });

  it("come back to the top level, and drop the map once nothing is nested", () => {
    const flat = applyAction(applyAction(nested, { type: "moveCategory", name: "Ideas", parent: "" }), {
      type: "moveCategory",
      name: "Design",
      parent: "",
    });
    expect(flat.parents).toBeUndefined();
  });

  it("can be made inside another", () => {
    const v = applyAction(nested, { type: "addCategory", name: "Logos", parent: "Design" });
    expect(v.categories).toEqual(["Work", "Design", "Ideas", "Logos", "Home"]);
    expect(v.parents?.Logos).toBe("Design");
  });

  it("move what was inside up a level when removed", () => {
    const v = applyAction(nested, { type: "removeCategory", name: "Design" });
    expect(v.parents).toEqual({ Ideas: "Work" });
    expect(v.marks[0].category).toBe("Work");
  });

  it("follow a rename, on both sides of the map", () => {
    const v = applyAction(nested, { type: "renameCategory", from: "Design", to: "Craft" });
    expect(v.parents).toEqual({ Craft: "Work", Ideas: "Craft" });
    expect(v.marks[0].category).toBe("Craft");
  });

  it("merged into one of their own folders, hand that folder their place", () => {
    const v = applyAction(nested, { type: "renameCategory", from: "Design", to: "Ideas" });
    expect(v.categories).toEqual(["Work", "Ideas", "Home"]);
    expect(v.parents).toEqual({ Ideas: "Work" });
  });

  it("still show when the file has a loop typed into it", () => {
    const loop: Vault = { categories: ["A", "B"], marks: [], parents: { A: "B", B: "A" } };
    expect(
      categoryTree(loop)
        .map((c) => c.name)
        .sort(),
    ).toEqual(["A", "B"]);
  });
});

describe("tags", () => {
  const v: Vault = { categories: [], marks: [mark({ id: "a" })] };

  it("are cleaned, de-duplicated, and removed entirely when emptied", () => {
    const tagged = applyAction(v, { type: "update", id: "a", patch: { tags: ["design", "ui"] } });
    expect(tagged.marks[0].tags).toEqual(["design", "ui"]);
    const cleared = applyAction(tagged, { type: "update", id: "a", patch: { tags: [] } });
    expect("tags" in cleared.marks[0]).toBe(false);
    expect(
      parseRequest({ type: "update", id: "a", patch: { tags: [" #Design ", "design", "UI", 4] } }),
    ).toEqual({
      type: "update",
      id: "a",
      patch: { tags: ["design", "ui"] },
    });
  });

  it("survive saving the same link again", () => {
    const tagged = applyAction(v, { type: "update", id: "a", patch: { tags: ["keep"] } });
    const again = applyAction(tagged, { type: "put", mark: mark({ id: "new" }) });
    expect(again.marks[0].tags).toEqual(["keep"]);
  });

  it("are searchable, with or without the #", () => {
    const m = mark({ tags: ["design"] });
    expect(matches(m, "#des")).toBe(true);
    expect(matches(m, "design")).toBe(true);
    expect(matches(m, "#ui")).toBe(false);
  });
});

describe("parseRequest, for the new actions", () => {
  it("reads folder moves, including back to the top", () => {
    expect(parseRequest({ type: "moveCategory", name: "A", parent: "" })).toEqual({
      type: "moveCategory",
      name: "A",
      parent: "",
    });
    expect(parseRequest({ type: "moveCategory", name: "A" })).toBeNull();
    expect(parseRequest({ type: "addCategory", name: "A", parent: "B" })).toEqual({
      type: "addCategory",
      name: "A",
      parent: "B",
    });
  });

  it("asks for a new key but never accepts one", () => {
    expect(parseRequest({ type: "resetKey" })).toEqual({ type: "resetKey" });
    expect(parseRequest({ type: "setKeyVersion", version: "mine" })).toBeNull();
  });
});

describe("notes", () => {
  const note = (over: Partial<Note> = {}): Note => ({
    id: "n1",
    title: "Groceries",
    html: "<ul><li>milk</li><li>eggs</li></ul>",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  });

  it("leave a vault without notes as it was until the first one", () => {
    const v: Vault = { categories: [], marks: [mark()] };
    expect(applyAction(v, { type: "deleteNote", id: "x" })).toBe(v);
    expect(
      applyAction(v, { type: "put", mark: mark({ id: "b", url: "https://e.com/b" }) }),
    ).not.toHaveProperty("notes");
  });

  it("go newest first, keeping their place and first-written time when edited", () => {
    let v = applyAction(EMPTY_VAULT, { type: "putNote", note: note() });
    v = applyAction(v, { type: "putNote", note: note({ id: "n2", title: "Ideas" }) });
    v = applyAction(v, {
      type: "putNote",
      note: note({
        title: "Shopping",
        createdAt: "2026-05-05T00:00:00.000Z",
        updatedAt: "2026-05-05T00:00:00.000Z",
      }),
    });
    expect(v.notes!.map((n) => n.title)).toEqual(["Ideas", "Shopping"]);
    expect(v.notes![1].createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(v.notes![1].updatedAt).toBe("2026-05-05T00:00:00.000Z");
    expect(applyAction(v, { type: "deleteNote", id: "n2" }).notes!.map((n) => n.id)).toEqual(["n1"]);
    expect(v.marks).toEqual([]);
  });

  it("are searched by title and words, not by their tags", () => {
    expect(noteText("<h2>Plan</h2><p>Buy <b>milk</b> &amp; eggs</p><ul><li>one</li></ul>")).toBe(
      "Plan\nBuy milk & eggs\none",
    );
    expect(noteText("<p>&lt;b&gt; is &amp;lt;</p>")).toBe("<b> is &lt;");
    expect(noteMatches(note(), "EGGS")).toBe(true);
    expect(noteMatches(note(), "grocer")).toBe(true);
    expect(noteMatches(note(), "li")).toBe(false);
  });

  it("can be filed, tagged and coloured, and move with their category", () => {
    let v: Vault = { categories: ["Home"], marks: [] };
    v = applyAction(v, {
      type: "putNote",
      note: note({ category: "Work", tags: ["todo"], color: "yellow" }),
    });
    expect(v.categories).toEqual(["Home", "Work"]);
    expect(noteMatches(v.notes![0], "#todo")).toBe(true);
    v = applyAction(v, { type: "renameCategory", from: "Work", to: "Job" });
    expect(v.notes![0].category).toBe("Job");
    v = applyAction(v, { type: "removeCategory", name: "Job" });
    expect(v.notes![0]).not.toHaveProperty("category");
    v = applyAction(v, { type: "putNote", note: note({ tags: [], color: undefined, category: "" }) });
    expect(Object.keys(v.notes![0]).sort()).toEqual(["createdAt", "html", "id", "title", "updatedAt"]);
  });

  it("move up a level with the links when their folder goes", () => {
    let v: Vault = { categories: ["Work", "Clients"], marks: [], parents: { Clients: "Work" } };
    v = applyAction(v, { type: "putNote", note: note({ category: "Clients" }) });
    v = applyAction(v, { type: "removeCategory", name: "Clients" });
    expect(v.notes![0].category).toBe("Work");
  });

  it("are parsed from a request without trusting its times", () => {
    expect(
      parseRequest({
        type: "saveNote",
        note: { id: "abc-1", title: " Hi ", html: "<p>x</p>", pinned: true, createdAt: "1999" },
      }),
    ).toEqual({ type: "saveNote", note: { id: "abc-1", title: "Hi", html: "<p>x</p>", pinned: true } });
    expect(
      parseRequest({
        type: "saveNote",
        note: { id: "a", html: "", category: " Work ", tags: ["#Todo", 5, "todo"], color: "yellow" },
      }),
    ).toEqual({
      type: "saveNote",
      note: { id: "a", title: "", html: "", category: "Work", tags: ["todo"], color: "yellow" },
    });
    expect(
      parseRequest({ type: "saveNote", note: { id: "a", html: "", color: "plaid", category: "Inbox" } }),
    ).toEqual({
      type: "saveNote",
      note: { id: "a", title: "", html: "" },
    });
    expect(parseRequest({ type: "saveNote", note: { id: "a b", html: "" } })).toBeNull();
    expect(parseRequest({ type: "saveNote", note: { id: "a", html: "x".repeat(100_001) } })).toBeNull();
    expect(parseRequest({ type: "saveNote", note: { id: "a" } })).toBeNull();
    expect(parseRequest({ type: "putNote", note: note() })).toBeNull();
    expect(parseRequest({ type: "deleteNote", id: "n1" })).toEqual({ type: "deleteNote", id: "n1" });
  });
});

describe("cleanHtml", () => {
  it("keeps what the editor makes", () => {
    const html =
      "<h2>Plan</h2><p><b>bold</b> <i>it</i> <u>under</u> <s>gone</s><br></p><ol><li>a</li></ol><blockquote>q</blockquote>";
    expect(cleanHtml(html)).toBe(html);
  });

  it("drops anything that could run, and every attribute", () => {
    expect(cleanHtml('<p onclick="x()">hi<script>alert(1)</script></p>')).toBe("<p>hi</p>");
    expect(cleanHtml('<img src=x onerror="alert(1)"><b style="color:red">b</b>')).toBe("<b>b</b>");
    expect(cleanHtml('<a href="javascript:alert(1)">link</a>')).toBe("link");
    expect(cleanHtml("<style>p{}</style><!-- c --><iframe src=//e.com></iframe>ok")).toBe("ok");
    expect(cleanHtml("<svg><script>alert(1)</script></svg>")).toBe("");
    expect(cleanHtml('<span>a &lt;script&gt; "b"</span>')).toBe('a &lt;script&gt; "b"');
  });

  it("drops the empty paragraphs editing leaves, but keeps blank lines", () => {
    expect(cleanHtml("<p>a</p><p></p><div></div><p><br></p><p>b</p>")).toBe("<p>a</p><p><br></p><p>b</p>");
  });

  it("keeps web and email links, opening in a new tab, and nothing else", () => {
    expect(cleanHtml('<a href="https://e.com/a?b=1&c=2" onclick="x()" target="_self">e</a>')).toBe(
      '<a href="https://e.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">e</a>',
    );
    expect(cleanHtml('<a href="mailto:me@e.com">mail</a>')).toContain('href="mailto:me@e.com"');
    for (const bad of ["javascript:alert(1)", " JaVaScRiPt:alert(1)", "data:text/html,x", "/relative", ""]) {
      expect(cleanHtml(`<a href="${bad}">words</a>`)).toBe("words");
    }
    expect(cleanHtml('<a href="https://e.com/&quot;onmouseover=&quot;x">q</a>')).not.toMatch(
      /"\s*onmouseover/,
    );
  });

  it("keeps checklists and which items are ticked", () => {
    const list =
      '<ul data-type="checklist"><li data-checked="true">milk</li><li data-checked="false">eggs</li></ul>';
    expect(cleanHtml(list)).toBe(list);
    expect(cleanHtml('<ul data-type="evil"><li data-checked="yes" data-x="1">a</li></ul>')).toBe(
      '<ul><li data-checked="false">a</li></ul>',
    );
  });

  it("survives deep nesting", () => {
    const deep = "<b>".repeat(5000) + "deep" + "</b>".repeat(5000);
    expect(cleanHtml(deep)).toContain("deep");
  });
});

describe("archive", () => {
  const day = 86_400_000;
  const at = (iso: string) => Date.parse(iso);

  it("leaves links saved before it existed alone for the first stretch", () => {
    const old = mark({ createdAt: "2024-01-01T00:00:00.000Z" });
    expect(archived(old, 90, at("2026-11-01T00:00:00.000Z"))).toBeNull();
    expect(archived(old, 90, at("2027-01-26T00:00:00.000Z") + day)).toBe("unused");
  });

  it("archives a link left unused for the chosen time, and never when that is 0", () => {
    const m = mark({ createdAt: "2027-01-01T00:00:00.000Z" });
    expect(archived(m, 30, at("2027-01-30T00:00:00.000Z"))).toBeNull();
    expect(archived(m, 30, at("2027-02-01T00:00:00.000Z"))).toBe("unused");
    expect(archived(m, 0, at("2030-01-01T00:00:00.000Z"))).toBeNull();
    expect(archived({ ...m, pending: true }, 30, at("2030-01-01T00:00:00.000Z"))).toBeNull();
  });

  it("counts opening a link as using it, and restoring as opening it", () => {
    let v: Vault = { categories: [], marks: [mark({ createdAt: "2027-01-01T00:00:00.000Z" })] };
    const later = at("2027-03-15T00:00:00.000Z");
    expect(archived(v.marks[0], 30, later)).toBe("unused");
    v = applyAction(v, { type: "touch", ids: ["a"], at: "2027-03-01T00:00:00.000Z" });
    expect(archived(v.marks[0], 30, later)).toBeNull();
    // An older touch arriving late does not wind the clock back.
    v = applyAction(v, { type: "touch", ids: ["a"], at: "2027-02-01T00:00:00.000Z" });
    expect(v.marks[0].openedAt).toBe("2027-03-01T00:00:00.000Z");
  });

  it("archives by hand until restored, whatever else happens to the link", () => {
    let v: Vault = { categories: [], marks: [mark()] };
    v = applyAction(v, { type: "archive", id: "a", at: "2027-01-01T00:00:00.000Z" });
    expect(archived(v.marks[0], 0)).toBe("manual");
    v = applyAction(v, { type: "touch", ids: ["a"], at: "2027-01-02T00:00:00.000Z" });
    expect(archived(v.marks[0], 0)).toBe("manual");
    v = applyAction(v, { type: "restore", id: "a", at: "2027-01-03T00:00:00.000Z" });
    expect(v.marks[0]).not.toHaveProperty("archivedAt");
    expect(archived(v.marks[0], 90, at("2027-02-01T00:00:00.000Z"))).toBeNull();
  });

  it("brings a link back when it is saved again", () => {
    let v: Vault = { categories: [], marks: [mark({ archivedAt: "2027-01-01T00:00:00.000Z" })] };
    v = applyAction(v, { type: "put", mark: mark({ id: "fresh", createdAt: "2027-02-01T00:00:00.000Z" }) });
    expect(v.marks).toHaveLength(1);
    expect(archived(v.marks[0], 90, at("2027-02-02T00:00:00.000Z"))).toBeNull();
  });

  it("keeps how long to wait in the vault, three months by default", () => {
    expect(archiveAfter(EMPTY_VAULT)).toBe(90);
    expect(archiveAfter(applyAction(EMPTY_VAULT, { type: "setArchiveAfter", days: 0 }))).toBe(0);
  });

  it("takes only which link from a request, never a time", () => {
    expect(parseRequest({ type: "archive", id: "a", at: "1999-01-01" })).toEqual({
      type: "archive",
      id: "a",
    });
    expect(parseRequest({ type: "restore", id: "a" })).toEqual({ type: "restore", id: "a" });
    expect(parseRequest({ type: "touch", ids: ["a", 3, "b"] })).toEqual({ type: "touch", ids: ["a", "b"] });
    expect(parseRequest({ type: "touch", ids: [] })).toBeNull();
    expect(parseRequest({ type: "setArchiveAfter", days: 180 })).toEqual({
      type: "setArchiveAfter",
      days: 180,
    });
    for (const days of [-1, 1.5, "90", 99999])
      expect(parseRequest({ type: "setArchiveAfter", days })).toBeNull();
  });
});
