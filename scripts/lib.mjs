// Pure, testable helpers for the serverless task-reminder system.
// Node 20+, ESM, zero npm dependencies.

export const DEFAULT_REMIND_HOURS_BEFORE = 2;
export const STOCKHOLM_TZ = "Europe/Stockholm";

// Tracker metadata used by the issue form (Prioritet / Status).
export const DEFAULT_PRIORITY = "Medel";
export const DEFAULT_STATUS = "Att göra";
// Statuses that mean the task is finished and must not trigger reminders.
// "done" is the legacy lifecycle value; "Klar" is the board value.
export const DONE_STATUSES = ["done", "Klar"];

/**
 * Normalize a Prioritet value, falling back to the default when missing.
 * @param {string|undefined|null} value
 * @returns {string}
 */
export function normalizePriority(value) {
  const s = String(value ?? "").trim();
  return s || DEFAULT_PRIORITY;
}

/**
 * Normalize a Status value, falling back to the default when missing.
 * @param {string|undefined|null} value
 * @returns {string}
 */
export function normalizeStatus(value) {
  const s = String(value ?? "").trim();
  return s || DEFAULT_STATUS;
}

/**
 * Whether a task's status means it is finished (so no reminder should fire).
 * @param {string|undefined|null} status
 * @returns {boolean}
 */
export function isDoneStatus(status) {
  return DONE_STATUSES.includes(status);
}

/**
 * Compute the UTC offset (in minutes, east-positive) of a time zone at a
 * given instant. Uses Intl so DST (CET +01:00 vs CEST +02:00) is handled
 * automatically.
 * @param {Date} date
 * @param {string} timeZone IANA zone, e.g. "Europe/Stockholm"
 * @returns {number} offset in minutes (e.g. 60 for CET, 120 for CEST)
 */
export function getTimeZoneOffsetMinutes(date, timeZone = STOCKHOLM_TZ) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(date);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  const asUTC = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second)
  );
  return Math.round((asUTC - date.getTime()) / 60000);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * Format an offset in minutes as an ISO 8601 offset string, e.g. 60 -> "+01:00".
 * @param {number} minutes
 * @returns {string}
 */
export function formatOffset(minutes) {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/**
 * Convert a local wall-clock time in Europe/Stockholm ("YYYY-MM-DD HH:MM")
 * into a full ISO 8601 string WITH the correct offset for that date,
 * correctly accounting for DST.
 * @param {string} localStr e.g. "2026-11-25 15:00"
 * @param {string} timeZone
 * @returns {string} e.g. "2026-11-25T15:00:00+01:00"
 */
export function localWallClockToISO(localStr, timeZone = STOCKHOLM_TZ) {
  const m = String(localStr)
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) {
    throw new Error(
      `Ogiltigt datum/tid-format: "${localStr}". Förväntar "YYYY-MM-DD HH:MM".`
    );
  }
  const [, Y, Mo, D, H, Mi, S] = m;
  const year = Number(Y);
  const month = Number(Mo);
  const day = Number(D);
  const hour = Number(H);
  const minute = Number(Mi);
  const second = Number(S || "0");

  // Guess: treat the wall clock as if it were UTC, then correct by the zone
  // offset at (approximately) that instant. One refinement iteration handles
  // the rare case where the first guess lands on the wrong side of a DST edge.
  const wallAsUTC = Date.UTC(year, month - 1, day, hour, minute, second);
  let offset = getTimeZoneOffsetMinutes(new Date(wallAsUTC), timeZone);
  let instant = wallAsUTC - offset * 60000;
  const offset2 = getTimeZoneOffsetMinutes(new Date(instant), timeZone);
  if (offset2 !== offset) {
    offset = offset2;
    instant = wallAsUTC - offset * 60000;
  }

  return `${Y}-${Mo}-${D}T${pad2(hour)}:${pad2(minute)}:${pad2(
    second
  )}${formatOffset(offset)}`;
}

/**
 * The remind-hours-before value for a task, defaulting sensibly.
 * @param {object} task
 * @returns {number}
 */
export function remindHoursBefore(task) {
  const v = task.remind_hours_before;
  return typeof v === "number" && isFinite(v) && v >= 0
    ? v
    : DEFAULT_REMIND_HOURS_BEFORE;
}

/**
 * The instant a reminder window opens for a task (deadline - hours).
 * @param {object} task
 * @returns {Date}
 */
export function reminderWindowStart(task) {
  const deadline = new Date(task.deadline);
  return new Date(deadline.getTime() - remindHoursBefore(task) * 3600 * 1000);
}

/**
 * Should a reminder fire for this task right now?
 * Fires when: status open AND not yet reminded AND
 *   now >= (deadline - remind_hours_before) AND now < deadline.
 * @param {object} task
 * @param {Date} now
 * @returns {boolean}
 */
export function shouldRemind(task, now = new Date()) {
  // Fire for any task that is not finished. Lifecycle "done" and the board
  // status "Klar" both count as finished; "open", "Att göra" and "Pågår" fire.
  if (!task || isDoneStatus(task.status)) return false;
  if (task.reminded === true) return false;
  if (!task.deadline) return false;
  const deadline = new Date(task.deadline);
  if (isNaN(deadline.getTime())) return false;
  const windowStart = reminderWindowStart(task);
  return now.getTime() >= windowStart.getTime() && now.getTime() < deadline.getTime();
}

/**
 * Format a deadline for humans, in Europe/Stockholm.
 * @param {string|Date} deadline
 * @param {string} timeZone
 * @returns {string} e.g. "tisdag 25 november 2026 kl. 15:00"
 */
export function formatDeadline(deadline, timeZone = STOCKHOLM_TZ) {
  const d = deadline instanceof Date ? deadline : new Date(deadline);
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return fmt.format(d);
}

/**
 * Human-friendly "time left" string in Swedish.
 * @param {number} ms milliseconds until deadline
 * @returns {string}
 */
export function humanizeTimeLeft(ms) {
  if (ms <= 0) return "nu";
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (hours > 0) parts.push(`${hours} ${hours === 1 ? "timme" : "timmar"}`);
  if (minutes > 0)
    parts.push(`${minutes} ${minutes === 1 ? "minut" : "minuter"}`);
  if (parts.length === 0) return "mindre än en minut";
  return parts.join(" och ");
}

/**
 * The mention string for a task's assignee.
 * @param {object} task
 * @returns {string}
 */
export function mentionFor(task) {
  if (task.assignee_slack_id && String(task.assignee_slack_id).trim() !== "") {
    return `<@${task.assignee_slack_id}>`;
  }
  return task.assignee || "okänd";
}

/**
 * Build the Slack message payload for a task reminder.
 * @param {object} task
 * @param {Date} now
 * @param {string} timeZone
 * @returns {{text: string}}
 */
export function buildSlackMessage(task, now = new Date(), timeZone = STOCKHOLM_TZ) {
  const deadline = new Date(task.deadline);
  const left = humanizeTimeLeft(deadline.getTime() - now.getTime());
  const when = formatDeadline(deadline, timeZone);
  const who = mentionFor(task);
  const text =
    `:alarm_clock: Påminnelse för ${who}: *${task.title}*\n` +
    `Frist om ${left} – ${when} (Europe/Stockholm).`;
  return { text };
}

/**
 * Return the list of tasks that should be reminded now.
 * @param {object[]} tasks
 * @param {Date} now
 * @returns {object[]}
 */
export function dueReminders(tasks, now = new Date()) {
  return (tasks || []).filter((t) => shouldRemind(t, now));
}
