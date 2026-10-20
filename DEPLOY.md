# Putting Kataar online (Render + Vercel)

```
Frontend/  ->  Vercel   (the website)
Backend/   ->  Render   (the API + a Postgres database with PostGIS)
```

This setup is a **demo deployment**. No WhatsApp is connected, so the sign-in code is shown on the page. Anyone who opens the site can sign in as any phone number, so don't put real customers on it yet.

## 1. Put the code on GitHub

Your folder is already a Git repository. One fix first: `Backend` also has its own hidden `.git` folder, so Git treats it as a separate project and would push only an empty link instead of your code (Render would then find nothing to build). Remove that folder, then commit everything. In Git Bash:

```bash
cd /d/HairSalonScheduler
rm -rf Backend/.git
git rm --cached Backend
git add .
git status
git commit -m "Add Render and Vercel deployment files, demo-mode sign-in code"
git push -u origin master
```

Read the `git status` list before committing: `.env`, `.env.local` and `node_modules` must not appear (they are ignored, so your secrets stay on your computer). If `git push` complains, paste the message to Claude.

## 2. API and database on Render

1. render.com -> **New** -> **Blueprint** -> connect GitHub and pick the repository.
2. Render reads `render.yaml` and shows a database (`kataar-db`) and a web service (`kataar-api`).
3. It asks for `SEED_STAFF_PASSWORD`. Type a password of at least 8 characters. This is the password for `owner@demo-salon.test`, `desk@demo-salon.test` and `anjali@demo-salon.test`. Do not reuse a real password.
4. Click **Apply**. The first build takes a few minutes.
5. When the service says **Live**, open `https://<your-service>.onrender.com/health`. You should see `{"ok":true,...}`. Copy the service address; you need it next.

On first start the API creates the tables and the demo salon by itself.

## 3. Website on Vercel

1. vercel.com -> **Add New** -> **Project** -> import the same repository.
2. Set **Root Directory** to `Frontend`. Vercel detects Next.js; leave the build settings alone.
3. Under **Environment Variables** add:
   - `NEXT_PUBLIC_API_URL` = the Render address from step 2 (for example `https://kataar-api.onrender.com`, no trailing slash).
4. Click **Deploy**. If you change this variable later, redeploy: it is baked in at build time.

## 4. Lock the API to your website (recommended)

In Render -> `kataar-api` -> **Environment**, change `CORS_ORIGINS` from `*` to your Vercel address (for example `https://kataar.vercel.app`). Several addresses can be separated with commas. Save; Render restarts the API.

## 5. Try it

- Customer app: your Vercel address. Enter any Indian mobile number; the code appears in a box on the next screen.
- Dashboard: `<vercel address>/staff/login` with `desk@demo-salon.test` and the password from step 2.
- Joining the queue needs the phone to be within the salon's join radius (3 km of Bandra). Sign in as `owner@demo-salon.test`, open Settings, and raise the radius while testing from elsewhere.

## Free-plan limits to know about

- **The API sleeps** after 15 minutes without traffic. The first visit afterwards waits about a minute; the live "Live" indicator reconnects by itself. While it sleeps, no-show timers and "your turn is near" checks don't run. A paid instance stays awake.
- **The free database is deleted 30 days after creation** (Render gives a 14-day grace period) and has no backups. Upgrade the database in Render before then if the data matters.
- Free services get 750 instance hours a month in total.

## Before real customers

1. Connect a real message provider (`OTP_PROVIDER` and `NOTIFY_PROVIDER` = `meta` or `vobiz`, with their settings from `Backend/.env.example`).
2. Remove `DEMO_MODE` and `SEED_STAFF_PASSWORD`. The API then refuses to start with the dev provider, which is the safety net.
3. Create the real salon and staff accounts and delete the demo logins.
4. Move the database off the free plan and set `CORS_ORIGINS` to your real domain.

## If the deploy fails

- **`getaddrinfo ENOTFOUND dpg-...`** in the API's logs: the database and the API are in different Render regions, so the API cannot find the database. Both must use the same region (`render.yaml` sets `singapore` for both). A region cannot be changed after creation: delete the database and the API in Render (Dashboard -> the service -> Settings -> Delete), then create the Blueprint again.
