import type { APIRoute } from "astro";
import { calendarOwner, keyIsCurrent } from "@/lib/owner";
import { calendar } from "@/lib/remind";
import { loadVault } from "@/lib/server";

/**
 * The reminders feed a calendar app subscribes to. The key in the link is
 * the only proof, as calendar apps send nothing else; a wrong or reset one
 * gets the same 404 as a route that does not exist.
 */
export const GET: APIRoute = async ({ url }) => {
  const key = url.searchParams.get("key");
  const me = await calendarOwner(key).catch(() => null);
  if (!me) return new Response("Not found", { status: 404 });
  try {
    const { vault } = await loadVault(me.store);
    if (!keyIsCurrent(me, vault)) return new Response("Not found", { status: 404 });
    const open = (id: string) =>
      `${url.origin}/api/open?key=${encodeURIComponent(key!)}&id=${encodeURIComponent(id)}`;
    return new Response(calendar(vault, url.origin, open), {
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": 'inline; filename="gitmarks.ics"',
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return new Response("Could not load the vault.", { status: 502 });
  }
};
