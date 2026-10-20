# Salon Queue — backend

Walk-in queue for salons: customers sign in with a WhatsApp OTP, find the nearest salon, pick services and a stylist, join the queue and watch an honest wait estimate. The front desk runs the queue from a dashboard. Built for one pilot salon, multi-salon from day one.

**Stack:** TypeScript (Node 22), Fastify 5, PostgreSQL 15+ with PostGIS, plain SQL migrations, Zod validation, Vitest. The API contract is [`openapi.yaml`](openapi.yaml) (OpenAPI 3.1).

## Quick start

```bash
docker compose up -d                 # Postgres 16 + PostGIS (creates salon_dev and salon_test)
cp .env.example .env                 # then set JWT_SECRET and OTP_HMAC_SECRET (openssl rand -hex 32)
npm install
npm run db:migrate
npm run db:seed -- --demo-queue      # pilot salon + 4 walk-ins so screens have data
npm run dev                          # http://localhost:3000
npm test                             # 108 tests: engine, auth, queue, realtime, API contract
```

With the dev provider, OTP codes and WhatsApp messages are printed to the server log:

```
[dev-otp] +919820012345: your code is 482913 (valid 5 min)
```

## Seed data

`npm run db:seed` wipes and recreates one salon with fixed IDs (`src/seed.ts`, exported as `DEMO`), so the frontend can hard-code fixtures.

| | |
|---|---|
| Salon | `demo-salon-bandra` — Demo Salon, Bandra (19.0544, 72.8340), open 10:00–21:00 daily, Asia/Kolkata |
| Services | 8: men's/women's/kids cuts, beard trim, wash & blow-dry, global colour, root touch-up, head massage |
| Stylists | Anjali, Rahul, Farah (available), Vikram (off) — each with their own services and some per-stylist durations |
| Staff logins | `owner@demo-salon.test` (owner), `desk@demo-salon.test` (receptionist), `anjali@demo-salon.test` (stylist, linked to Anjali). Password `salon-demo-1234` (override with `SEED_STAFF_PASSWORD`) |

## How the queue works

- **Each stylist has their own line.** `wait = remaining time of the running service + Σ (duration + buffer) for everyone ahead`. The engine (`src/queue/estimator.ts`) is pure and unit-tested.
- **Durations**: a stylist's own duration for a service if set, else the service default; multi-service bookings add up. Durations are snapshotted on the entry at join time; when the owner corrects a duration, waiting customers are updated, but the price they were quoted is kept.
- **Running services** count from the actual start. An overrun is assumed to end now, and pushes everyone back once the stylist taps "+5/+10" or finishes.
- **Breaks and closures**: nothing starts before a stylist's break ends, or inside a gap in opening hours (a lunch closure is two intervals on the same day).
- **"Any available"** assigns the stylist who can start soonest (then finish soonest, then salon order). If a stylist goes off, their "any" customers move automatically; customers who asked for that stylist stay and show `stylist_available: false` so the desk can decide.
- **E Walk-In** is how customers join from the app (`e_walk_in: true` on the join request). With no `stylist_id` the salon assigns a stylist at random from those who take part in E Walk-In and can start soonest: any free stylist, otherwise whoever frees up first. With a `stylist_id` the customer asks for that stylist by name. `GET /v1/salons/{slug}/stylists?service_ids=…` returns an `e_walk_in` block (stylists free now, or `all_busy` plus the next slot for a countdown), and every entry carries `people_ahead` (clients ahead, including the one in the chair). The desk controls it with a salon switch (`PATCH /settings` with `e_walk_in_enabled`, owner or receptionist) and a per-stylist switch (`PUT /stylists/{id}/e-walk-in`, desk, or the stylist for themselves). Switching off never removes people already in line. Needs migration `002_e_walk_in.sql` (`npm run db:migrate`).
- **Every change** (join, leave, call, start, finish, extend, reorder, status, settings…) runs in one transaction holding a per-salon advisory lock, recalculates every estimate in the salon, writes them to `queue_entries.est_start_at`, and fires a Postgres `NOTIFY` that becomes an SSE push on commit.
- **Sweeper** (every 30 s): refreshes estimates as time passes, sends time-based turn alerts, and applies the no-show grace period (default: first miss → back of the line, second → no-show).
- **Estimates are shown as a range** (`wait_range_minutes`), per the risk table. The accuracy report compares the start time promised at join with the actual start: that's the pilot gate (< 10 minutes).
- **Join rules** (app joins): name set, salon open and not paused, within `join_radius_m` if the phone sent a location, one active place per customer, and start before today's closing. Walk-ins added by the desk skip the hours/pause/closing checks.

