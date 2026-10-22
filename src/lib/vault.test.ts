import { describe, expect, it } from "vitest";
import {
  EMPTY_VAULT,
  applyAction,
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
