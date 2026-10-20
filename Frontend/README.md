# Kataar — frontend

The website for the salon queue: the customer app (phone) and the salon dashboard (tablet), in one Next.js app. Everything it shows comes from the backend in `../Backend`; there is no data in the frontend itself.

**Stack:** Next.js 16 (App Router, all client components), React 19, Tailwind CSS 4, TanStack Query, Leaflet + OpenStreetMap for the map. API types are generated from `../Backend/openapi.yaml`.

"Kataar" (queue, in Hindi) is a working name. It's set in `src/lib/format.ts` (`APP_NAME`), `src/app/layout.tsx` and `public/manifest.webmanifest`.

## Run it

The backend must be running first (see the root README). Then:

```bash
npm install
copy .env.example .env.local      # macOS/Linux: cp .env.example .env.local
npm run dev                       # http://localhost:3001
```

`.env.local` has one setting, `NEXT_PUBLIC_API_URL` (default `http://localhost:3000`).

## Pages

| URL | Who | What |
|---|---|---|
| `/` | Customer | Sends you to wherever you left off (sign in, your queue, or salons) |
| `/login` | Customer | Phone number, then the 6-digit WhatsApp code |
| `/name` | Customer | Asked once for new customers |
| `/salons` | Customer | Map and list, nearest first; plain list if location is off |
| `/s/{slug}` | Customer | Service menu (the QR code at the desk should point here) |
| `/s/{slug}/stylist?services=…` | Customer | E Walk-In: "Assign me a stylist" (random) or pick one by name. Live countdown to the next slot and how many clients are ahead; Join |
| `/queue/{id}` | Customer | Live status: waiting (E Walk-In shows a countdown and clients ahead), you're next, called (with countdown), in the chair, done, left, no-show |
| `/staff/login` | Staff | Email and password |
| `/dashboard/{slug}` | Staff | Live queue and stylist board, with an E Walk-In switch for the salon, a "Takes E Walk-In" switch per stylist, and an E Walk-In filter on the queue. Stylists see only their own customers |
| `/dashboard/{slug}/settings` | Owner (others read-only) | Services, stylists and their durations, opening hours and holidays, queue settings |
| `/dashboard/{slug}/report` | Owner, receptionist | Daily wait-estimate accuracy |

Demo logins (from the backend seed): `owner@demo-salon.test`, `desk@demo-salon.test`, `anjali@demo-salon.test`, password `salon-demo-1234`. In development the customer's OTP code is printed in the backend terminal.

## How it talks to the backend

- `src/lib/api.ts` — one `api()` fetch helper. Errors arrive as `ApiError` with the backend's `code` and a message that's safe to show.
- `src/lib/api-types.ts` — generated; run `npm run api:types` after changing `../Backend/openapi.yaml`.
- `src/lib/hooks.ts` — `useSalonEvents(slug, keys)` opens the backend's live stream and refetches those queries on every change. Screens also refetch every 30 s as a fallback.
- `src/lib/session.ts` — customer and staff tokens in localStorage, kept separate so one tablet can do both.

## Design

Colours, type and components live in `src/app/globals.css` (tokens, light and dark) and `src/components/ui.tsx`. Waits are always shown as a range with the estimated time underneath (`WaitDisplay`), and stylist status is shown with an icon and a label, never colour alone. If you design screens in Claude Design, the tokens and components are the place to apply them.

## End-to-end test

`e2e/smoke.mjs` drives a real browser through the whole flow: sign in, join, desk calls and serves the customer (checking the phone updates live), walk-ins, breaks, settings, report, stylist view, leaving, and dark mode. It saves screenshots in `e2e/screenshots/`.

```bash
npx playwright install chromium          # once
# with the backend (logging to a file) and the frontend running, and a fresh demo seed:
node e2e/smoke.mjs ../Backend/api.log
```

## Testing on your phone

Open `http://<your-computer's-IP>:3001` on a phone on the same Wi-Fi, after setting `NEXT_PUBLIC_API_URL=http://<your-computer's-IP>:3000` in `.env.local` and adding `http://<your-computer's-IP>:3001` to `CORS_ORIGINS` in the backend `.env`. Browsers only share location over HTTPS or on localhost, so on the phone the salon list shows without the map; everything else works.
