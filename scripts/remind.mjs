// Runnable entrypoint: check tasks.json, send Slack reminders, persist flags.
// Node 20+, ESM, zero npm dependencies (built-in fetch).
//
// Usage:
//   node scripts/remind.mjs            # live: posts to Slack, writes tasks.json
//   node scripts/remind.mjs --dry-run  # logs payloads, writes nothing
//
// Env:
//   SLACK_WEBHOOK_URL  Slack Incoming Webhook URL (required unless dry-run)
//   DRY_RUN=1          same as --dry-run

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { dueReminders, buildSlackMessage } from "./lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TASKS_PATH = path.resolve(__dirname, "..", "tasks.json");

function isDryRun(argv = process.argv, env = process.env) {
  return argv.includes("--dry-run") || env.DRY_RUN === "1" || env.DRY_RUN === "true";
}

async function postToSlack(webhookUrl, payload) {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Slack svarade ${res.status} ${res.statusText}: ${body}`);
  }
  return true;
}

export async function run({ argv = process.argv, env = process.env } = {}) {
  const dryRun = isDryRun(argv, env);
  const now = new Date();

  const raw = await readFile(TASKS_PATH, "utf8");
  const tasks = JSON.parse(raw);
  if (!Array.isArray(tasks)) {
    throw new Error("tasks.json måste innehålla en array.");
  }

  const due = dueReminders(tasks, now);
  console.log(
    `[remind] ${now.toISOString()} – ${due.length} påminnelse(r) att skicka${
      dryRun ? " (dry-run)" : ""
    }.`
  );

  if (due.length === 0) {
    return { sent: 0, dryRun, changed: false };
  }

  const webhookUrl = env.SLACK_WEBHOOK_URL;
  if (!dryRun && !webhookUrl) {
    throw new Error(
      "SLACK_WEBHOOK_URL saknas. Lägg till den som GitHub-secret."
    );
  }

  let sent = 0;
  let changed = false;
  for (const task of due) {
    const payload = buildSlackMessage(task, now);
    if (dryRun) {
      console.log(`[dry-run] ${task.id}:`, JSON.stringify(payload));
      continue;
    }
    try {
      await postToSlack(webhookUrl, payload);
      task.reminded = true;
      changed = true;
      sent += 1;
      console.log(`[remind] Skickade påminnelse för "${task.title}" (${task.id}).`);
    } catch (err) {
      console.error(`[remind] Misslyckades för ${task.id}: ${err.message}`);
    }
  }

  if (changed && !dryRun) {
    await writeFile(TASKS_PATH, JSON.stringify(tasks, null, 2) + "\n", "utf8");
    console.log("[remind] tasks.json uppdaterad.");
  }

  return { sent, dryRun, changed };
}

// Execute only when run directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
