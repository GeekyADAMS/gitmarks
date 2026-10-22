import type { APIRoute } from "astro";
import { owner } from "@/lib/owner";
import { loadVault, performRequest } from "@/lib/server";
import { parseRequest } from "@/lib/vault";

const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "private, no-store" } });

// Anyone else gets the same 404 as a route that does not exist.
const notFound = () => new Response("Not found", { status: 404 });

const fail = (error: unknown, fallback: string) =>
  json({ ok: false, error: error instanceof Error ? error.message : fallback }, 502);

export const GET: APIRoute = async ({ request, cookies, url }) => {
  try {
    const me = await owner(request, cookies);
    if (!me) return notFound();
    const { vault } = await loadVault(me.store);
    // `?list=categories` feeds the phone Shortcut's picker: a bare JSON array
    // goes straight into "Choose from List".
    if (url.searchParams.get("list") === "categories") return json(["Inbox", ...vault.categories]);
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
    const result = await performRequest(me.store, parsed);
    return json(result, result.ok ? 200 : 502);
  } catch (error) {
    return fail(error, "Save failed.");
  }
};
