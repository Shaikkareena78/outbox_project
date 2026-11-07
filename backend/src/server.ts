import "dotenv/config";
import cors from "cors";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { OAuth2Client } from "google-auth-library";
import jwt from "jsonwebtoken";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { config } from "./config";
import { encrypt } from "./crypto";
import { AuthenticatedRequest, requireAuth, signSession } from "./auth";
import { prisma } from "./db";
import { emailQueue } from "./queue";
import { redis } from "./redis";
import { indexEmails, searchClient } from "./search";
import { availableSenders } from "./emailSender";

const app = express();
const googleOAuth = new OAuth2Client(
  config.GOOGLE_CLIENT_ID || "not-configured",
  config.GOOGLE_CLIENT_SECRET,
  config.GOOGLE_CALLBACK_URL
);
const oauthStateCookie = "oauth_state";

app.set("trust proxy", 1);
app.use(cors({ origin: config.CORS_ORIGIN, credentials: true }));
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

function requireGoogleCredentials(res: Response): boolean {
  if (config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET) return true;
  res.status(503).json({ error: "Google OAuth is not configured" });
  return false;
}

function secureCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    maxAge: 7 * 24 * 60 * 60 * 1000
  };
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function enqueueScheduledEmail(id: string, scheduledAt: Date): Promise<void> {
  const existing = await emailQueue.getJob(id);
  if (!existing) {
    await emailQueue.add("send-email", { emailId: id }, {
      jobId: id,
      delay: Math.max(0, scheduledAt.getTime() - Date.now())
    });
  }
}

const queueAdapter = new ExpressAdapter();
queueAdapter.setBasePath("/admin/queues");
createBullBoard({ queues: [new BullMQAdapter(emailQueue)], serverAdapter: queueAdapter });
app.use("/admin/queues", (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Queue dashboard"');
    res.status(401).send("Authentication required");
    return;
  }
  const [user, password] = Buffer.from(header.slice(6), "base64").toString().split(":");
  if (!safeEqual(user ?? "", config.QUEUE_DASHBOARD_USER) ||
      !safeEqual(password ?? "", config.QUEUE_DASHBOARD_PASSWORD)) {
    res.status(401).send("Invalid credentials");
    return;
  }
  next();
}, queueAdapter.getRouter());

app.get("/health", async (_req, res) => {
  try {
    await redis.ping();
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok" });
  } catch (error) {
    console.error("Health check failed", error);
    res.status(503).json({ status: "unavailable" });
  }
});

app.get("/auth/google", (req, res) => {
  if (!requireGoogleCredentials(res)) return;
  const state = randomBytes(24).toString("hex");
  res.cookie(oauthStateCookie, state, {
    ...secureCookieOptions(),
    maxAge: 10 * 60 * 1000
  });
  res.redirect(googleOAuth.generateAuthUrl({
    access_type: "online",
    scope: ["openid", "email", "profile"],
    state,
    prompt: "select_account"
  }));
});

app.get("/auth/google/callback", async (req, res, next) => {
  try {
    const state = String(req.query.state ?? "");
    const cookieState = String(req.cookies?.[oauthStateCookie] ?? "");
    res.clearCookie(oauthStateCookie);
    if (!state || !cookieState || !safeEqual(state, cookieState)) {
      res.status(400).send("Invalid OAuth state");
      return;
    }
    if (typeof req.query.code !== "string") {
      res.status(400).send("Google did not return an authorization code");
      return;
    }
    const { tokens } = await googleOAuth.getToken(req.query.code);
    if (!tokens.id_token) throw new Error("Google did not return an ID token");
    const ticket = await googleOAuth.verifyIdToken({
      idToken: tokens.id_token,
      audience: config.GOOGLE_CLIENT_ID
    });
    const profile = ticket.getPayload();
    if (!profile?.sub || !profile.email || !profile.name || !profile.email_verified) {
      throw new Error("Google profile is incomplete or the email address is not verified");
    }
    const user = await prisma.user.upsert({
      where: { googleSub: profile.sub },
      create: {
        googleSub: profile.sub,
        email: profile.email,
        name: profile.name,
        picture: profile.picture
      },
      update: {
        email: profile.email,
        name: profile.name,
        picture: profile.picture
      }
    });
    res.cookie("session", signSession(user.id), secureCookieOptions());
    res.redirect(config.FRONTEND_URL);
  } catch (error) {
    next(error);
  }
});

app.post("/auth/logout", (_req, res) => {
  res.clearCookie("session");
  res.status(204).end();
});

