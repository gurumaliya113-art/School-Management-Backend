# School Management – Backend

Express + Supabase (Postgres) API. Deploy on Render (uses `render.yaml`) or Railway (uses `railway.json`).

Required environment variables (see `.env.example`):

- `DATABASE_URL` – Supabase **Session pooler** connection string
- `FEE_HMAC_SECRET` – 96-char random secret; never change it after first use
- `ADMIN_PASSWORD` – first admin login password
- `NODE_ENV=production`, `SERVE_FRONTEND=false`

Tables are created automatically on first start. Health check: `/api/health`.

Local run: copy `.env.example` to `.env`, fill it, then `npm install` and `npm start`.
