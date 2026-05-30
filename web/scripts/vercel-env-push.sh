#!/bin/bash
# Pushes all Stripe/Resend/paywall env vars to Vercel production
# Run from: /Users/dat/getdatjob/web

set -e
cd "$(dirname "$0")/.."

ENV_FILE=".env.local"

# Keys to push to Vercel (production)
KEYS=(
  STRIPE_SECRET_KEY
  STRIPE_WEBHOOK_SECRET
  STRIPE_PROMO_CODE_ID
  STRIPE_PRICE_PASSED_MONTHLY
  STRIPE_PRICE_PASSED_ANNUAL
  STRIPE_PRICE_PREFERRED_MONTHLY
  STRIPE_PRICE_PREFERRED_ANNUAL
  RESEND_API_KEY
  NEXT_PUBLIC_PAYWALL_PAGE
  NEXT_PUBLIC_SITE_URL
)

for KEY in "${KEYS[@]}"; do
  # Extract value from .env.local
  VALUE=$(grep "^${KEY}=" "$ENV_FILE" | cut -d= -f2-)
  if [ -z "$VALUE" ]; then
    echo "⚠️  $KEY not found in .env.local — skipping"
    continue
  fi
  # Add to Vercel (production + preview); --yes skips confirmation
  printf "%s" "$VALUE" | vercel env add "$KEY" production --yes 2>/dev/null && \
    echo "✓ $KEY" || echo "  (already exists, skipping) $KEY"
done

echo ""
echo "Done. Run 'vercel deploy --prod' to trigger a new deployment."
