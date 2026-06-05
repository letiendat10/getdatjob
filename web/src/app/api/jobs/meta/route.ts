import { loadMeta } from "@/lib/load-meta";

// Render per-request — without this the handler is statically baked at build time, which
// froze an empty RPC result (departments:[]/companies:[]). The Cache-Control below still
// gives a 30-min shared edge cache, so this stays cheap.
export const dynamic = "force-dynamic";

export async function GET() {
  const data = await loadMeta();
  return Response.json(data, {
    headers: {
      "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=120",
    },
  });
}
