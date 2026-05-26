import { loadMeta } from "@/lib/load-meta";

export async function GET() {
  const data = await loadMeta();
  return Response.json(data, {
    headers: {
      "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=120",
    },
  });
}
