import type { APIRoute } from "astro";
import { keyFor, keyIsCurrent, owner } from "@/lib/owner";
import { loadVault, performRequest } from "@/lib/server";
import { categoryTree, parseRequest } from "@/lib/vault";

const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "private, no-store" } });

// Anyone else, a reset key included, gets the same 404 as a route that does not exist.
const notFound = () => new Response("Not found", { status: 404 });

const fail = (error: unknown, fallback: string) =>
  json({ ok: false, error: error instanceof Error ? error.message : fallback }, 502);

export const GET: APIRoute = async ({ request, cookies, url }) => {
  try {
    const me = await owner(request, cookies);
    if (!me) return notFound();
    const { vault } = await loadVault(me.store);
    if (!keyIsCurrent(me, vault)) return notFound();
    // `?list=categories` feeds the phone Shortcut's picker: a bare JSON array
    // goes straight into "Choose from List". Folders come right after their parent.
    if (url.searchParams.get("list") === "categories") {
      return json(["Inbox", ...categoryTree(vault).map((c) => c.name)]);
    }
    return json({ ok: true, vault });
  } catch (error) {
    return fail(error, "Load failed.");
  }
};

export const POST: APIRoute = async ({ request, cookies }) => {
  try {
    const me = await owner(request, cookies);
    if (!me) return notFound();
    const parsed = parseRequest(await request.json().catch(() => null));
    if (!parsed) return json({ ok: false, error: "Bad request." }, 400);
    // ponytail: one extra read per save from a device, to check its key first. Fold
    // the check into the write's own read if that second ever matters.
    if (me.viaKey && !keyIsCurrent(me, (await loadVault(me.store)).vault)) return notFound();
    // Only the signed-in page can reset the key: a leaked key must not be able
    // to lock its owner out by resetting it.
    if (parsed.type === "resetKey" && me.viaKey) return notFound();
    const result = await performRequest(me.store, parsed);
    if (result.ok && parsed.type === "resetKey") return json({ ...result, key: keyFor(me, result.vault) });
    return json(result, result.ok ? 200 : 502);
  } catch (error) {
    return fail(error, "Save failed.");
  }
};
