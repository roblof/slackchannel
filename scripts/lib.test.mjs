// Tests for the reminder logic. Run with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shouldRemind,
  dueReminders,
  buildSlackMessage,
  mentionFor,
  formatDeadline,
  localWallClockToISO,
  getTimeZoneOffsetMinutes,
  formatOffset,
  remindHoursBefore,
} from "./lib.mjs";

function baseTask(overrides = {}) {
  return {
    id: "t1",
    title: "Lever rapport",
    assignee: "Anna",
    assignee_slack_id: "U0123ABCD",
    deadline: "2026-11-25T15:00:00+01:00", // winter / CET
    remind_hours_before: 2,
    status: "open",
    reminded: false,
    ...overrides,
  };
}

test("fires exactly inside the 2h window", () => {
  const task = baseTask();
  // deadline 15:00 CET == 14:00Z; window opens 12:00Z; now 13:00Z is inside.
  const now = new Date("2026-11-25T13:00:00Z");
  assert.equal(shouldRemind(task, now), true);
});

test("fires right at the window start (inclusive)", () => {
  const task = baseTask();
  const now = new Date("2026-11-25T12:00:00Z"); // exactly deadline-2h
  assert.equal(shouldRemind(task, now), true);
});

test("does NOT fire too early (before the window opens)", () => {
  const task = baseTask();
  const now = new Date("2026-11-25T11:59:00Z"); // one minute before window
  assert.equal(shouldRemind(task, now), false);
});

test("does NOT fire after the deadline has passed", () => {
  const task = baseTask();
  const now = new Date("2026-11-25T14:00:01Z"); // just past 15:00 CET
  assert.equal(shouldRemind(task, now), false);
});

test("does NOT fire exactly at the deadline (exclusive upper bound)", () => {
  const task = baseTask();
  const now = new Date("2026-11-25T14:00:00Z"); // == 15:00 CET deadline
  assert.equal(shouldRemind(task, now), false);
});

test("does NOT fire when status is done", () => {
  const task = baseTask({ status: "done" });
  const now = new Date("2026-11-25T13:00:00Z");
  assert.equal(shouldRemind(task, now), false);
});

test("does NOT fire when already reminded", () => {
  const task = baseTask({ reminded: true });
  const now = new Date("2026-11-25T13:00:00Z");
  assert.equal(shouldRemind(task, now), false);
});

test("DST winter (CET, +01:00): window math uses the stored offset", () => {
  // Winter deadline 15:00+01:00 == 14:00Z. Window: 12:00Z..14:00Z.
  const task = baseTask({ deadline: "2026-01-20T15:00:00+01:00" });
  assert.equal(shouldRemind(task, new Date("2026-01-20T12:30:00Z")), true);
  assert.equal(shouldRemind(task, new Date("2026-01-20T11:30:00Z")), false);
});

test("DST summer (CEST, +02:00): window math uses the stored offset", () => {
  // Summer deadline 15:00+02:00 == 13:00Z. Window: 11:00Z..13:00Z.
  const task = baseTask({ deadline: "2026-07-20T15:00:00+02:00" });
  assert.equal(shouldRemind(task, new Date("2026-07-20T11:30:00Z")), true);
  // 12:30Z UTC would be 13:30 CET in winter but is inside summer window:
  assert.equal(shouldRemind(task, new Date("2026-07-20T12:30:00Z")), true);
  // Too early in summer: 10:30Z is before the 11:00Z window.
  assert.equal(shouldRemind(task, new Date("2026-07-20T10:30:00Z")), false);
});

test("same wall-clock reminder time differs by one hour between winter and summer", () => {
  // Both tasks have deadline 15:00 local Stockholm, 2h before.
  const winter = baseTask({ deadline: "2026-01-20T15:00:00+01:00" });
  const summer = baseTask({ deadline: "2026-07-20T15:00:00+02:00" });
  // Winter window opens at 12:00Z, summer at 11:00Z -> one hour apart in UTC.
  assert.equal(shouldRemind(winter, new Date("2026-01-20T12:00:00Z")), true);
  assert.equal(shouldRemind(summer, new Date("2026-07-20T11:00:00Z")), true);
});

