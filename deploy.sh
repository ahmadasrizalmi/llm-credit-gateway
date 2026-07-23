#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# Deploy Script for LLM Credit Gateway
# Jalankan: bash deploy.sh
# ============================================================

echo "=== 1. Push ke GitHub ==="
read -rp "GitHub token: " GH_TOKEN
read -rp "GitHub username: " GH_USER
REPO="llm-credit-gateway"

# Create repo via API
curl -s -H "Authorization: token $GH_TOKEN" \
  -d "{\"name\":\"$REPO\",\"private\":false}" \
  https://api.github.com/user/repos | jq .html_url

git remote add origin "https://$GH_TOKEN@github.com/$GH_USER/$REPO.git"
git push -u origin main

echo ""
echo "=== 2. Deploy Worker ke Cloudflare ==="
read -rp "Cloudflare API Token: " CF_TOKEN

# Login via wrangler dengan token
npx wrangler login --token "$CF_TOKEN" 2>/dev/null || true

cd apps/worker

echo ""
echo "=== 3. Setup D1 Database ==="
D1_OUTPUT=$(npx wrangler d1 create llm-credit-gateway 2>&1)
DB_ID=$(echo "$D1_OUTPUT" | grep -oP 'database_id:\s*\K[a-f0-9-]+' || echo "")
if [ -n "$DB_ID" ]; then
  echo "Database ID: $DB_ID"
  # Update wrangler.jsonc
  sed -i "s/REPLACE_WITH_D1_DATABASE_ID/$DB_ID/g" wrangler.jsonc
  npx wrangler d1 migrations apply DB --remote
else
  echo "D1 database mungkin sudah ada. Pastikan database_id di wrangler.jsonc sudah diisi."
  echo "Output: $D1_OUTPUT"
fi

echo ""
echo "=== 4. Set Secrets ==="
echo "Set ADMIN_TOKEN..."
echo "change-me-admin-token" | npx wrangler secret put ADMIN_TOKEN --token "$CF_TOKEN"
echo "Set SESSION_SECRET..."
openssl rand -hex 32 | npx wrangler secret put SESSION_SECRET --token "$CF_TOKEN"
echo "Set DEEPSEEK_API_KEY..."
read -rsp "Deepseek API Key: " DS_KEY
echo ""
echo "$DS_KEY" | npx wrangler secret put DEEPSEEK_API_KEY --token "$CF_TOKEN"

echo ""
echo "=== 5. Deploy Worker ==="
npx wrangler deploy --token "$CF_TOKEN"

echo ""
echo "=== 6. Deploy Dashboard ke Cloudflare Pages ==="
cd ../web
npm run build
npx wrangler pages deploy dist --project-name=llm-credit-gateway-dashboard --token "$CF_TOKEN"

echo ""
echo "=== SELESAI ==="
echo "Worker URL: https://llm-credit-gateway-api.<your-subdomain>.workers.dev"
echo "Dashboard URL: https://llm-credit-gateway-dashboard.pages.dev"
