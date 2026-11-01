import {
  archiveAfter,
  archived,
  lastUsed,
  withDescendants,
  type Mark,
  type Reminder,
  type Vault,
} from "./vault";

/**
 * Reminders, as a calendar feed. The calendar app does the hard parts: it
 * fires the alert on time, in the right zone, on every device. Each day a
 * reminder is due becomes its own event, holding the links to revisit that
 * day, so a calendar that only refreshes the feed now and then still shows
 * different links on different days.
 */

/** How far ahead events are listed. Calendars refresh well within this. */
const WINDOW_DAYS = 28;
const DAY = 86_400_000;

/** The links a reminder draws from: not archived, unused longest first. */
export function pool(vault: Vault, reminder: Reminder, now = Date.now()): Mark[] {
  const days = archiveAfter(vault);
  const from = reminder.from ?? "";
  const inside = from && !from.startsWith("#") ? withDescendants(vault, from) : null;
  const tag = from.startsWith("#") ? from.slice(1) : null;
  return vault.marks
    .filter(
      (m) =>
        !archived(m, days, now) &&
        (!inside || inside.has(m.category)) &&
        (!tag || Boolean(m.tags?.includes(tag))),
    )
    .sort((a, b) => lastUsed(a).localeCompare(lastUsed(b)));
}

/** The `k`th time a reminder comes round takes the next links along, wrapping. */
export function picks(links: Mark[], count: number, k: number): Mark[] {
  const n = Math.min(count, links.length);
  return Array.from({ length: n }, (_, j) => links[(k * count + j) % links.length]);
}

/** Milliseconds `tz` is ahead of UTC at instant `t`. */
function offset(t: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(t);
  const p = Object.fromEntries(parts.map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
}

/** The instant a wall-clock time happens in `tz`. `day` is midnight UTC of the local date. */
export function zoned(day: number, time: string, tz: string): number {
  const [h, m] = time.split(":").map(Number);
  const local = day + h * 3_600_000 + m * 60_000;
  // Twice, so a time just across a clock change lands on the right side of it.
  return local - offset(local - offset(local, tz), tz);
}

/** When a reminder is due over the coming weeks, as instants. */
export function occurrences(reminder: Reminder, now = Date.now()): number[] {
  const today = now + offset(now, reminder.tz);
  const first = today - (today % DAY);
  const out: number[] = [];
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const day = first + i * DAY;
    if (reminder.days.includes(new Date(day).getUTCDay())) out.push(zoned(day, reminder.time, reminder.tz));
  }
  return out;
}

// --- iCalendar ---------------------------------------------------------------

const text = (s: string) =>
  s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

const stamp = (t: number) => new Date(t).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");

/** Lines longer than 75 bytes continue on the next, after a space. */
function fold(line: string): string {
  const encoder = new TextEncoder();
  let out = "";
  let bytes = 0;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    if (bytes + size > 75) {
      out += "\r\n ";
      bytes = 1;
    }
    out += ch;
    bytes += size;
  }
  return out;
}

export function remindTitle(count: number, from = "") {
  return `Revisit ${count} ${count === 1 ? "link" : "links"}${from ? ` from ${from}` : ""}`;
}

/**
 * The whole feed. `openUrl` is where a link in an event points: through
 * gitmarks, so opening it from a reminder counts as using it.
 */
export function calendar(vault: Vault, app: string, openUrl: (id: string) => string, now = Date.now()) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//gitmarks//reminders//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "NAME:gitmarks",
    "X-WR-CALNAME:gitmarks",
    "REFRESH-INTERVAL;VALUE=DURATION:PT4H",
    "X-PUBLISHED-TTL:PT4H",
  ];
  for (const reminder of vault.reminders ?? []) {
    const links = pool(vault, reminder, now);
    if (!links.length) continue;
    occurrences(reminder, now).forEach((start, k) => {
      const chosen = picks(links, reminder.count, k);
      const title = remindTitle(chosen.length, reminder.from);
      const body = chosen.map((m, i) => `${i + 1}. ${m.title}\n${openUrl(m.id)}`).join("\n\n");
      lines.push(
        "BEGIN:VEVENT",
        `UID:${reminder.id}-${stamp(start).slice(0, 8)}@gitmarks`,
        `DTSTAMP:${stamp(now)}`,
        `DTSTART:${stamp(start)}`,
        "DURATION:PT15M",
        `SUMMARY:${text(title)}`,
        `DESCRIPTION:${text(`${body}\n\nChange your reminders: ${app}`)}`,
        `URL:${app}`,
        "TRANSP:TRANSPARENT",
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        `DESCRIPTION:${text(title)}`,
        "TRIGGER:PT0M",
        "END:VALARM",
        "END:VEVENT",
      );
    });
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