app.get("/api/me", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId! },
      select: { id: true, name: true, email: true, picture: true, slackConnection: { select: { teamName: true } } }
    });
    if (!user) {
      res.status(401).json({ error: "User no longer exists" });
      return;
    }
    res.json({
      id: user.id,
      name: user.name,
      email: user.email,
      picture: user.picture,
      slackConnected: Boolean(user.slackConnection),
      slackTeam: user.slackConnection?.teamName ?? null
    });
  } catch (error) {
    next(error);
  }
});

app.get("/auth/slack", requireAuth, (req: AuthenticatedRequest, res) => {
  if (!config.SLACK_CLIENT_ID || !config.SLACK_CLIENT_SECRET) {
    res.status(503).json({ error: "Slack OAuth is not configured" });
    return;
  }
  const state = randomBytes(24).toString("hex");
  res.cookie("slack_oauth_state", `${req.userId}:${state}`, {
    ...secureCookieOptions(),
    maxAge: 10 * 60 * 1000
  });
  const query = new URLSearchParams({
    client_id: config.SLACK_CLIENT_ID,
    scope: "incoming-webhook",
    redirect_uri: config.SLACK_CALLBACK_URL,
    state
  });
  res.redirect(`https://slack.com/oauth/v2/authorize?${query.toString()}`);
});

app.get("/auth/slack/callback", async (req, res, next) => {
  try {
    const [userId, state] = String(req.cookies?.slack_oauth_state ?? "").split(":");
    res.clearCookie("slack_oauth_state");
    if (!userId || !state || !safeEqual(state, String(req.query.state ?? ""))) {
      res.status(400).send("Invalid Slack OAuth state");
      return;
    }
    if (typeof req.query.code !== "string") {
      res.status(400).send("Slack did not return an authorization code");
      return;
    }
    const response = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.SLACK_CLIENT_ID,
        client_secret: config.SLACK_CLIENT_SECRET,
        code: req.query.code,
        redirect_uri: config.SLACK_CALLBACK_URL
      })
    });
    const result = await response.json() as {
      ok?: boolean;
      error?: string;
      incoming_webhook?: { url?: string };
      team?: { name?: string };
    };
    if (!response.ok || !result.ok || !result.incoming_webhook?.url) {
      throw new Error(`Slack OAuth failed: ${result.error ?? response.statusText}`);
    }
    const webhook = new URL(result.incoming_webhook.url);
    if (webhook.protocol !== "https:" || webhook.hostname !== "hooks.slack.com") {
      throw new Error("Slack returned an invalid incoming webhook URL");
    }
    await prisma.slackConnection.upsert({
      where: { userId },
      create: {
        userId,
        encryptedWebhook: encrypt(webhook.toString()),
        teamName: result.team?.name
      },
      update: {
        encryptedWebhook: encrypt(webhook.toString()),
        teamName: result.team?.name
      }
    });
    res.redirect(config.FRONTEND_URL);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/slack", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    await prisma.slackConnection.deleteMany({ where: { userId: req.userId! } });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

const scheduleSchema = z.object({
  subject: z.string().trim().min(1).max(500),
  body: z.string().min(1).max(100_000),
  recipients: z.array(z.string().trim().email()).min(1).max(5000),
  startAt: z.string().datetime(),
  delayMs: z.number().int().min(0).max(86_400_000),
  hourlyLimit: z.number().int().positive().max(5000),
  sender: z.string().trim().email().optional()
});

app.get("/api/senders", requireAuth, (_req, res) => {
  res.json({ senders: availableSenders() });
});

