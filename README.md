# LLM Credit Gateway

MVP API gateway LLM berbasis Cloudflare Pages, Workers, dan D1. Gateway menerbitkan API key virtual, membatasi model, melakukan reservasi kredit, mencatat token, dan menyediakan dashboard admin.

## Fitur yang sudah diimplementasikan

- OpenAI-compatible `POST /v1/chat/completions`
- `GET /v1/models`, `/v1/me`, `/v1/usage`, `/v1/credits`
- API key virtual yang hanya disimpan sebagai SHA-256 hash
- Provider secret melalui Worker Secret
- Saldo credit integer, ledger immutable, dan reservation
- Limit harian dan bulanan
- Model access per user
- Non-streaming dan streaming SSE
- Dashboard admin: overview, user, top-up/deduction, key, model, dan request log
- Audit log dan daily aggregate
- CORS allowlist

## Struktur

```text
apps/worker  Cloudflare Worker + D1 migrations
apps/web     React/Vite dashboard untuk Cloudflare Pages
```

## 1. Instalasi

```bash
npm install
```

## 2. Buat database D1

```bash
cd apps/worker
npx wrangler d1 create llm-credit-gateway
```

Salin `database_id` ke `apps/worker/wrangler.jsonc`.

## 3. Migrasi lokal

```bash
npm run db:migrate:local
```

## 4. Secret lokal

Salin:

```bash
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
```

Isi `ADMIN_TOKEN`, `SESSION_SECRET`, dan provider key.

Untuk production:

```bash
cd apps/worker
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put SESSION_SECRET
npx wrangler secret put DEEPSEEK_API_KEY
```

## 5. Jalankan

Terminal 1:

```bash
npm run dev:worker
```

Terminal 2:

```bash
npm run dev:web
```

Dashboard lokal memakai `http://localhost:8787` sebagai API default. Masukkan `ADMIN_TOKEN` pada layar login.

## 6. Seed data

Setelah Worker berjalan, buat model melalui dashboard atau API admin. Contoh provider/model awal dapat dimasukkan dengan:

```bash
curl -X POST http://localhost:8787/admin/models \
  -H "Authorization: Bearer change-me-admin-token" \
  -H "Content-Type: application/json" \
  -d '{
    "publicName":"deepseek-chat",
    "providerType":"openai-compatible",
    "baseUrl":"https://api.deepseek.com",
    "secretBindingName":"DEEPSEEK_API_KEY",
    "upstreamModel":"deepseek-chat",
    "inputPricePerMillion":100000,
    "outputPricePerMillion":200000,
    "maxOutputTokens":4096
  }'
```

Nilai harga memakai **micro-credit per satu juta token**. Sesuaikan dengan kebijakan internal dan harga provider terkini.

## 7. Contoh membuat user

```bash
curl -X POST http://localhost:8787/admin/users \
  -H "Authorization: Bearer change-me-admin-token" \
  -H "Content-Type: application/json" \
  -d '{"name":"Santri 01","username":"santri01","initialCredit":1000000,"dailyCreditLimit":100000}'
```

## 8. Contoh memakai gateway

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer lgw_live_xxx" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: demo-001" \
  -d '{
    "model":"deepseek-chat",
    "messages":[{"role":"user","content":"Halo"}],
    "max_tokens":300
  }'
```

## Catatan MVP

- Estimasi input memakai pendekatan karakter/3. Ini konservatif, bukan tokenizer resmi.
- Streaming diselesaikan dari usage chunk provider. Bila provider tidak mengirim usage, sistem memakai biaya reservation sebagai estimasi konservatif.
- D1 `batch()` dipakai untuk operasi saldo yang harus atomik.
- `ADMIN_TOKEN` cocok untuk deployment privat awal. Sebelum menjadi SaaS publik, ganti dengan login session dan identity provider yang lebih lengkap.
