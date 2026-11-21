// Read tasks from a native Slack List (the visual board on paid Slack plans)
// and map them into the SAME task shape the existing reminder logic expects.
//
// Node 20+, ESM, zero npm dependencies (built-in fetch).
//
// This module is ADDITIVE and OPT-IN. It is only used by remind.mjs when BOTH
// env vars SLACK_BOT_TOKEN and SLACK_LIST_ID are set. With those absent the
// reminder system keeps reading tasks.json exactly as before.
//
// ---------------------------------------------------------------------------
// SLACK API SHAPE — confirmed vs assumed (docs.slack.dev, Nov 2026)
// ---------------------------------------------------------------------------
// CONFIRMED (https://docs.slack.dev/reference/methods/slackLists.items.list):
//   * POST https://slack.com/api/slackLists.items.list
//   * Auth: Bearer token with scope `lists:read`. Paid plans only.
//   * Body params: list_id (required), limit (<=5000), cursor, archived (bool),
//     include_list (bool – when true the parent `list` object with its column
//     schema and title is returned alongside `items`).
//   * Response: { ok, items:[...], response_metadata:{ next_cursor } }.
//     next_cursor is "" when there are no more pages.
//   * Each item: { id, list_id, date_created, fields:[ cell… ], archived,
//     saved:{ state }, saved_fields:{…}, … }.
//   * Each cell: { column_id, key (deprecated), value (deprecated), and a
//     typed array named after the column type }:
//       - text column:   text (plain fallback) + rich_text (Block Kit blocks)
//       - number column:  number: [n]
//       - date column:    date: ["YYYY-MM-DD"] and timestamp: [unixSeconds]
//       - user column:    user: ["U…"]
//       - select column:  select: [optionId]  (sample showed "completed")
//   * `archived: true` in the request returns archived items INSTEAD of live
//     ones, so NOT sending it (the default) already excludes archived items.
//
// ASSUMED / NOT fully documented (guarded defensively, flagged in-code):
//   * The exact shape of the parent `list` column schema is not shown in the
//     docs. We look for the columns array under list.columns / list.schema /
//     list.list_metadata.columns and treat each entry as { id|column_id|key,
//     name, type, is_primary_column? }. We map a cell to a column by matching
//     cell.column_id (or deprecated key/id) against those identifiers.
//   * Select option ids may be opaque encoded ids rather than human words, so
//     "done" detection also falls back to the item-level todo state
//     (item.saved.state === "completed") and to the deprecated value/text.
//   * Date-only due dates (no timestamp) are given a default wall-clock time in
//     Europe/Stockholm (SLACK_LIST_DUE_DEFAULT_TIME, default 17:00).
//   * Assignee display NAME is not returned by this endpoint (only the user
//     id). We keep assignee:"" and rely on assignee_slack_id for the @-mention,
//     which the existing mentionFor() already prefers.

import {
  DEFAULT_REMIND_HOURS_BEFORE,
  STOCKHOLM_TZ,
  localWallClockToISO,
} from "./lib.mjs";

export const SLACK_LISTS_API_URL = "https://slack.com/api/slackLists.items.list";
export const DEFAULT_LIST_DUE_TIME = "17:00";

// Words (case-insensitive) that mark a status/select value as NOT open.
const DONE_WORDS = [
  "done",
  "complete",
  "completed",
  "closed",
  "finished",
  "resolved",
  "klar",
  "klart",
  "ferdig",
  "færdig",
  "faerdig",
  "slutförd",
  "slutford",
  "avklarad",
  "avslutad",
  "fullført",
  "fullfort",
  "utført",
  "utfort",
];

// Fuzzy name patterns (Norwegian / Swedish / English) for each semantic role.
const ROLE_NAME_PATTERNS = {
  title: ["title", "oppgave", "oppgaver", "uppgift", "task", "namn", "name", "ärende", "arende", "hva"],
  assignee: ["assignee", "ansvarlig", "ansvarig", "ägare", "agare", "eier", "owner", "tilldelad", "tildelt", "person", "who"],
  deadline: ["due date", "due", "frist", "deadline", "datum", "date", "forfaller", "förfaller", "forfall"],
  status: ["status", "tillstånd", "tillstand", "tilstand", "state", "ferdig", "klar", "done"],
  priority: ["priority", "prioritet", "prio"],
};

