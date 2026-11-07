import { Queue } from "bullmq";
import { redis } from "./redis";

export const EMAIL_QUEUE = "scheduled-emails";

export interface SendEmailJob {
  emailId: string;
}

export const emailQueue = new Queue<SendEmailJob>(EMAIL_QUEUE, {
  connection: redis,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: { age: 7 * 24 * 60 * 60, count: 10000 },
    removeOnFail: { age: 30 * 24 * 60 * 60 }
  }
});
