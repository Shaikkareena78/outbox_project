# ReachInbox Email Scheduler

A TypeScript monorepo for a persistent email scheduling demo. The API stores campaigns and recipients in PostgreSQL, queues individual sends in BullMQ/Redis, delivers through Ethereal SMTP, and indexes email documents in Elasticsearch. The React dashboard supports Google sign-in, CSV lead upload, scheduling, searchable status lists, and an optional Slack incoming-webhook connection.

## Requirements

- Node.js 20.19+ (or 22.12+)
- Docker Desktop with Docker Compose
- Google OAuth credentials for dashboard sign-in
- Ethereal SMTP account(s)
- A Slack app configured for incoming webhooks (optional; required to demo notifications)

## Run locally (PowerShell)

1. Start the stateful services:

   ```powershell
   docker compose up -d
   ```

   PostgreSQL, Redis (AOF persistence enabled), and Elasticsearch will be available on ports 5432, 6379, and 9200.

2. Install dependencies and configure the backend:

   ```powershell
   npm install
   npm run setup:backend
   ```

   The command creates `backend\.env` with fresh local-only session and encryption secrets, and will not overwrite an existing file. Set Google OAuth client credentials and an Ethereal SMTP login before using login or email delivery. Leave Slack credentials blank if you do not plan to connect Slack.

3. Configure Google OAuth:

   - Add `http://localhost:4000/auth/google/callback` as an authorized redirect URI in Google Cloud Console.
   - Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `backend\.env`.

