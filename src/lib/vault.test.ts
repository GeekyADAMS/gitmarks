import { describe, expect, it } from "vitest";
import {
  EMPTY_VAULT,
  applyAction,
  categoryTree,
  matches,
  withDescendants,
  extractUrls,
  normalizeUrl,
  parseRequest,
  splitMatches,
  xStatus,
  type Mark,
  type Vault,
} from "./vault";
import { parseMeta } from "./server";

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
