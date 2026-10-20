# Hair Salon Scheduler (Kataar)

Walk-in queue for salons. Customers join from their phone and watch a live wait estimate; the front desk runs the queue from a tablet.

```
Backend/    API + database (Node, Fastify, Postgres/PostGIS)   → http://localhost:3000
Frontend/   Website: customer app + salon dashboard (Next.js)  → http://localhost:3001
```

## Run everything on your computer (Windows)

You need **Node.js 22 or newer** (nodejs.org, the LTS button) and **Docker Desktop** (docker.com). Open Docker Desktop and wait until it says the engine is running.

1. **Double-click `setup.cmd`** (once). It checks Node and Docker, creates the settings files with fresh secrets, starts the database, installs everything and loads the demo salon. The first run takes a few minutes.
2. **Double-click `start.cmd`** (every time). It opens two windows, "Kataar backend" and "Kataar website", and then the app in your browser.
3. To stop, close those two windows. `reset-demo-data.cmd` puts the demo salon and queue back to the start.

If a step fails, the window says what went wrong in red. Send that text to Claude.

**Try it**

- Customer app: http://localhost:3001. Sign in with any Indian mobile number; the 6-digit code appears in the "Kataar backend" window.
- Dashboard: http://localhost:3001/staff/login with `desk@demo-salon.test` / `salon-demo-1234` (also `owner@…` and `anjali@…`).

Open the dashboard and the customer app side by side (use a private window for one of them): calling a customer on the dashboard updates their screen immediately.

<details>
<summary>Doing it by hand instead</summary>

```powershell
cd D:\HairSalonScheduler\Backend
docker compose up -d
copy .env.example .env      # then set JWT_SECRET and OTP_HMAC_SECRET to two long random strings
npm install
npm run db:migrate
npm run db:seed -- --demo-queue
npm run dev                 # leave running

# second window
cd D:\HairSalonScheduler\Frontend
copy .env.example .env.local
npm install
npm run dev                 # then open http://localhost:3001
```
</details>

## Tests

- Backend: `npm test` in `Backend` (108 tests; needs the Docker database running).
- Frontend: `npm run build` in `Frontend`, and the browser walkthrough in `Frontend/README.md`.

## Before putting it online

See the "Deployment notes" in `Backend/README.md`. In short: the API needs an always-on host (Railway, Render, Fly), the database needs PostGIS (Supabase or Neon), the website can go on Vercel, and WhatsApp needs the three Meta-approved templates through Vobiz.
