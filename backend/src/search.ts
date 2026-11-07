import { Client } from "@elastic/elasticsearch";
import { Email } from "@prisma/client";
import { config } from "./config";

export const searchClient = new Client({ node: config.ELASTICSEARCH_URL });

export async function indexEmails(emails: Email[]): Promise<void> {
  if (!emails.length) return;
  const operations = emails.flatMap((email) => [
    { index: { _index: config.ELASTICSEARCH_INDEX, _id: email.id } },
    {
      userId: email.userId,
      recipient: email.recipient,
      subject: email.subject,
      body: email.body,
      sender: email.sender,
      status: email.status.toLowerCase(),
      scheduledAt: email.scheduledAt,
      sentAt: email.sentAt,
      error: email.error
    }
  ]);
  const response = await searchClient.bulk({ operations, refresh: "wait_for" });
  if (response.errors) {
    const failed = response.items.filter((item) => Object.values(item)[0]?.error).length;
    throw new Error(`Elasticsearch failed to index ${failed} of ${emails.length} email documents`);
  }
}

export async function indexEmail(email: Email): Promise<void> {
  await indexEmails([email]);
}