// Secondary signal: Slack column `type` values that hint at a role.
const ROLE_TYPE_HINTS = {
  title: ["text", "title", "rich_text"],
  assignee: ["todo_assignee", "user", "people", "person"],
  deadline: ["todo_due_date", "date", "due_date"],
  status: ["todo_completed", "select", "status", "checkbox"],
  priority: ["select", "rating"],
};

function norm(s) {
  return String(s ?? "").toLowerCase().trim();
}

/** All identifiers a column may be matched by (encoded id or deprecated key). */
function columnIds(col) {
  return [col?.id, col?.column_id, col?.key].filter((v) => v != null).map(String);
}

/**
 * Pull the columns array out of the parent `list` object. The exact location
 * is not documented, so we probe the likely spots.
 * @param {object|undefined} listObj
 * @returns {object[]}
 */
export function extractColumns(listObj) {
  if (!listObj || typeof listObj !== "object") return [];
  const candidates = [
    listObj.columns,
    listObj.schema,
    listObj.list_metadata && listObj.list_metadata.columns,
    listObj.list_metadata && listObj.list_metadata.schema,
    listObj.properties,
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length) return c;
  }
  return [];
}

/**
 * Score how well a column fits a role (0 = no match).
 * @param {object} col
 * @param {string} role
 * @returns {number}
 */
function scoreColumnForRole(col, role) {
  let score = 0;
  const name = norm(col.name);
  const type = norm(col.type);
  if (name) {
    for (const p of ROLE_NAME_PATTERNS[role] || []) {
      const np = norm(p);
      if (name === np) score += 100;
      else if (name.includes(np) || np.includes(name)) score += 60;
    }
  }
  for (const t of ROLE_TYPE_HINTS[role] || []) {
    if (type === norm(t)) score += 25;
  }
  if (role === "title" && col.is_primary_column === true) score += 40;
  return score;
}

/**
 * Auto-discover which column plays each semantic role, by fuzzy name match
 * plus column-type hints. Column ids are NEVER hardcoded.
 * @param {object[]} columns
 * @returns {{title?:object, assignee?:object, deadline?:object, status?:object, priority?:object}}
 */
export function discoverColumns(columns = []) {
  const cols = Array.isArray(columns) ? columns : [];
  const map = {};
  const used = new Set();
  // Resolve in priority order so the strongest-typed roles claim first.
  for (const role of ["deadline", "assignee", "title", "status", "priority"]) {
    let best = null;
    let bestScore = 0;
    for (const col of cols) {
      const key = columnIds(col).join("|") || norm(col.name);
      if (used.has(key)) continue;
      const s = scoreColumnForRole(col, role);
      if (s > bestScore) {
        bestScore = s;
        best = { col, key };
      }
    }
    if (best && bestScore > 0) {
      map[role] = best.col;
      used.add(best.key);
    }
  }
  return map;
}

/**
 * Find the cell in an item that belongs to the given column.
 * @param {object} item
 * @param {object|undefined} col
 * @returns {object|null}
 */
export function cellForColumn(item, col) {
  if (!col || !item || !Array.isArray(item.fields)) return null;
  const ids = new Set(columnIds(col));
  if (ids.size === 0) return null;
  for (const f of item.fields) {
    if (f.column_id != null && ids.has(String(f.column_id))) return f;
    if (f.key != null && ids.has(String(f.key))) return f;
    if (f.id != null && ids.has(String(f.id))) return f;
  }
  return null;
}

/** Flatten Block Kit rich_text blocks to plain text. */
function richTextToPlain(blocks) {
  if (!Array.isArray(blocks)) return "";
  let out = "";
  for (const block of blocks) {
    const sections = Array.isArray(block?.elements) ? block.elements : [];
    for (const section of sections) {
      const els = Array.isArray(section?.elements) ? section.elements : [];
      for (const el of els) {
        if (typeof el?.text === "string") out += el.text;
      }
    }
  }
  return out.trim();
}

/** Extract a plain-text string from a text/title cell. */
export function extractText(cell) {
  if (!cell) return "";
  if (typeof cell.text === "string" && cell.text.trim()) return cell.text.trim();
  if (Array.isArray(cell.rich_text)) {
    const t = richTextToPlain(cell.rich_text);
    if (t) return t;
  }
  if (typeof cell.value === "string") {
    const v = cell.value.trim();
    if (v.startsWith("[") || v.startsWith("{")) {
      try {
        const t = richTextToPlain(JSON.parse(v));
        if (t) return t;
      } catch {
        /* value was not JSON rich text – fall through to the raw string */
      }
    }
    return v;
  }
  if (cell.value != null) return String(cell.value);
  return "";
}