## Auth

- **Customers**: `POST /v1/auth/otp/request` → `POST /v1/auth/otp/verify` → bearer token (30 days). Codes are 6 digits, HMAC-hashed at rest, 5-minute expiry, 5 wrong tries, 30 s resend cooldown, 5 per hour per number, plus 10 requests/min per IP. Only the newest code is valid.
- **Staff**: email + password (scrypt) → bearer token (12 h). Every dashboard route resolves the salon from the URL and checks the caller's role **in that salon**: owner (everything), receptionist (queue, walk-ins, stylist status, pause joins, reports), stylist (their own customers and status).

## Messaging: OTP and WhatsApp alerts

Sign-in only talks to `OtpProvider`, the queue only talks to `Notifier` (`src/messaging/types.ts`). Choose with `OTP_PROVIDER` / `NOTIFY_PROVIDER`:

- `dev` — prints to the log, keeps an outbox for tests. Refused when `NODE_ENV=production`.
- `meta` — WhatsApp directly through Meta's Cloud API (`src/messaging/meta.ts`). Plain text on the free test number, or templates. See "WhatsApp via Meta" below.
- `vobiz` — WhatsApp templates via Vobiz's messaging API (`src/messaging/vobiz.ts`). Needs `VOBIZ_AUTH_ID`, `VOBIZ_AUTH_TOKEN`, `VOBIZ_CHANNEL_ID`, `VOBIZ_WABA_ID` and three Meta-approved templates:

| Template | Category | Variables |
|---|---|---|
| `VOBIZ_OTP_TEMPLATE` | Authentication (copy-code button) | code (body and button) |
| `VOBIZ_TURN_ALERT_TEMPLATE` | Utility | {{1}} name, {{2}} salon, {{3}} stylist, {{4}} minutes |
| `VOBIZ_CALLED_TEMPLATE` | Utility | {{1}} name, {{2}} stylist, {{3}} salon, {{4}} grace minutes |

The Vobiz adapter follows their public API docs and is unit-tested against a mocked HTTP layer, but **has not been run against a live account yet**; check the authentication-template button payload on the first real send. To add SMS later (e.g. MSG91, which needs DLT registration), implement `OtpProvider` and wrap both with `FallbackOtpProvider([whatsapp, sms])` in `src/messaging/index.ts`. A failed WhatsApp alert is logged and never rolls back a queue change.

## WhatsApp via Meta (free, for local testing)

Meta gives every developer app a free WhatsApp test number that can message up to 5 of your own phones. Messages from it cost nothing.