test("respects a custom remind_hours_before", () => {
  const task = baseTask({ remind_hours_before: 5 });
  // deadline 14:00Z; window opens 09:00Z.
  assert.equal(shouldRemind(task, new Date("2026-11-25T09:30:00Z")), true);
  assert.equal(shouldRemind(task, new Date("2026-11-25T08:30:00Z")), false);
});

test("remindHoursBefore defaults to 2 when missing/invalid", () => {
  assert.equal(remindHoursBefore({}), 2);
  assert.equal(remindHoursBefore({ remind_hours_before: "x" }), 2);
  assert.equal(remindHoursBefore({ remind_hours_before: 3 }), 3);
});

test("dueReminders returns only tasks that fire now", () => {
  const now = new Date("2026-11-25T13:00:00Z");
  const tasks = [
    baseTask({ id: "fire" }),
    baseTask({ id: "done", status: "done" }),
    baseTask({ id: "already", reminded: true }),
    baseTask({ id: "future", deadline: "2026-12-25T15:00:00+01:00" }),
  ];
  const due = dueReminders(tasks, now);
  assert.deepEqual(
    due.map((t) => t.id),
    ["fire"]
  );
});

test("mentionFor uses Slack id when present, else display name", () => {
  assert.equal(mentionFor(baseTask()), "<@U0123ABCD>");
  assert.equal(mentionFor(baseTask({ assignee_slack_id: "" })), "Anna");
});

test("buildSlackMessage mentions assignee and title", () => {
  const now = new Date("2026-11-25T13:00:00Z");
  const msg = buildSlackMessage(baseTask(), now);
  assert.match(msg.text, /<@U0123ABCD>/);
  assert.match(msg.text, /Lever rapport/);
  assert.match(msg.text, /1 timme/); // one hour until 14:00Z deadline
});

test("formatDeadline renders in Europe/Stockholm", () => {
  const s = formatDeadline("2026-11-25T15:00:00+01:00");
  assert.match(s, /15:00/);
  assert.match(s, /november/);
});

// --- DST offset / local->ISO conversion (used by add-task workflow) ---

test("getTimeZoneOffsetMinutes: CET=60 in winter, CEST=120 in summer", () => {
  assert.equal(
    getTimeZoneOffsetMinutes(new Date("2026-01-20T12:00:00Z")),
    60
  );
  assert.equal(
    getTimeZoneOffsetMinutes(new Date("2026-07-20T12:00:00Z")),
    120
  );
});

test("formatOffset formats minutes as ISO offset", () => {
  assert.equal(formatOffset(60), "+01:00");
  assert.equal(formatOffset(120), "+02:00");
  assert.equal(formatOffset(0), "+00:00");
});

test("localWallClockToISO picks +01:00 in winter", () => {
  assert.equal(
    localWallClockToISO("2026-11-25 15:00"),
    "2026-11-25T15:00:00+01:00"
  );
});

test("localWallClockToISO picks +02:00 in summer", () => {
  assert.equal(
    localWallClockToISO("2026-07-20 15:00"),
    "2026-07-20T15:00:00+02:00"
  );
});

test("localWallClockToISO round-trips to the intended instant (winter)", () => {
  const iso = localWallClockToISO("2026-11-25 15:00");
  assert.equal(new Date(iso).toISOString(), "2026-11-25T14:00:00.000Z");
});

test("localWallClockToISO round-trips to the intended instant (summer)", () => {
  const iso = localWallClockToISO("2026-07-20 15:00");
  assert.equal(new Date(iso).toISOString(), "2026-07-20T13:00:00.000Z");
});

test("localWallClockToISO rejects a bad format", () => {
  assert.throws(() => localWallClockToISO("25/11/2026 3pm"));
});