app.post("/api/emails/schedule", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = scheduleSchema.parse(req.body);
    const recipients = [...new Set(input.recipients.map((email) => email.toLowerCase()))];
    const sender = input.sender ?? config.ETHEREAL_USER;
    if (!sender) {
      res.status(400).json({ error: "Select a sender and configure its Ethereal SMTP credentials" });
      return;
    }
    const senders = availableSenders();
    if (senders.length > 0 && !senders.some((available) => available.toLowerCase() === sender.toLowerCase())) {
      res.status(400).json({ error: "The selected sender has no configured SMTP account" });
      return;
    }
    const suppliedKey = req.get("Idempotency-Key");
    if (suppliedKey && !/^[A-Za-z0-9._:-]{8,128}$/.test(suppliedKey)) {
      res.status(400).json({ error: "Idempotency-Key must be 8–128 safe characters" });
      return;
    }
    const idempotencyKey = suppliedKey ? `${req.userId}:${suppliedKey}` : undefined;
    if (idempotencyKey) {
      const previous = await prisma.campaign.findUnique({
        where: { idempotencyKey },
        select: {
          id: true,
          emails: { select: { id: true, scheduledAt: true, status: true } }
        }
      });
      if (previous) {
        const scheduled = previous.emails.filter((email) => email.status === "SCHEDULED");
        for (let offset = 0; offset < scheduled.length; offset += 250) {
          await Promise.all(scheduled.slice(offset, offset + 250).map((email) => enqueueScheduledEmail(email.id, email.scheduledAt)));
        }
        res.status(200).json({ campaignId: previous.id, scheduled: previous.emails.length });
        return;
      }
    }
    const startAt = new Date(input.startAt);
    const { campaign, emails } = await prisma.$transaction(async (transaction) => {
      const campaign = await transaction.campaign.create({
        data: {
          userId: req.userId!,
          idempotencyKey,
          subject: input.subject,
          body: input.body,
          sender,
          startAt,
          delayMs: input.delayMs,
          hourlyLimit: Math.min(input.hourlyLimit, config.MAX_EMAILS_PER_HOUR_PER_SENDER)
        }
      });
      const emails = await transaction.email.createManyAndReturn({
        data: recipients.map((recipient, index) => ({
          userId: req.userId!,
          campaignId: campaign.id,
          recipient,
          subject: input.subject,
          body: input.body,
          sender,
          scheduledAt: new Date(startAt.getTime() + index * input.delayMs)
        }))
      });
      return { campaign, emails };
    }, { maxWait: 10_000, timeout: 30_000 });

    for (let offset = 0; offset < emails.length; offset += 250) {
      const batch = emails.slice(offset, offset + 250);
      await Promise.all(batch.map((email) => enqueueScheduledEmail(email.id, email.scheduledAt)));
      try {
        await indexEmails(batch);
      } catch (error) {
        console.error(`Could not index scheduled email batch starting at ${batch[0]?.id}`, error);
      }
    }

    res.status(201).json({
      campaignId: campaign.id,
      scheduled: emails.length,
      emails: emails.map((email) => ({
        id: email.id,
        recipient: email.recipient,
        subject: email.subject,
        scheduledAt: email.scheduledAt,
        status: email.status.toLowerCase()
      }))
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/emails", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const status = req.query.status === "sent" ? "SENT" :
      req.query.status === "failed" ? "FAILED" :
        req.query.status === "scheduled" ? ["SCHEDULED", "SENDING"] : undefined;
    const rows = await prisma.email.findMany({
      where: { userId: req.userId!, ...(status ? { status: Array.isArray(status) ? { in: status as ("SCHEDULED" | "SENDING")[] } : status as "SENT" | "FAILED" } : {}) },
      orderBy: [{ scheduledAt: "asc" }],
      take: 1000,
      select: {
        id: true,
        recipient: true,
        subject: true,
        scheduledAt: true,
        sentAt: true,
        status: true,
        error: true
      }
    });
    res.json(rows.map((row) => ({ ...row, status: row.status.toLowerCase() })));
  } catch (error) {
    next(error);
  }
});

app.get("/api/emails/search", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const query = z.string().trim().min(1).max(200).parse(req.query.q);
    const result = await searchClient.search({
      index: config.ELASTICSEARCH_INDEX,
      query: {
        bool: {
          filter: [{ term: { userId: req.userId! } }],
          must: [{
            multi_match: {
              query,
              fields: ["recipient", "subject", "body", "sender"],
              type: "best_fields"
            }
          }]
        }
      },
      size: 100
    });
    res.json(result.hits.hits.map((hit) => ({
      id: hit._id,
      ...(hit._source as Record<string, unknown> | undefined)
    })));
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: "Invalid request", details: error.flatten() });
    return;
  }
  console.error("Request failed", error);
  if (error instanceof jwt.JsonWebTokenError) {
    res.status(401).json({ error: "Invalid session" });
    return;
  }
  res.status(500).json({ error: error instanceof Error ? error.message : "Unexpected server error" });
});

async function start(): Promise<void> {
  await searchClient.indices.create({
    index: config.ELASTICSEARCH_INDEX,
    mappings: {
      properties: {
        userId: { type: "keyword" },
        recipient: { type: "text" },
        subject: { type: "text" },
        body: { type: "text" },
        sender: { type: "text" },
        status: { type: "keyword" },
        scheduledAt: { type: "date" },
        sentAt: { type: "date" }
      }
    }
  }, { ignore: [400] });
  let cursor: string | undefined;
  for (;;) {
    const batch = await prisma.email.findMany({
      where: { status: "SCHEDULED" },
      orderBy: { id: "asc" },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: 500,
      select: { id: true, scheduledAt: true }
    });
    if (!batch.length) break;
    cursor = batch[batch.length - 1].id;
    await Promise.all(batch.map((email) => enqueueScheduledEmail(email.id, email.scheduledAt)));
    if (batch.length < 500) break;
  }
  app.listen(config.PORT, () => {
    console.info(`API listening at ${config.API_URL}`);
    console.info(`Bull Board at ${config.API_URL}/admin/queues`);
  });
}

void start().catch((error) => {
  console.error("Failed to start API", error);
  process.exitCode = 1;
});
