import { NextRequest } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase-admin";
import { enrichLinkedInProfile } from "@/lib/enrich-linkedin";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-enrich-secret");
  if (!process.env.ENRICH_SECRET || secret !== process.env.ENRICH_SECRET) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { userId, fullName, linkedinUrl } = body as {
    userId: string;
    fullName: string | null;
    linkedinUrl: string | null;
  };
  if (!userId) {
    return Response.json({ error: "userId required" }, { status: 400 });
  }

  const supabase = createSupabaseAdmin();

  // Ensure pending row exists
  await supabase
    .schema("enriched")
    .from("profiles")
    .upsert({ id: userId, status: "pending" }, { onConflict: "id" });

  const { status, data } = await enrichLinkedInProfile(fullName, linkedinUrl ?? null);

  await supabase
    .schema("enriched")
    .from("profiles")
    .update({ status, ...data, enriched_at: new Date().toISOString() })
    .eq("id", userId);

  return Response.json({ status });
}