/** Extract a Slack user id ("U…"/"W…") from an assignee/user cell. */
export function extractUserId(cell) {
  if (!cell) return "";
  if (Array.isArray(cell.user) && cell.user.length) return String(cell.user[0]);
  if (Array.isArray(cell.value) && cell.value.length) return String(cell.value[0]);
  if (typeof cell.value === "string" && /^[UW][A-Z0-9]+$/i.test(cell.value.trim())) {
    return cell.value.trim();
  }
  return "";
}

// Date-only (no time) -> normalized UTC ISO, using a default wall-clock time in
// the given zone (so the output format matches the timestamp path exactly).
function dateOnlyToISO(dateStr, defaultDueTime, timeZone) {
  const local = localWallClockToISO(`${dateStr} ${defaultDueTime}`, timeZone);
  return new Date(local).toISOString();
}

function tsToISO(ts) {
  let n = Number(ts);
  if (!isFinite(n) || n <= 0) return "";
  // Slack unix timestamps are in seconds; guard against accidental ms values.
  if (n > 1e12) n = Math.floor(n / 1000);
  return new Date(n * 1000).toISOString();
}

/**
 * Extract an ISO deadline from a due-date cell. Prefers the exact `timestamp`;
 * falls back to a date-only value given a default wall-clock time.
 * @param {object} cell
 * @param {{defaultDueTime?:string, timeZone?:string}} opts
 * @returns {string} ISO 8601 string, or "" if nothing parseable.
 */
export function extractDeadlineISO(cell, opts = {}) {
  const defaultDueTime = opts.defaultDueTime || DEFAULT_LIST_DUE_TIME;
  const timeZone = opts.timeZone || STOCKHOLM_TZ;
  if (!cell) return "";
  if (Array.isArray(cell.timestamp) && cell.timestamp.length) {
    const iso = tsToISO(cell.timestamp[0]);
    if (iso) return iso;
  }
  if (Array.isArray(cell.date) && cell.date.length) {
    return dateOnlyToISO(cell.date[0], defaultDueTime, timeZone);
  }
  if (typeof cell.value === "number") {
    const iso = tsToISO(cell.value);
    if (iso) return iso;
  }
  if (typeof cell.value === "string") {
    const v = cell.value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      return dateOnlyToISO(v, defaultDueTime, timeZone);
    }
    const n = Number(v);
    if (isFinite(n) && n > 1e9) return tsToISO(n);
  }
  return "";
}

/**
 * Decide whether an item is "done" (NOT open). Checks the status cell's
 * select/value/text against DONE_WORDS and the item-level todo state.
 * @param {object} cell status cell
 * @param {object} item whole item (for item.saved.state)
 * @returns {boolean}
 */
export function extractIsDone(cell, item) {
  const candidates = [];
  if (cell) {
    if (Array.isArray(cell.select)) candidates.push(...cell.select);
    if (Array.isArray(cell.value)) candidates.push(...cell.value);
    else if (cell.value != null) candidates.push(cell.value);
    if (typeof cell.text === "string") candidates.push(cell.text);
    if (cell.checkbox === true) return true;
  }
  if (item && item.saved && item.saved.state != null) candidates.push(item.saved.state);
  return candidates.some((c) =>
    DONE_WORDS.some((w) => norm(c).includes(w))
  );
}

/**
 * Map a single Slack List item into the existing task shape.
 * @param {object} item
 * @param {object} columnMap from discoverColumns()
 * @param {{defaultDueTime?:string, timeZone?:string}} opts
 * @returns {object} task
 */
export function mapItemToTask(item, columnMap = {}, opts = {}) {
  const title = extractText(cellForColumn(item, columnMap.title)) || "(namnlös uppgift)";
  const assignee_slack_id = extractUserId(cellForColumn(item, columnMap.assignee));
  const deadline = extractDeadlineISO(cellForColumn(item, columnMap.deadline), opts);
  const done =
    extractIsDone(cellForColumn(item, columnMap.status), item) || item.archived === true;
  return {
    id: item.id,
    title,
    // Display name is not available from the List endpoint; the @-mention uses
    // assignee_slack_id, and mentionFor() already prefers it.
    assignee: "",
    assignee_slack_id,
    deadline,
    remind_hours_before: DEFAULT_REMIND_HOURS_BEFORE,
    status: done ? "done" : "open",
    reminded: false,
    source: "slack-list",
  };
}

