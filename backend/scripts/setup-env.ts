import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

async function setupEnvironment(): Promise<void> {
  const examplePath = resolve(process.cwd(), ".env.example");
  const envPath = resolve(process.cwd(), ".env");

  try {
    await readFile(envPath, "utf8");
    console.error("backend/.env already exists. It was left unchanged.");
    process.exitCode = 1;
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const example = await readFile(examplePath, "utf8");
  const sessionSecret = randomBytes(32).toString("base64url");
  const encryptionKey = randomBytes(32).toString("hex");
  const environment = example
    .replace(/^SESSION_SECRET=.*$/m, `SESSION_SECRET=${sessionSecret}`)
    .replace(/^TOKEN_ENCRYPTION_KEY=.*$/m, `TOKEN_ENCRYPTION_KEY=${encryptionKey}`);

  await writeFile(envPath, environment, { flag: "wx", mode: 0o600 });
  console.info("Created backend/.env with fresh local secrets.");
  console.info("Add your Google OAuth and Ethereal SMTP credentials before using login or sending email.");
}

void setupEnvironment().catch((error: unknown) => {
  console.error("Could not create backend/.env", error);
  process.exitCode = 1;
});
