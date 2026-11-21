// Create/update/close a task from a GitHub Issue Form.
// Called by .github/workflows/add-task.yml. Node 20+, ESM, no deps.
//
// Env:
//   ISSUE_NUMBER  issue number (task key)
//   ISSUE_ACTION  "opened" | "edited" | "closed" | "reopened"
//   ISSUE_BODY    the issue form body (markdown)
//   COMMENT_FILE  path to write the confirmation/error comment to
//
// The script never throws on bad input: it writes a helpful comment instead,
// so the workflow can post it back to the issue.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { localWallClockToISO, formatDeadline } from "./lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TASKS_PATH = path.resolve(__dirname, "..", "tasks.json");

/**
 * Parse a GitHub Issue Form markdown body into a field map keyed by a
 * normalized label fragment. "_No response_" becomes an empty string.
 * @param {string} body
 * @returns {Record<string,string>}
 */
export function parseIssueForm(body) {
  const out = {};
  if (!body) return out;
  const sections = String(body).split(/^###\s+/m).slice(1);
  for (const section of sections) {
    const nl = section.indexOf("\n");
    const header = (nl === -1 ? section : section.slice(0, nl)).trim();
    let value = (nl === -1 ? "" : section.slice(nl + 1)).trim();
    if (value === "_No response_" || value === "_Inget svar_") value = "";
    out[header.toLowerCase()] = value;
  }
  return out;
}

function pick(fields, needle) {
  const key = Object.keys(fields).find((k) => k.includes(needle));
  return key ? fields[key] : "";
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

async function loadTasks() {
  try {
    const raw = await readFile(TASKS_PATH, "utf8");
    const t = JSON.parse(raw);
    return Array.isArray(t) ? t : [];
  } catch {
    return [];
  }
}

async function writeTasks(tasks) {
  await writeFile(TASKS_PATH, JSON.stringify(tasks, null, 2) + "\n", "utf8");
}

async function writeComment(file, text) {
  if (file) await writeFile(file, text, "utf8");
  console.log(text);
}

export async function main(env = process.env) {
  const issueNumber = String(env.ISSUE_NUMBER || "").trim();
  const action = String(env.ISSUE_ACTION || "").trim();
  const commentFile = env.COMMENT_FILE;
  if (!issueNumber) {
    await writeComment(commentFile, "Kunde inte hitta issue-nummer.");
    return;
  }
  const taskId = `issue-${issueNumber}`;
  const tasks = await loadTasks();
  const idx = tasks.findIndex((t) => t.id === taskId);

  if (action === "closed") {
    if (idx === -1) {
      await writeComment(
        commentFile,
        "Ingen uppgift kopplad till detta ärende hittades, inget att markera som klart."
      );
      return;
    }
    tasks[idx].status = "done";
    await writeTasks(tasks);
    await writeComment(commentFile, "✅ Uppgiften är markerad som klar (status: done).");
    return;
  }

  // opened / edited / reopened -> upsert from the form
  try {
    const fields = parseIssueForm(env.ISSUE_BODY);
    const title = pick(fields, "titel");
    const assignee = pick(fields, "ansvarig");
    const slackId = pick(fields, "slack");
    const fristRaw = pick(fields, "frist");
    const hoursRaw = pick(fields, "timmar");

    if (!title) throw new Error("Fältet **Titel** saknas.");
    if (!assignee) throw new Error("Fältet **Ansvarig** saknas.");
    if (!fristRaw) throw new Error("Fältet **Frist** saknas.");

    const deadline = localWallClockToISO(fristRaw);
    let remindHours = 2;
    if (hoursRaw) {
      const n = Number(hoursRaw);
      if (!isFinite(n) || n < 0)
        throw new Error(`Ogiltigt värde i **Timmar innan**: "${hoursRaw}".`);
      remindHours = n;
    }

    const task = {
      id: taskId,
      slug: slugify(title),
      title,
      assignee,
      assignee_slack_id: slackId || "",
      deadline,
      remind_hours_before: remindHours,
      status: action === "reopened" && idx !== -1 ? "open" : "open",
      // Preserve reminded flag on edits unless the deadline moved.
      reminded:
        idx !== -1 && tasks[idx].deadline === deadline
          ? tasks[idx].reminded === true
          : false,
    };

    if (idx === -1) tasks.push(task);
    else tasks[idx] = task;

    await writeTasks(tasks);
    await writeComment(
      commentFile,
      `✅ Uppgift sparad: *${title}* för ${assignee}.\n` +
        `Frist: ${formatDeadline(deadline)} (${deadline}).\n` +
        `Påminnelse skickas ${remindHours} timme(r) innan. Stäng ärendet när det är klart.`
    );
  } catch (err) {
    await writeComment(
      commentFile,
      `⚠️ Kunde inte spara uppgiften: ${err.message}\n\n` +
        "Kontrollera att **Frist** har formatet `YYYY-MM-DD HH:MM` (lokal tid, Europe/Stockholm) och försök igen genom att redigera ärendet."
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
