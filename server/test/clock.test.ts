import { test } from "node:test";
import assert from "node:assert/strict";
import { localClock } from "../src/dates.js";

test("TestDates_LocalClockConvertsUtcInstants", () => {
  const prev = process.env.TZ;
  // The brief showed CalDAV events at their UTC time (09:30 in Chicago read 15:30).
  const at = new Date(2026, 10, 12, 9, 30); // 09:30 local, whatever TZ the test runs in
  assert.equal(localClock(at.toISOString()), "09:30");
  assert.equal(localClock("2026-11-12T18:30"), "18:30", "a floating local time is kept");
  assert.equal(localClock("2026-11-12"), "", "an all-day date has no time");
  process.env.TZ = prev;
});
