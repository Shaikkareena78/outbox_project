import { DelayedError, Job, Worker } from "bullmq";
import { decrypt } from "./crypto";
import { config } from "./config";
import { prisma } from "./db";
import { sendEmail } from "./emailSender";
import { EMAIL_QUEUE, SendEmailJob } from "./queue";
import { redis } from "./redis";
import { indexEmail } from "./search";
import {
  checkSendAvailability,
  releaseRateNotification,
  releaseSendReservation,
  releaseThrottle,
  reserveSend,
  reserveThrottle
} from "./rateLimit";

async function notifySlack(userId: string, sender: string): Promise<void> {
  const connection = await prisma.slackConnection.findUnique({ where: { userId } });
  if (!connection) return;
  const webhook = decrypt(connection.encryptedWebhook);
  const response = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      text: `Hourly email limit reached for sender ${sender}. Queued emails will resume in the next hour window.`
    })
  });
  if (!response.ok) throw new Error(`Slack notification failed: ${response.status} ${response.statusText}`);
}

async function deferRateLimitedJob(
  job: Job<SendEmailJob>,
  token: string | undefined,
  userId: string,
  sender: string,
  decision: { delayUntil?: number; notify: boolean }
): Promise<never> {
  if (decision.notify) {
    try {
      const connection = await prisma.slackConnection.findUnique({ where: { userId } });
      if (connection) await notifySlack(userId, sender);
      else await releaseRateNotification(sender, userId);
    } catch (error) {
      console.error("Could not send Slack rate-limit notification", error);
    }
  }
  await job.moveToDelayed(decision.delayUntil!, token!);
  throw new DelayedError();
}

async function processEmail(job: Job<SendEmailJob>, token?: string): Promise<void> {
  const email = await prisma.email.findUnique({ where: { id: job.data.emailId } });
  if (!email || email.status === "SENT" || email.status === "FAILED") return;
  if (email.status === "SENDING") {
    await prisma.email.update({
      where: { id: email.id },
      data: {
        status: "FAILED",
        error: "Previous attempt ended while sending; delivery outcome is unknown and was not retried to avoid a duplicate."
      }
    });
    return;
  }

  const campaign = await prisma.campaign.findUnique({ where: { id: email.campaignId } });
  if (!campaign) throw new Error(`Campaign ${email.campaignId} not found`);
  const availability = await checkSendAvailability(email.sender, campaign.hourlyLimit, campaign.id, email.userId);
  if (!availability.allowed) return deferRateLimitedJob(job, token, email.userId, email.sender, availability);

  const reservationId = `${job.id}:${token ?? ""}`;
  const throttleWait = await reserveThrottle(email.sender, reservationId);
  if (throttleWait > 0) {
    await job.moveToDelayed(Date.now() + throttleWait, token!);
    throw new DelayedError();
  }

  const decision = await reserveSend(email.sender, campaign.hourlyLimit, campaign.id, email.userId);
  if (!decision.allowed) {
    await releaseThrottle(email.sender, reservationId);
    return deferRateLimitedJob(job, token, email.userId, email.sender, decision);
  }

  const claim = await prisma.email.updateMany({
    where: { id: email.id, status: "SCHEDULED" },
    data: { status: "SENDING", error: null }
  });
  if (claim.count === 0) {
    await releaseThrottle(email.sender, reservationId);
    await releaseSendReservation(email.sender, campaign.id, email.userId);
    return;
  }

  let sentMessage;
  try {
    await sendEmail({
      to: email.recipient,
      subject: email.subject,
      body: email.body,
      from: email.sender
    });
    sentMessage = await prisma.email.update({
      where: { id: email.id },
      data: { status: "SENT", sentAt: new Date(), error: null }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Email delivery failed";
    const failed = await prisma.email.update({
      where: { id: email.id },
      data: { status: "FAILED", error: message }
    });
    try {
      await indexEmail(failed);
    } catch (indexError) {
      console.error(`Could not index failed email ${email.id}`, indexError);
    }
    throw error;
  }
  try {
    await indexEmail(sentMessage);
  } catch (error) {
    console.error(`Email ${email.id} was sent but could not be indexed`, error);
  }
}

const worker = new Worker<SendEmailJob>(EMAIL_QUEUE, processEmail, {
  connection: redis,
  concurrency: config.WORKER_CONCURRENCY,
  settings: { backoffStrategy: (attemptsMade) => Math.min(5000 * 2 ** attemptsMade, 60_000) }
});

worker.on("completed", (job) => console.info(`Email job ${job.id} completed`));
worker.on("failed", (job, error) => console.error(`Email job ${job?.id} failed`, error));
worker.on("error", (error) => console.error("Email worker error", error));

async function shutdown(): Promise<void> {
  await worker.close();
  await prisma.$disconnect();
  await redis.quit();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

console.info(`Email worker running with concurrency ${config.WORKER_CONCURRENCY}`);