4. Configure Ethereal:

   - Create an account at [Ethereal Email](https://ethereal.email/) and copy its SMTP username/password into `ETHEREAL_USER` and `ETHEREAL_PASS`.
   - To use multiple sender accounts, set `ETHEREAL_SENDERS` to a JSON array, for example:

     ```text
     ETHEREAL_SENDERS=[{"email":"sender-one@ethereal.email","user":"smtp-user-one","pass":"smtp-pass-one"},{"email":"sender-two@ethereal.email","user":"smtp-user-two","pass":"smtp-pass-two"}]
     ```

     Keep this JSON on one line and do not commit real credentials. Each selected sender is sent through its matching SMTP account.

5. Apply the checked-in database migration:

   ```powershell
   npm run db:migrate
   ```

6. Run the API, worker, and dashboard in three terminals from the project root:

   ```powershell
   npm run dev:backend
   ```

   ```powershell
   npm run dev:worker
   ```

   ```powershell
   npm run dev:frontend
   ```

   Open `http://localhost:5173`. The API listens at `http://localhost:4000`. Optionally set `frontend/.env.local` to `VITE_API_URL=http://localhost:4000` if using a non-default API URL.

### Run the dashboard with demo data

If you want to explore the UI before configuring Google OAuth or starting the backend services, run the frontend:

```powershell
npm run dev:frontend
```

Open `http://localhost:5173/?demo=1` to load a sample user, scheduled/sent/failed emails, and demo SMTP senders. The compose form adds rows to browser local storage; this mode does not contact SMTP, Redis, PostgreSQL, Elasticsearch, Google, or Slack. Remove `?demo=1` to return to real API and OAuth mode.

### View the live demo

The `main` branch contains only the built frontend output. The editable source code is on the `source` branch, which triggers the GitHub Actions deployment to Pages. Enable **Settings → Pages → Build and deployment → Source → GitHub Actions** in the repository to publish it. The site uses sample data only and does not connect to the backend:

https://shaikkareena78.github.io/outbox_project/

## Slack notifications

1. Create a Slack app and enable OAuth.
2. Add `http://localhost:4000/auth/slack/callback` to its redirect URLs, enable incoming webhooks, and add `incoming-webhook` as the OAuth scope.
3. Put the app's client ID and secret in `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET`.
4. Click **Connect Slack** while signed into the dashboard and select the destination channel in Slack's authorize flow.

The callback stores the returned incoming-webhook URL encrypted with AES-256-GCM in PostgreSQL. At the first rate-limit hit per user and sender/hour, the worker posts to that webhook. Disconnect removes the stored webhook; reconnect updates it without a redeploy.

## Architecture and behavior

- **Scheduling:** `POST /api/emails/schedule` validates the request, saves a campaign and one email row per unique recipient, and creates a delayed BullMQ job for each email. Job IDs are email IDs. The optional `Idempotency-Key` header makes request retries return the already-created campaign.
- **Persistence/restart:** PostgreSQL stores campaign/email state. Redis runs with AOF and BullMQ persists delayed jobs there. API startup reconciles scheduled DB rows with missing queue jobs, so a partially-enqueued request is recovered. Run the API and worker again after a restart; future delayed jobs keep their due times.
- **Concurrency:** Set `WORKER_CONCURRENCY` (default `10`). The worker claims a DB row conditionally before attempting delivery. A Redis Lua-backed sender throttle enforces a global minimum send-start interval per sender across worker instances.
- **Delay:** `MIN_SEND_INTERVAL_MS` defaults to **2,000 ms per sender**. The campaign's requested delay is also used to distribute initial scheduled times and can be set independently in the compose form.
- **Hourly limits:** `MAX_EMAILS_PER_HOUR_PER_SENDER` (default `200`) is the hard ceiling across all campaigns for a sender. Each campaign can apply a lower sender/hour cap of its own. Redis atomic fixed-UTC-hour counters reserve both limits across instances. When either cap is full, BullMQ moves the job to the next UTC hour boundary; it is not failed or dropped. A Redis once-per-user/sender/hour marker triggers one Slack notification; if Slack is disconnected, the marker is released so a later connection can receive the next hit without redeploying.
- **Load:** Thousands of same-time jobs remain persisted in Redis and are processed at configured concurrency. Redis throttle and hourly counters serialize sender-level capacity; work beyond the hourly allowance stays delayed in BullMQ. Actual throughput is bounded by the chosen limit and SMTP provider, not by enqueue speed.
- **Search:** Email documents are indexed in Elasticsearch on schedule and after delivery state changes. `GET /api/emails/search?q=...` searches recipient, subject, body, and sender, scoped to the signed-in user. Index failures are logged without falsely changing SMTP delivery status.
- **Queue visibility:** Bull Board is mounted at `/admin/queues` and protected by HTTP Basic Auth using `QUEUE_DASHBOARD_USER` and `QUEUE_DASHBOARD_PASSWORD`.
- **Authentication:** Google OAuth creates an HttpOnly, SameSite=Lax session cookie. Slack OAuth is a separate per-user connection. Configure `FRONTEND_URL`, CORS origin, and callback URLs consistently for production HTTPS.

### Delivery semantics and trade-offs

Queue jobs and DB rows are idempotent by email ID, and completed/failed rows are not sent again. SMTP does not provide a general exactly-once transaction with PostgreSQL: if a process dies after the SMTP server accepts a message but before the DB commit, the true outcome cannot be proven. To avoid a likely duplicate, a recovered `SENDING` row is marked failed with an explicit “outcome unknown” message and is not resent automatically. Review that state manually against Ethereal's message log.

Ethereal is a testing inbox, not a production mail provider. Do not use this sample to send unsolicited mail or put real credentials in source control. The supplied dashboard is an original implementation because no Figma URL was included with the assignment.

## API overview

- `GET /auth/google` and `GET /auth/google/callback` — Google OAuth
- `POST /auth/logout`, `GET /api/me` — session actions
- `GET /auth/slack`, `GET /auth/slack/callback`, `DELETE /api/slack` — Slack connection
- `GET /api/senders` — configured SMTP sender addresses
- `POST /api/emails/schedule` — schedule a campaign
- `GET /api/emails?status=scheduled|sent|failed` — dashboard lists
- `GET /api/emails/search?q=...` — Elasticsearch search
- `GET /health` — API, Redis, and PostgreSQL readiness
- `GET /admin/queues` — protected Bull Board UI

Example request (authenticated session cookie required):

```json
{
  "subject": "Hello there",
  "body": "A short, personalized note.",
  "sender": "sender-one@ethereal.email",
  "recipients": ["lead@example.com"],
  "startAt": "2026-12-01T10:00:00.000Z",
  "delayMs": 2000,
  "hourlyLimit": 100
}
```

## Implemented features

- **Backend:** Express/TypeScript API, PostgreSQL/Prisma persistence, BullMQ delayed jobs, restart reconciliation, per-sender concurrency-safe throttling and hourly rate limits, Slack notification webhook, Ethereal SMTP sender selection, Elasticsearch indexing/search, authenticated Bull Board.
- **Frontend:** React/TypeScript dashboard, Google OAuth login/logout, user profile, scheduled/sent/failed status views, 10-second refresh, Elasticsearch search, campaign compose modal, CSV/text email extraction and deduplication, schedule controls, Slack connect/disconnect, loading/empty/error states.

## Build

```powershell
npm run build
```

## Assignment submission checklist

This workspace contains the implementation and run instructions. Creating a private GitHub repository, granting reviewers access, recording the requested demo video, and submitting the form require your own accounts and are not automated here.