1. Go to [developers.facebook.com](https://developers.facebook.com), log in, **My Apps → Create app**, choose the **Business** type (or "Other → Business"), and give it any name.
2. In the app, **Add product → WhatsApp → Set up**. Meta creates a test business number for you.
3. Open **WhatsApp → API Setup**. Copy the **Temporary access token** and the **Phone number ID** (not the phone number itself).
4. Under **To**, add your own mobile number and confirm it with the code WhatsApp sends you.
5. From that phone, send any WhatsApp message (e.g. "hi") to the test number shown on the same page. This opens a 24-hour window in which plain-text messages are allowed. Do it again on another day if messages stop arriving.
6. In `.env`:
   ```
   OTP_PROVIDER=meta
   NOTIFY_PROVIDER=meta
   META_WA_ACCESS_TOKEN=<the temporary token>
   META_WA_PHONE_NUMBER_ID=<the phone number id>
   ```
7. Restart the backend (`npm run dev`) and sign in on the website with that same mobile number. The code arrives on WhatsApp.

Things to know:
- **The temporary token expires after about 24 hours.** When sign-in says "We could not send the code", check the backend terminal; it explains the cause (expired token, number not on the test list, 24-hour window closed). For a token that doesn't expire, create a System User in Meta Business Settings and generate a permanent token with the `whatsapp_business_messaging` permission.
- Only the numbers you added in step 4 can receive messages. Anyone else signing in gets a clear error; switch back to `OTP_PROVIDER=dev` to test with other numbers.
- To work without the 24-hour window (and for production), create message templates in WhatsApp Manager and set `META_WA_OTP_TEMPLATE`, `META_WA_TURN_ALERT_TEMPLATE` and `META_WA_CALLED_TEMPLATE`. They use the same variables as the Vobiz templates below.
- Going live on Meta directly (instead of Vobiz) also needs a verified business and your own phone number. The code is the same either way; only the settings change.

## Multi-salon

A salon is data, never code. Every salon-owned table carries `salon_id`, and cross-table references use composite `(id, salon_id)` foreign keys, so the database itself refuses an entry that points at another salon's stylist or service. Queries are always scoped by the salon resolved from the URL. Adding salon number two means inserting rows (salon, hours, services, stylists, staff + memberships); no deploy. There's no super-admin UI yet; `src/seed.ts` shows the inserts.

## For the frontend

- Build against `openapi.yaml`. It's enforced: a test fails if a server route is missing from the spec (or vice versa), and integration tests validate real responses against the spec's schemas.
- Customer routes: `/s/{slug}` for the salon, e.g. a QR code at the desk. Dashboard: `/dashboard/{slug}`.
- **Live updates**: `new EventSource('/v1/salons/{slug}/events')`. Each `queue` event means "something changed"; refetch `GET /v1/queue/{entryId}` (customer) or `GET /v1/dashboard/{slug}` (desk). The stream is public and carries no personal data, so no auth header is needed.
- On app start, `GET /v1/me/queue` tells a returning customer whether they're already in a queue.
- Errors are always `{ error: { code, message, details } }`; the codes are listed per endpoint in the spec.
- Money is in paise; times are UTC ISO strings; opening hours are salon-local `HH:MM`.

## Project layout

```
migrations/001_init.sql      schema (PostGIS, composite tenant keys, partial unique indexes)
src/queue/estimator.ts       pure wait-time engine
src/queue/state.ts           loads a salon's queue and runs the engine
src/queue/service.ts         every queue mutation (lock → change → recalc → notify → messages)
src/queue/sweeper.ts         no-show grace, time-based alerts, periodic refresh
src/auth/                    OTP service, staff passwords, role guards
src/messaging/               provider interfaces, dev stub, Vobiz WhatsApp adapter
src/routes/                  HTTP: auth, salons (public + SSE), customer queue, dashboard
src/realtime.ts              LISTEN/NOTIFY → SSE fan-out
src/seed.ts                  demo salon
tests/                       unit, integration (real Postgres), contract
```

## Deployment notes

- Needs a **long-running Node process** (SSE connections, the 30 s sweeper, a LISTEN connection), so host the API on Railway, Render, Fly.io or similar, not as Vercel serverless functions. The Next.js frontend can still live on Vercel.
- Database: any Postgres 15+ with PostGIS (Supabase and Neon both work). Several API instances are fine: queue changes are serialised per salon with advisory locks and NOTIFY reaches every instance. Use a direct (non-pooled) connection string, or at least session pooling, because LISTEN and advisory locks need it.
- Migrations are forward-only (`npm run db:migrate`); add a new numbered file for each change. `db:reset` and the demo seed refuse to run with `NODE_ENV=production`.
- Personal data kept to a minimum: phone and name for customers, masked phones on staff screens, OTP codes hashed. DPDP consent text and a delete-my-data endpoint are still to do.

## Not done yet

- Vobiz adapter untested against a live account; WhatsApp delivery webhooks not handled.
- One customer in the chair per stylist (enforced by a unique index). If the pilot salon has stylists working two chairs while colour processes, that needs a model change.
- No payments (phase 2), no daily summary UI beyond the accuracy report, no super-admin onboarding, no customer data export/deletion endpoint.