/**
 * Map a full `slackLists.items.list` API response (with include_list) into
 * tasks. Pure/offline — used directly by tests.
 * @param {object} apiResponse
 * @param {{defaultDueTime?:string, timeZone?:string}} opts
 * @returns {{tasks:object[], columnMap:object, columns:object[]}}
 */
export function mapListResponse(apiResponse = {}, opts = {}) {
  const columns = extractColumns(apiResponse.list);
  const columnMap = discoverColumns(columns);
  const items = Array.isArray(apiResponse.items) ? apiResponse.items : [];
  const tasks = items
    .filter((it) => it && it.archived !== true)
    .map((it) => mapItemToTask(it, columnMap, opts))
    .filter((t) => t.deadline); // can't remind on an item with no due date
  return { tasks, columnMap, columns };
}

/**
 * Fetch raw items (+ parent list) from Slack, following cursor pagination.
 * @param {{token:string, listId:string, fetchImpl?:Function, archived?:boolean, maxPages?:number}} args
 * @returns {Promise<{items:object[], list:object|undefined}>}
 */
export async function fetchListItemsRaw({
  token,
  listId,
  fetchImpl = fetch,
  archived = false,
  maxPages = 50,
} = {}) {
  if (!token) throw new Error("SLACK_BOT_TOKEN saknas för att läsa Slack-listan.");
  if (!listId) throw new Error("SLACK_LIST_ID saknas för att läsa Slack-listan.");
  const items = [];
  let list;
  let cursor = "";
  let pages = 0;
  do {
    const body = { list_id: listId, limit: 1000, include_list: true };
    if (cursor) body.cursor = cursor;
    if (archived) body.archived = true;
    const res = await fetchImpl(SLACK_LISTS_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Slack API svarade HTTP ${res.status} ${res.statusText || ""}`.trim());
    }
    const data = await res.json();
    if (!data || data.ok !== true) {
      throw new Error(`Slack API-fel: ${(data && data.error) || "okänt fel"}`);
    }
    if (Array.isArray(data.items)) items.push(...data.items);
    if (!list && data.list) list = data.list;
    cursor = (data.response_metadata && data.response_metadata.next_cursor) || "";
    pages += 1;
  } while (cursor && pages < maxPages);
  return { items, list };
}

/**
 * High-level: fetch the List and return mapped tasks.
 * @param {{token:string, listId:string, fetchImpl?:Function, defaultDueTime?:string, timeZone?:string}} args
 * @returns {Promise<{tasks:object[], columnMap:object, columns:object[]}>}
 */
export async function fetchTasksFromList({
  token,
  listId,
  fetchImpl = fetch,
  defaultDueTime = DEFAULT_LIST_DUE_TIME,
  timeZone = STOCKHOLM_TZ,
} = {}) {
  const { items, list } = await fetchListItemsRaw({ token, listId, fetchImpl, archived: false });
  return mapListResponse({ items, list }, { defaultDueTime, timeZone });
}

// ---------------------------------------------------------------------------
// Idempotency / dedup for a LIVE List (which has no "reminded" flag we own).
// We persist a tiny state file keyed by `${item.id}::${deadline}`. Combined
// with the existing 2h-before time window (which already bounds repeats to that
// window), this makes each reminder fire at most once even across workflow runs.
// Including the deadline in the key means moving an item's due date correctly
// re-arms its reminder.
// ---------------------------------------------------------------------------

/** Stable dedup key for a task read from a List. */
export function reminderStateKey(task) {
  return `${task.id}::${task.deadline}`;
}

/** Mark tasks already reminded (per the state object) so shouldRemind skips them. */
export function applyReminderState(tasks, state = {}) {
  for (const t of tasks || []) {
    if (state && Object.prototype.hasOwnProperty.call(state, reminderStateKey(t))) {
      t.reminded = true;
    }
  }
  return tasks;
}

/** Record that a reminder was sent for a task. Mutates and returns `state`. */
export function recordReminderState(state, task, now = new Date()) {
  state[reminderStateKey(task)] = {
    remindedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    title: task.title,
  };
  return state;
}
