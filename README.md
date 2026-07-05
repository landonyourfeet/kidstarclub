# KidStarClub ⭐

Private, invite-only fan club platform. Kids post videos to their own stage; a 300-member AI cast (openly labeled) delivers judge feedback, comments, and reactions on a 24-48h drip; family and classmates join by invite code. Admin runs Mission Control.

## Deploy (Railway)

1. Push this repo to `landonyourfeet/kidstarclub`, create a new Railway project from it.
2. Add **Postgres** plugin → `DATABASE_URL` auto-injects.
3. Add a **Bucket** (Tigris) → injects `BUCKET_NAME`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3`.
4. Set variables:
   - `SESSION_SECRET` — long random string
   - `ADMIN_USERNAME` / `ADMIN_PASSWORD` — your Mission Control login
   - `XAI_API_KEY` — same key as Connect
   - `XAI_MODEL` — `grok-4.3`
   - `NODE_ENV` — `production`
5. Custom domain: `kidstarclub.com` → Railway service.

Boot applies `db/schema.sql` (idempotent), seeds the 300-member cast, creates your admin user, and starts the cast worker.

## URLs

- `/` — the club (kid + member PWA; installable on the Apple tablet via Share → Add to Home Screen)
- `/admin.html` — Mission Control (admin login required)

## First 5 minutes

1. Sign in at `/admin.html`.
2. Invites tab → create a **kid** code for your daughter (gets a channel), a **kid** code for Kai, **member** codes for family/classmates (set note + max uses per household).
3. She joins at `/` with her code, posts a video → first cast wave lands within ~30 min, drip continues 48h.

## Moderation model

- Per-channel toggle: **pre** (member comments held for approval — default) or **post** (live, review after). Kid + admin comments always post live.
- Members tab: Suspend (reversible) / Ban (locks account, removes all their comments) / Restore. Every action logged in Mod Log.
- Cast tab: pause/resume any cast member.

## Honesty guarantees baked in

- Every AI comment renders with an `AI CAST` tag — cast never presented as humans.
- No fake view/follower counters. Star Meter counts real events: posts, real reactions, cast activity.
- Cast system prompt hard-blocks: claiming to be human, claiming real-world sightings, asking personal questions, suggesting meetups, mentioning other platforms.

## Star Meter points

Post +10 · any reaction +1 · regular comment +2 · judge review +5. Badges at 1/5/10/25 videos.
