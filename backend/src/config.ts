import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  FRONTEND_URL: z.string().url().default("http://localhost:5173"),
  API_URL: z.string().url().default("http://localhost:4000"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  ELASTICSEARCH_URL: z.string().url().default("http://localhost:9200"),
  ELASTICSEARCH_INDEX: z.string().default("emails"),
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),
  GOOGLE_CALLBACK_URL: z.string().url().default("http://localhost:4000/auth/google/callback"),
  SLACK_CLIENT_ID: z.string().default(""),
  SLACK_CLIENT_SECRET: z.string().default(""),
  SLACK_CALLBACK_URL: z.string().url().default("http://localhost:4000/auth/slack/callback"),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  TOKEN_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/, "TOKEN_ENCRYPTION_KEY must be 32 bytes encoded as 64 hex characters"),
  ETHEREAL_HOST: z.string().default("smtp.ethereal.email"),
  ETHEREAL_PORT: z.coerce.number().int().positive().default(587),
  ETHEREAL_USER: z.string().default(""),
  ETHEREAL_PASS: z.string().default(""),
  ETHEREAL_SENDERS: z.string().default("[]"),
  EMAIL_FROM: z.string().default("ReachInbox Demo <no-reply@example.com>"),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().max(100).default(10),
  MIN_SEND_INTERVAL_MS: z.coerce.number().int().nonnegative().default(2000),
  MAX_EMAILS_PER_HOUR_PER_SENDER: z.coerce.number().int().positive().default(200),
  QUEUE_DASHBOARD_USER: z.string().default("admin"),
  QUEUE_DASHBOARD_PASSWORD: z.string().min(1).default("change-me"),
  CORS_ORIGIN: z.string().url().default("http://localhost:5173")
});

export const config = schema.parse(process.env);
