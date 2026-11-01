import type { APIRoute } from "astro";
import { calendarOwner, keyIsCurrent } from "@/lib/owner";
import { loadVault, performRequest } from "@/lib/server";
import { usedToday } from "@/lib/vault";

/**
 * A link in a reminder goes through here on its way out, so opening it counts
 * as using it, as it does in the app, and keeps it out of the archive. Only to
 * a link in the vault: this never redirects anywhere a request names.
 */
export const GET: APIRoute = async ({ url }) => {
  const me = await calendarOwner(url.searchParams.get("key")).catch(() => null);
  if (!me) return new Response("Not found", { status: 404 });
  try {
    const { vault } = await loadVault(me.store);
    const mark = keyIsCurrent(me, vault) && vault.marks.find((m) => m.id === url.searchParams.get("id"));
    if (!mark) return new Response("Not found", { status: 404 });
    // Once a day is plenty, as in the app: each touch is a commit.
    if (!usedToday(mark)) await performRequest(me.store, { type: "touch", ids: [mark.id] });
    return new Response(null, { status: 302, headers: { Location: mark.url, "Cache-Control": "no-store" } });
  } catch {
    return new Response("Could not load the vault.", { status: 502 });
  }
};
