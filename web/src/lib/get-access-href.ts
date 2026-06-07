import { createSupabaseServer } from "@/lib/supabase-server";

// Auth-aware destination for the universal "Get access" CTA (header nav + footer):
// signed-in → /me/chat, signed-out → /auth/signin (the /signin route redirects here).
export async function getAccessHref(): Promise<string> {
  const supabase = await createSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  return user ? "/me/chat" : "/auth/signin";
}
