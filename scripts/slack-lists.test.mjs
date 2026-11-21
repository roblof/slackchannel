// Tests for the Slack List -> task mapping. Run with: node --test
// NO real Slack API is called; a mocked slackLists.items.list response is used.
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldRemind, dueReminders } from "./lib.mjs";
import {
  discoverColumns,
  mapListResponse,
  mapItemToTask,
  extractText,
  extractUserId,
  extractDeadlineISO,
  extractIsDone,
  fetchListItemsRaw,
  fetchTasksFromList,
  reminderStateKey,
  applyReminderState,
  recordReminderState,
} from "./slack-lists.mjs";

// Unix seconds for 2026-11-25T15:00:00+01:00 (== 14:00:00Z).
const DUE_TS = Math.floor(new Date("2026-11-25T15:00:00+01:00").getTime() / 1000);

// A realistic parent-list column schema (Norwegian names + Slack column types).
const COLUMNS = [
  { id: "Col01", name: "Oppgave", type: "text", is_primary_column: true },
  { id: "Col02", name: "Ansvarlig", type: "todo_assignee" },
  { id: "Col03", name: "Frist", type: "todo_due_date" },
  { id: "Col04", name: "Status", type: "select" },
  { id: "Col05", name: "Prioritet", type: "select" },
];

// A realistic slackLists.items.list response (include_list=true).
function apiResponse() {
  return {
    ok: true,
    list: { id: "F1234567", title: "Oppgaver", columns: COLUMNS },
    items: [
      {
        // Open task, due with an exact timestamp.
        id: "Rec001",
        list_id: "F1234567",
        date_created: 1758744346,
        archived: false,
        saved: { state: "in_progress" },
        fields: [
          { column_id: "Col01", key: "oppgave", text: "Lever månadsrapport", value: "Lever månadsrapport" },
          { column_id: "Col02", key: "ansvarlig", user: ["U0123ABCD"] },
          { column_id: "Col03", key: "frist", date: ["2026-11-25"], timestamp: [DUE_TS] },
          { column_id: "Col04", key: "status", select: ["Scopt"], value: "Pågår" },
          { column_id: "Col05", key: "prioritet", select: ["Schigh"], value: "Hög" },
        ],
      },
      {
        // Done via status value word ("Ferdig").
        id: "Rec002",
        list_id: "F1234567",
        archived: false,
        saved: { state: "in_progress" },
        fields: [
          { column_id: "Col01", text: "Bestill kontormateriell" },
          { column_id: "Col02", user: ["U0456WXYZ"] },
          { column_id: "Col03", timestamp: [DUE_TS] },
          { column_id: "Col04", select: ["Scdone"], value: "Ferdig" },
        ],
      },
      {
        // Done via item-level todo state (completed) even though status value is opaque.
        id: "Rec003",
        list_id: "F1234567",
        archived: false,
        saved: { state: "completed" },
        fields: [
          { column_id: "Col01", text: "Planlegg sommerfest" },
          { column_id: "Col03", timestamp: [DUE_TS] },
          { column_id: "Col04", select: ["Sc0ff"] },
        ],
      },
      {
        // Archived item -> must be dropped entirely.
        id: "Rec004",
        list_id: "F1234567",
        archived: true,
        fields: [
          { column_id: "Col01", text: "Gammal arkiverad uppgift" },
          { column_id: "Col03", timestamp: [DUE_TS] },
        ],
      },
      {
        // Date-only due date -> default wall-clock time applied.
        id: "Rec005",
        list_id: "F1234567",
        archived: false,
        fields: [
          { column_id: "Col01", text: "Signera avtal" },
          { column_id: "Col02", user: ["U0789QRST"] },
          { column_id: "Col03", date: ["2026-11-25"] },
          { column_id: "Col04", value: "Åpen" },
        ],
      },
    ],
    response_metadata: { next_cursor: "" },
  };
}

test("discoverColumns maps roles by fuzzy name (Norwegian) + type hints", () => {
  const map = discoverColumns(COLUMNS);
  assert.equal(map.title.id, "Col01");
  assert.equal(map.assignee.id, "Col02");
  assert.equal(map.deadline.id, "Col03");
  assert.equal(map.status.id, "Col04");
  assert.equal(map.priority.id, "Col05");
});

