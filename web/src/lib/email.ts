import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

const TIER_NAMES: Record<string, string> = {
  passed: "Passed",
  preferred: "Preferred",
};

const TIER_FEATURES: Record<string, string[]> = {
  passed: [
    "Unlimited job matches",
    "USCIS-verified sponsorship data",
    "Sponsorship history (LCA count, last filed)",
    "All visa types (H-1B, OPT, E-3/TN)",
    "Verified company point of contact",
  ],
  preferred: [
    "Everything in Passed",
    "Daily job alerts",
    '"I just got laid off" action plan',
    "Salary benchmarking data",
  ],
};

export async function sendSubscriptionConfirmation({
  email,
  tier,
  trialEndDate,
}: {
  email: string;
  tier: "passed" | "preferred";
  trialEndDate: Date;
}) {
  const tierName = TIER_NAMES[tier] ?? tier;
  const features = TIER_FEATURES[tier] ?? [];
  const trialEndStr = trialEndDate.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const featureList = features.map((f) => `<li style="margin-bottom:4px">${f}</li>`).join("");

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#F4F0E8;margin:0;padding:40px 20px;color:#171614">
  <div style="max-width:480px;margin:0 auto;background:#FAF7F0;border-radius:16px;padding:32px;border:1px solid #D9D2C2">
    <p style="font-size:13px;color:#6F6A60;margin:0 0 24px">getdatjob</p>
    <h1 style="font-size:22px;font-weight:700;margin:0 0 8px;color:#171614">You're in — ${tierName} access confirmed.</h1>
    <p style="font-size:14px;color:#3A3833;margin:0 0 24px">Your 7-day free trial started. Here's what's unlocked:</p>
    <ul style="font-size:14px;color:#3A3833;padding-left:20px;margin:0 0 24px">
      ${featureList}
    </ul>
    <p style="font-size:13px;color:#6F6A60;margin:0 0 24px">
      Trial ends: <strong>${trialEndStr}</strong>.<br>
      You applied promo code <strong>WORKINGVISA</strong> — your first 3 months are free.
    </p>
    <a href="${process.env.NEXT_PUBLIC_SITE_URL ?? "https://getdatjob.com"}/me?tab=matches" style="display:inline-block;background:#1F3A2E;color:#F4F0E8;padding:12px 24px;border-radius:10px;font-size:14px;font-weight:600;text-decoration:none">View my matches →</a>
    <p style="font-size:12px;color:#6F6A60;margin:24px 0 0">
      Manage your subscription at any time at <a href="${process.env.NEXT_PUBLIC_SITE_URL ?? "https://getdatjob.com"}/me" style="color:#1F3A2E">getdatjob.com/me</a>.
    </p>
  </div>
</body>
</html>
  `.trim();

  await resend.emails.send({
    from: "Kai @ getdatjob <invoice@getdatjob.app>",
    to: email,
    subject: `You're in — ${tierName} access confirmed.`,
    html,
  });
}
