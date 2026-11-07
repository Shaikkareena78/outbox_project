import nodemailer, { Transporter } from "nodemailer";
import { z } from "zod";
import { config } from "./config";

const senderSchema = z.array(z.object({
  email: z.string().email(),
  user: z.string().min(1),
  pass: z.string().min(1)
}));
const senderAccounts = senderSchema.parse(JSON.parse(config.ETHEREAL_SENDERS));
const transporters = new Map<string, Transporter>();

export function availableSenders(): string[] {
  return senderAccounts.length ? senderAccounts.map((sender) => sender.email) :
    config.ETHEREAL_USER ? [config.ETHEREAL_USER] : [];
}

function getTransporter(sender: string): Transporter {
  const account = senderAccounts.find((item) => item.email.toLowerCase() === sender.toLowerCase());
  const user = account?.user ?? config.ETHEREAL_USER;
  const pass = account?.pass ?? config.ETHEREAL_PASS;
  if (!user || !pass) {
    throw new Error("ETHEREAL_USER and ETHEREAL_PASS must be configured before sending");
  }
  let transporter = transporters.get(user);
  if (!transporter) {
    transporter = nodemailer.createTransport({
    host: config.ETHEREAL_HOST,
    port: config.ETHEREAL_PORT,
    secure: config.ETHEREAL_PORT === 465,
      auth: { user, pass }
    });
    transporters.set(user, transporter);
  }
  return transporter;
}

export async function sendEmail(input: {
  to: string;
  subject: string;
  body: string;
  from: string;
}): Promise<void> {
  await getTransporter(input.from).sendMail({
    from: input.from || config.EMAIL_FROM,
    to: input.to,
    subject: input.subject,
    text: input.body
  });
}