test("discoverColumns handles Swedish and English column names", () => {
  const sv = discoverColumns([
    { id: "a", name: "Uppgift", type: "text", is_primary_column: true },
    { id: "b", name: "Ansvarig", type: "user" },
    { id: "c", name: "Deadline", type: "date" },
    { id: "d", name: "Status", type: "select" },
  ]);
  assert.equal(sv.title.id, "a");
  assert.equal(sv.assignee.id, "b");
  assert.equal(sv.deadline.id, "c");
  assert.equal(sv.status.id, "d");

  const en = discoverColumns([
    { id: "1", name: "Task", type: "text", is_primary_column: true },
    { id: "2", name: "Assignee", type: "todo_assignee" },
    { id: "3", name: "Due date", type: "todo_due_date" },
  ]);
  assert.equal(en.title.id, "1");
  assert.equal(en.assignee.id, "2");
  assert.equal(en.deadline.id, "3");
});

test("mapListResponse maps the open task into the existing task shape", () => {
  const { tasks } = mapListResponse(apiResponse());
  const t = tasks.find((x) => x.id === "Rec001");
  assert.ok(t, "open task present");
  assert.equal(t.title, "Lever månadsrapport");
  assert.equal(t.assignee_slack_id, "U0123ABCD");
  assert.equal(t.deadline, "2026-11-25T14:00:00.000Z"); // 15:00+01:00
  assert.equal(t.remind_hours_before, 2);
  assert.equal(t.status, "open");
  assert.equal(t.reminded, false);
  assert.equal(t.source, "slack-list");
});

test("done items (status word AND todo state) map to status != open", () => {
  const { tasks } = mapListResponse(apiResponse());
  assert.equal(tasks.find((x) => x.id === "Rec002").status, "done");
  assert.equal(tasks.find((x) => x.id === "Rec003").status, "done");
});

test("archived items are filtered out", () => {
  const { tasks } = mapListResponse(apiResponse());
  assert.equal(tasks.find((x) => x.id === "Rec004"), undefined);
});

test("date-only due dates get the default wall-clock time (Europe/Stockholm)", () => {
  const { tasks } = mapListResponse(apiResponse(), { defaultDueTime: "17:00" });
  const t = tasks.find((x) => x.id === "Rec005");
  // 2026-11-25 17:00 Stockholm (CET, +01:00) == 16:00:00Z
  assert.equal(t.deadline, "2026-11-25T16:00:00.000Z");
});

test("shouldRemind fires for a due open task and skips done ones", () => {
  const { tasks } = mapListResponse(apiResponse());
  const now = new Date("2026-11-25T13:00:00Z"); // inside 12:00-14:00Z window
  const open = tasks.find((x) => x.id === "Rec001");
  const done = tasks.find((x) => x.id === "Rec002");
  assert.equal(shouldRemind(open, now), true);
  assert.equal(shouldRemind(done, now), false);
  // Only the open, due task fires.
  assert.deepEqual(
    dueReminders(tasks, now).map((t) => t.id),
    ["Rec001"]
  );
});

test("shouldRemind does not fire before the window opens", () => {
  const { tasks } = mapListResponse(apiResponse());
  const tooEarly = new Date("2026-11-25T11:00:00Z"); // before 12:00Z window
  assert.equal(dueReminders(tasks, tooEarly).length, 0);
});

test("fetchListItemsRaw follows cursor pagination and captures the list schema", async () => {
  const calls = [];
  const page1 = {
    ok: true,
    list: { id: "F1234567", title: "Oppgaver", columns: COLUMNS },
    items: [{ id: "A", archived: false, fields: [] }],
    response_metadata: { next_cursor: "CURSOR2" },
  };
  const page2 = {
    ok: true,
    items: [{ id: "B", archived: false, fields: [] }],
    response_metadata: { next_cursor: "" },
  };
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, auth: opts.headers.Authorization, body });
    return { ok: true, json: async () => (body.cursor ? page2 : page1) };
  };
  const { items, list } = await fetchListItemsRaw({
    token: "xoxb-test",
    listId: "F1234567",
    fetchImpl,
  });
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.id), ["A", "B"]);
  assert.equal(list.title, "Oppgaver");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].auth, "Bearer xoxb-test");
  assert.equal(calls[0].body.list_id, "F1234567");
  assert.equal(calls[0].body.include_list, true);
  assert.equal(calls[1].body.cursor, "CURSOR2");
});

