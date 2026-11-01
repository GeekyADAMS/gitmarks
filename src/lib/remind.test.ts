import { describe, expect, it } from "vitest";
import { calendar, occurrences, picks, pool, zoned } from "./remind";
import { applyAction, cleanReminder, parseRequest, type Mark, type Reminder, type Vault } from "./vault";

const mark = (id: string, over: Partial<Mark> = {}): Mark => ({
  id,
  url: `https://example.com/${id}`,
  title: id.toUpperCase(),
  description: "",
  site: "example.com",
  kind: "link",
  category: "",
  createdAt: "2026-11-01T00:00:00.000Z",
  ...over,
});

const reminder = (over: Partial<Reminder> = {}): Reminder => ({
  id: "r1",
  days: [5],
  time: "18:00",
  tz: "Europe/London",
  count: 3,
  ...over,
});

// A Sunday.
const NOW = Date.parse("2026-11-01T12:00:00.000Z");

describe("reminders", () => {
  it("validates what a request or the file holds", () => {
    expect(cleanReminder(reminder({ days: [6, 1, 1, 9] }))?.days).toEqual([1, 6]);
    expect(cleanReminder(reminder({ days: [] }))).toBeNull();
    expect(cleanReminder(reminder({ time: "25:00" }))).toBeNull();
    expect(cleanReminder(reminder({ tz: "Mars/Olympus" }))).toBeNull();
    expect(cleanReminder(reminder({ count: 7 }))).toBeNull();
    expect(cleanReminder(reminder({ id: "a b" }))).toBeNull();
    expect(parseRequest({ type: "putReminder", reminder: reminder() })).toEqual({
      type: "putReminder",
      reminder: reminder(),
    });
  });

  it("puts, replaces in place, follows a renamed category and deletes", () => {
    let v: Vault = { categories: ["Design"], marks: [] };
    v = applyAction(v, { type: "putReminder", reminder: reminder({ from: "Design" }) });
    v = applyAction(v, { type: "putReminder", reminder: reminder({ id: "r2" }) });
    v = applyAction(v, { type: "putReminder", reminder: reminder({ from: "Design", count: 5 }) });
    expect(v.reminders?.map((r) => [r.id, r.count])).toEqual([
      ["r1", 5],
      ["r2", 3],
    ]);
    v = applyAction(v, { type: "renameCategory", from: "Design", to: "UI" });
    expect(v.reminders?.[0].from).toBe("UI");
    v = applyAction(v, { type: "removeCategory", name: "UI" });
    expect(v.reminders?.[0].from).toBeUndefined();
    v = applyAction(v, { type: "deleteReminder", id: "r1" });
    v = applyAction(v, { type: "deleteReminder", id: "r2" });
    expect(v.reminders).toBeUndefined();
  });

  it("draws from unarchived links in its category or tag, unused longest first", () => {
    const v: Vault = {
      categories: ["Design", "Type"],
      parents: { Type: "Design" },
      marks: [
        mark("new", { category: "Type", createdAt: "2026-10-30T00:00:00.000Z" }),
        mark("old", { category: "Design", createdAt: "2026-10-29T00:00:00.000Z", tags: ["read"] }),
        mark("gone", { category: "Design", archivedAt: "2026-10-31T00:00:00.000Z" }),
        mark("other", { tags: ["read"] }),
      ],
    };
    expect(pool(v, reminder({ from: "Design" }), NOW).map((m) => m.id)).toEqual(["old", "new"]);
    expect(pool(v, reminder({ from: "#read" }), NOW).map((m) => m.id)).toEqual(["old", "other"]);
    expect(pool(v, reminder(), NOW)).toHaveLength(3);
  });

  it("takes the next links each time, wrapping round", () => {
    const links = ["a", "b", "c"].map((id) => mark(id));
    expect(picks(links, 2, 0).map((m) => m.id)).toEqual(["a", "b"]);
    expect(picks(links, 2, 1).map((m) => m.id)).toEqual(["c", "a"]);
    expect(picks(links.slice(0, 1), 3, 4).map((m) => m.id)).toEqual(["a"]);
  });

  it("lands on the wall-clock time in its zone, either side of a clock change", () => {
    // London is on GMT in November and BST in June.
    expect(new Date(zoned(Date.UTC(2026, 10, 6), "18:00", "Europe/London")).toISOString()).toBe(
      "2026-11-06T18:00:00.000Z",
    );
    expect(new Date(zoned(Date.UTC(2026, 5, 5), "18:00", "Europe/London")).toISOString()).toBe(
      "2026-06-05T17:00:00.000Z",
    );
    expect(new Date(zoned(Date.UTC(2026, 10, 6), "08:30", "Asia/Kolkata")).toISOString()).toBe(
      "2026-11-06T03:00:00.000Z",
    );
  });

  it("is due on its days for the next four weeks", () => {
    const fridays = occurrences(reminder(), NOW).map((t) => new Date(t).toISOString());
    expect(fridays).toEqual([
      "2026-11-06T18:00:00.000Z",
      "2026-11-13T18:00:00.000Z",
      "2026-11-20T18:00:00.000Z",
      "2026-11-27T18:00:00.000Z",
    ]);
    // Late Sunday in Los Angeles is already Monday in UTC; "today" is the local day.
    const la = occurrences(
      reminder({ days: [0], tz: "America/Los_Angeles" }),
      Date.parse("2026-11-02T06:00:00Z"),
    );
    expect(new Date(la[0]).toISOString()).toBe("2026-11-02T02:00:00.000Z");
  });

  it("writes a feed with one event per day, links through gitmarks, escaped and folded", () => {
    const v: Vault = {
      categories: [],
      marks: [
        mark("a", { title: "Commas, semicolons; and a very long title that needs folding" }),
        mark("b"),
      ],
      reminders: [reminder()],
    };
    const ics = calendar(v, "https://app.test", (id) => `https://app.test/api/open?id=${id}`, NOW);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(4);
    expect(ics).toContain("UID:r1-20261106@gitmarks");
    expect(ics).toContain("DTSTART:20261106T180000Z");
    expect(ics).toContain("SUMMARY:Revisit 2 links");
    expect(ics.replace(/\r\n /g, "")).toContain("Commas\\, semicolons\\; and");
    expect(ics.replace(/\r\n /g, "")).toContain("https://app.test/api/open?id=a");
    expect(ics.split("\r\n").every((line) => new TextEncoder().encode(line).length <= 75)).toBe(true);
    // Nothing to revisit, nothing in the calendar.
    expect(calendar({ ...v, marks: [] }, "https://app.test", String, NOW)).not.toContain("VEVENT");
  });
});
