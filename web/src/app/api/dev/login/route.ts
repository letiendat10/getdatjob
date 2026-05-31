import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { createSupabaseAdmin } from "@/lib/supabase-admin";

export async function GET(request: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return new NextResponse("Not found", { status: 404 });
  }

  const { searchParams } = new URL(request.url);
  const email = searchParams.get("email") ?? process.env.DEV_USER_EMAIL;

  if (!email) {
    return new NextResponse(
      "No email — pass ?email=you@example.com or set DEV_USER_EMAIL in .env.local",
      { status: 400 }
    );
  }

  const next = searchParams.get("next") ?? "/me";

  // Generate a magic link server-side to get the one-time token
  const supabaseAdmin = createSupabaseAdmin();
  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });

  if (error || !data?.properties?.email_otp) {
    return new NextResponse(
      `Auth error: ${error?.message ?? "no email_otp"}`,
      { status: 500 }
    );
  }

  // Verify the OTP server-side and write session cookies directly onto the
  // response — browser never leaves localhost, no external redirect needed.
  const response = NextResponse.redirect(new URL(next, request.url));

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const { error: verifyError } = await supabase.auth.verifyOtp({
    email,
    token: data.properties.email_otp,
    type: "magiclink",
  });

  if (verifyError) {
    return new NextResponse(`Verify error: ${verifyError.message}`, {
      status: 500,
    });
  }

  return response;
}