test("fetchTasksFromList end-to-end via a mocked fetch", async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => apiResponse() });
  const { tasks } = await fetchTasksFromList({
    token: "xoxb-test",
    listId: "F1234567",
    fetchImpl,
  });
  // Rec004 archived dropped; all others have a deadline -> 4 tasks.
  assert.deepEqual(tasks.map((t) => t.id).sort(), ["Rec001", "Rec002", "Rec003", "Rec005"]);
});

test("fetchListItemsRaw throws on an API error payload", async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ ok: false, error: "missing_scope" }) });
  await assert.rejects(
    fetchListItemsRaw({ token: "x", listId: "F1", fetchImpl }),
    /missing_scope/
  );
});

test("fetchListItemsRaw requires token and list id", async () => {
  await assert.rejects(fetchListItemsRaw({ listId: "F1" }), /SLACK_BOT_TOKEN/);
  await assert.rejects(fetchListItemsRaw({ token: "x" }), /SLACK_LIST_ID/);
});

test("reminder state dedup marks tasks as reminded", () => {
  const { tasks } = mapListResponse(apiResponse());
  const open = tasks.find((x) => x.id === "Rec001");
  const state = {};
  const now = new Date("2026-11-25T13:00:00Z");
  recordReminderState(state, open, now);
  assert.ok(state[reminderStateKey(open)]);
  // Re-reading the list and applying state should mark it reminded -> skipped.
  const { tasks: again } = mapListResponse(apiResponse());
  applyReminderState(again, state);
  const open2 = again.find((x) => x.id === "Rec001");
  assert.equal(open2.reminded, true);
  assert.equal(shouldRemind(open2, now), false);
});

test("a changed deadline re-arms the reminder (new state key)", () => {
  const { tasks } = mapListResponse(apiResponse());
  const open = tasks.find((x) => x.id === "Rec001");
  const state = {};
  recordReminderState(state, open, new Date("2026-11-25T13:00:00Z"));
  // Simulate the owner moving the due date: different deadline -> different key.
  const moved = { ...open, deadline: "2026-12-01T14:00:00.000Z" };
  applyReminderState([moved], state);
  assert.equal(moved.reminded, false);
});

// --- cell extractor unit tests (shape robustness) ---

test("extractText reads text, rich_text, and JSON-encoded value", () => {
  assert.equal(extractText({ text: "Hello" }), "Hello");
  assert.equal(
    extractText({
      rich_text: [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "Rikt" }] }] }],
    }),
    "Rikt"
  );
  assert.equal(extractText({ value: "Plain" }), "Plain");
  assert.equal(extractText(null), "");
});

test("extractUserId reads a user array or a bare id string", () => {
  assert.equal(extractUserId({ user: ["U999"] }), "U999");
  assert.equal(extractUserId({ value: "W123" }), "W123");
  assert.equal(extractUserId({ value: "not an id" }), "");
  assert.equal(extractUserId(null), "");
});

test("extractDeadlineISO prefers timestamp, falls back to date-only", () => {
  assert.equal(extractDeadlineISO({ timestamp: [DUE_TS] }), "2026-11-25T14:00:00.000Z");
  assert.equal(
    extractDeadlineISO({ date: ["2026-11-25"] }, { defaultDueTime: "17:00" }),
    "2026-11-25T16:00:00.000Z"
  );
  assert.equal(extractDeadlineISO({}), "");
});

test("extractIsDone matches done words and the todo completed state", () => {
  assert.equal(extractIsDone({ value: "Ferdig" }), true);
  assert.equal(extractIsDone({ select: ["completed"] }), true);
  assert.equal(extractIsDone({ value: "Pågår" }, { saved: { state: "completed" } }), true);
  assert.equal(extractIsDone({ value: "Pågår" }, { saved: { state: "in_progress" } }), false);
  assert.equal(extractIsDone({ checkbox: true }), true);
});

test("mapItemToTask gives a safe fallback title when none is found", () => {
  const map = discoverColumns(COLUMNS);
  const t = mapItemToTask({ id: "X", fields: [{ column_id: "Col03", timestamp: [DUE_TS] }] }, map);
  assert.equal(t.title, "(namnlös uppgift)");
});
