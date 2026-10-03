import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVICE_NAME = "dynamodb-local";
const HEALTH_URL = "http://localhost:8000";
const READY_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

function runComposeCommand(args: string[]): void {
  const result = spawnSync("docker", ["compose", ...args], {
    cwd: projectRoot,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function waitUntilReady(): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      await fetch(HEALTH_URL);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  throw new Error(`Timed out waiting for ${SERVICE_NAME} to accept connections on ${HEALTH_URL}`);
}

async function up(): Promise<void> {
  console.log(`Starting ${SERVICE_NAME}...`);
  runComposeCommand(["up", "-d", SERVICE_NAME]);

  console.log(`Waiting for ${SERVICE_NAME} to be ready...`);
  await waitUntilReady();

  console.log(`${SERVICE_NAME} is ready at ${HEALTH_URL}`);
}

function down(): void {
  console.log(`Stopping ${SERVICE_NAME}...`);
  runComposeCommand(["down"]);
  console.log(`${SERVICE_NAME} stopped.`);
}

const command = process.argv[2];

switch (command) {
  case "up":
    await up();
    break;
  case "down":
    down();
    break;
  default:
    console.error(`Usage: tsx scripts/dynamodb-local.ts <up|down>`);
    process.exit(1);
}
