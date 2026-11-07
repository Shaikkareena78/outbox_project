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

4. Configure Ethereal as described in [Environment variables and Ethereal SMTP](#environment-variables-and-ethereal-smtp). Keep all credentials local; do not commit them.

5. Apply the checked-in database migration:

   ```powershell
   npm run db:migrate
   ```

6. Run the Express API, BullMQ worker, and frontend in three separate terminals from the project root:

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

   Confirm the API, PostgreSQL, and Redis are ready at `http://localhost:4000/health`. Elasticsearch is used for search indexing; its service is started by Docker Compose.

### Environment variables and Ethereal SMTP

`npm run setup:backend` copies `backend/.env.example` to `backend/.env` and generates fresh session and encryption secrets. It deliberately does not overwrite an existing `.env`. The backend validates configuration at startup; keep `.env` local and never commit real credentials.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string; defaults to the local Compose database. |
| `REDIS_URL` | Redis connection for BullMQ and atomic sender limits. |
| `ELASTICSEARCH_URL`, `ELASTICSEARCH_INDEX` | Elasticsearch endpoint and index used for email search. |
| `SESSION_SECRET` | At least 32 characters; signs login sessions. |
| `TOKEN_ENCRYPTION_KEY` | Exactly 64 hexadecimal characters (32 bytes); encrypts stored Slack webhook tokens. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth credentials; required for real dashboard login. |
| `GOOGLE_CALLBACK_URL` | OAuth callback; register `http://localhost:4000/auth/google/callback` in Google Cloud Console. |
| `ETHEREAL_HOST`, `ETHEREAL_PORT` | SMTP host and port; defaults to `smtp.ethereal.email:587`. |
| `ETHEREAL_USER`, `ETHEREAL_PASS` | Default Ethereal SMTP account credentials. |
| `ETHEREAL_SENDERS` | Optional one-line JSON array of sender-specific SMTP accounts (see example below). |
| `EMAIL_FROM` | Fallback display name/address for the SMTP message. |
| `WORKER_CONCURRENCY` | Maximum simultaneous BullMQ jobs per worker process; defaults to `10`. |
| `MIN_SEND_INTERVAL_MS` | Minimum time between send starts per sender; defaults to `2000` ms. |
| `MAX_EMAILS_PER_HOUR_PER_SENDER` | Global fixed-UTC-hour cap per sender; defaults to `200`. |
| `FRONTEND_URL`, `CORS_ORIGIN`, `API_URL`, `PORT` | Frontend origin, allowed CORS origin, public API URL, and API listen port. |
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_CALLBACK_URL` | Optional Slack OAuth configuration for limit notifications. |
| `QUEUE_DASHBOARD_USER`, `QUEUE_DASHBOARD_PASSWORD` | Basic Auth credentials for `/admin/queues`; change the local defaults before exposing the API. |

Create a free test account at [Ethereal Email](https://ethereal.email/), then copy the SMTP username and password from its account page into `ETHEREAL_USER` and `ETHEREAL_PASS`. Ethereal captures test messages rather than delivering them to real recipients. Multiple sender accounts can be configured as:

```text
ETHEREAL_SENDERS=[{"email":"sender-one@ethereal.email","user":"smtp-user-one","pass":"smtp-pass-one"},{"email":"sender-two@ethereal.email","user":"smtp-user-two","pass":"smtp-pass-two"}]
```

The selected sender address must match one of the configured accounts. Keep the JSON on one line. For a dashboard-only preview without OAuth, SMTP, or backend services, use demo mode (`http://localhost:5173/?demo=1`); demo mode simulates compose actions in browser storage and does not send mail.

### Run the dashboard with demo data

If you want to explore the UI before configuring Google OAuth or starting the backend services, run the frontend:

```powershell
npm run dev:frontend
```

Open `http://localhost:5173/?demo=1` to load a sample user, scheduled/sent/failed emails, and demo SMTP senders. The compose form adds rows to browser local storage; this mode does not contact SMTP, Redis, PostgreSQL, Elasticsearch, Google, or Slack. Remove `?demo=1` to return to real API and OAuth mode.

### View the live demo

The `main` branch contains only the built frontend output. The editable source code is on the `source` branch. To publish from this output-only branch, set **Settings → Pages → Build and deployment → Source** to **Deploy from a branch**, select `main` and `/(root)`, then save. The site uses sample data only and does not connect to the backend:

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

### Backend

- **Scheduler:** Express endpoints validate campaign input, deduplicate recipients, persist each recipient as an email row, and enqueue a delayed BullMQ job keyed by that email ID. `Idempotency-Key` supports safe request retries.
- **Persistence:** Prisma stores users, campaigns, emails, and Slack connections in PostgreSQL. Docker Compose keeps PostgreSQL and Redis data in named volumes.
- **Restart recovery:** On API startup, scheduled database rows are reconciled with missing BullMQ jobs. Redis AOF and its named volume preserve delayed jobs across container restarts; the API can reconstruct missing queue jobs from PostgreSQL.
- **Rate limiting:** Redis Lua scripts atomically reserve a per-sender global hourly cap and a per-campaign cap using fixed UTC-hour windows. A limit hit delays the BullMQ job until the next UTC hour and can trigger one Slack notification per user/sender/hour.
- **Concurrency and pacing:** BullMQ worker concurrency is configurable with `WORKER_CONCURRENCY`; a Redis-backed per-sender throttle enforces `MIN_SEND_INTERVAL_MS` across worker instances. Conditional database status updates prevent two workers from claiming the same email.
- **Delivery and search:** Ethereal SMTP sends test messages. Elasticsearch indexes emails for authenticated search. Bull Board exposes a Basic-Auth-protected queue dashboard.

### Frontend

- Google OAuth login/logout and a signed-in user/profile display.
- Dashboard tables/views for **Scheduled**, **Sent**, and **Failed** emails, with status refresh and empty/loading/error states.
- Campaign compose form with recipient input and CSV lead import, email extraction, and duplicate removal.
- Sender selection, start time, per-recipient delay, and campaign hourly limit controls.
- Search across email recipient, subject, body, and sender.
- Slack connect/disconnect controls and connection status.
- Local demo mode with sample data, simulated sending, and browser-local persistence; it does not call the backend or send actual email.

## Assumptions, shortcuts, and trade-offs

- Google OAuth and real Ethereal credentials are required for an end-to-end live backend demo; OAuth and SMTP are intentionally not mocked in normal mode.
- Ethereal is a test inbox only. The sample app is not a production mail service and should not be used for unsolicited mail.
- PostgreSQL is the source of truth for campaign/email state, while BullMQ jobs are recoverable from scheduled database rows. Redis and PostgreSQL use local named Docker volumes for restart persistence.
- SMTP cannot participate in a PostgreSQL transaction. If a process stops after SMTP accepts a message but before the database marks it sent, recovery marks the `SENDING` row failed with an “outcome unknown” error rather than risking an automatic duplicate. Check Ethereal's message log before manually retrying.
- Search indexing is best effort: an Elasticsearch error is logged and does not change delivery status.
- Demo mode uses seeded browser-local data to preview UI; it is not evidence that scheduling, SMTP delivery, or restart recovery worked.

## Demo video (maximum 5 minutes)

A real recording should use the frontend in normal mode, a configured Google account, and Ethereal test credentials (not `?demo=1`). Suggested timeline:

1. **0:00–0:45 — Setup/overview:** Show the dashboard and the running API/worker.
2. **0:45–1:45 — Schedule:** Compose a campaign for test recipients with a future start time and a visible delay; submit it and show the rows in **Scheduled**.
3. **1:45–2:30 — Delivery:** Show messages in Ethereal and the dashboard's **Sent** view.
4. **2:30–3:45 — Restart recovery:** Schedule another future message, stop and restart the API/worker (leave PostgreSQL and Redis volumes intact), then show the queued email remains and later appears under **Sent**.
5. **3:45–4:30 — Rate-limit bonus:** Briefly show multiple jobs for one sender respecting the configured pacing/hourly cap and remaining queued when the cap is reached.
6. **4:30–5:00 — Trade-offs:** Mention the SMTP/database uncertain-outcome behavior and that Ethereal is test-only.

The demo recording is not included in this repository yet. Record and upload the real run (for example, as `demo.mp4` or an unlisted video link) before submitting; the current environment lacks Docker, configured OAuth/SMTP credentials, and a screen-recording tool, so a genuine backend-restart video cannot be captured here.

## Build

```powershell
npm run build
```
