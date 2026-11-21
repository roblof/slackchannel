// Runnable entrypoint: check tasks, send Slack reminders, persist dedup flags.
// Node 20+, ESM, zero npm dependencies (built-in fetch).
//
// Usage:
//   node scripts/remind.mjs            # live: posts to Slack, writes state
//   node scripts/remind.mjs --dry-run  # logs payloads, writes nothing
//
// Env:
//   SLACK_WEBHOOK_URL  Slack Incoming Webhook URL (required unless dry-run).
//                      Reminders are ALWAYS posted via this webhook.
//   DRY_RUN=1          same as --dry-run
//
//   SLACK_BOT_TOKEN    (optional) bot token with `lists:read`. When set TOGETHER
//   SLACK_LIST_ID      with SLACK_LIST_ID, tasks are read from that native Slack
//                      List instead of tasks.json. The token is used only to
//                      READ the List; posting still goes through SLACK_WEBHOOK_URL.
//                      If EITHER var is absent, behavior is unchanged (tasks.json).
//   SLACK_LIST_DUE_DEFAULT_TIME  (optional) wall-clock time, default "17:00",
//                      applied to date-only due dates (Europe/Stockholm).

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { dueReminders, buildSlackMessage } from "./lib.mjs";
import {
  fetchTasksFromList,
  applyReminderState,
  recordReminderState,
  DEFAULT_LIST_DUE_TIME,
} from "./slack-lists.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TASKS_PATH = path.resolve(__dirname, "..", "tasks.json");
const STATE_PATH = path.resolve(__dirname, "..", ".reminder-state.json");

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

function useSlackList(env = process.env) {
  return Boolean(env.SLACK_BOT_TOKEN && env.SLACK_LIST_ID);
}

async function loadState(statePath = STATE_PATH) {
  try {
    const raw = await readFile(statePath, "utf8");
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    // Missing/invalid state file -> start fresh (first run).
    return {};
  }
}

// List mode: read tasks from a native Slack List, dedup via a state file, and
// post through the SAME webhook path. Only used when SLACK_BOT_TOKEN and
// SLACK_LIST_ID are both set.
async function runListMode({ env, dryRun, now }) {
  const { tasks, columnMap } = await fetchTasksFromList({
    token: env.SLACK_BOT_TOKEN,
    listId: env.SLACK_LIST_ID,
    defaultDueTime: env.SLACK_LIST_DUE_DEFAULT_TIME || DEFAULT_LIST_DUE_TIME,
  });
  const foundRoles = Object.keys(columnMap).join(", ") || "(inga)";
  console.log(
    `[remind] Läste ${tasks.length} uppgift(er) från Slack-lista. Kolumner: ${foundRoles}.`
  );

  const state = await loadState();
  applyReminderState(tasks, state);

  const due = dueReminders(tasks, now);
  console.log(
    `[remind] ${now.toISOString()} – ${due.length} påminnelse(r) att skicka${
      dryRun ? " (dry-run)" : ""
    }.`
  );
  if (due.length === 0) return { sent: 0, dryRun, changed: false };

  const webhookUrl = env.SLACK_WEBHOOK_URL;
  if (!dryRun && !webhookUrl) {
    throw new Error("SLACK_WEBHOOK_URL saknas. Lägg till den som GitHub-secret.");
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
      recordReminderState(state, task, now);
      changed = true;
      sent += 1;
      console.log(`[remind] Skickade påminnelse för "${task.title}" (${task.id}).`);
    } catch (err) {
      console.error(`[remind] Misslyckades för ${task.id}: ${err.message}`);
    }
  }

  if (changed && !dryRun) {
    await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
    console.log("[remind] .reminder-state.json uppdaterad.");
  }
  return { sent, dryRun, changed };
}

export async function run({ argv = process.argv, env = process.env } = {}) {
  const dryRun = isDryRun(argv, env);
  const now = new Date();

  if (useSlackList(env)) {
    return runListMode({ env, dryRun, now });
  }

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
