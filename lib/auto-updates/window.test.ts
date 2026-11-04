import { test } from "node:test";
import assert from "node:assert/strict";

import {
  currentSlot,
  describeAt,
  nextSlotAt,
  slotHours,
  wallClock,
  windowEndAfter,
} from "./window";

const at = (iso: string) => new Date(iso);

test("three hourly slots, wrapping past midnight", () => {
  assert.deepEqual(slotHours(2), [2, 3, 4]);
  assert.deepEqual(slotHours(23), [23, 0, 1]);
});

test("a slot is read on the window's own clock, not the panel's UTC", () => {
  // 01:30 UTC is 02:30 in Rome in November.
  const slot = currentSlot(at("2026-11-05T01:30:00Z"), 2, "Europe/Rome");
  assert.ok(slot);
  assert.equal(slot.start.toISOString(), "2026-11-05T01:00:00.000Z");
  assert.equal(slot.windowStart.toISOString(), "2026-11-05T01:00:00.000Z");
  assert.equal(slot.last, false);
  assert.equal(currentSlot(at("2026-11-05T02:30:00Z"), 2, "UTC")?.last, false);
  assert.equal(currentSlot(at("2026-11-05T04:59:00Z"), 2, "UTC")?.last, true);
  assert.equal(currentSlot(at("2026-11-05T05:00:00Z"), 2, "UTC"), null);
});

test("a window that crosses midnight starts the evening before", () => {
  const slot = currentSlot(at("2026-11-05T00:20:00Z"), 23, "UTC");
  assert.equal(slot?.windowStart.toISOString(), "2026-11-04T23:00:00.000Z");
});

test("the next slot is the next hour of the window, then the next night", () => {
  assert.equal(
    nextSlotAt(at("2026-11-05T02:10:00Z"), 2, "UTC")?.toISOString(),
    "2026-11-05T03:00:00.000Z",
  );
  assert.equal(
    nextSlotAt(at("2026-11-05T04:10:00Z"), 2, "UTC")?.toISOString(),
    "2026-11-06T02:00:00.000Z",
  );
});

test("postponing skips the window under way, or the next one", () => {
  assert.equal(
    windowEndAfter(at("2026-11-05T03:10:00Z"), 2, "UTC").toISOString(),
    "2026-11-05T05:00:00.000Z",
  );
  assert.equal(
    windowEndAfter(at("2026-11-05T12:00:00Z"), 2, "UTC").toISOString(),
    "2026-11-06T05:00:00.000Z",
  );
});

test("the night clocks go back still has three checks", () => {
  // 25 Oct 2026: Europe/Rome goes from +02:00 to +01:00 at 03:00.
  const first = nextSlotAt(at("2026-10-24T22:00:00Z"), 2, "Europe/Rome");
  assert.equal(first?.toISOString(), "2026-10-25T00:00:00.000Z");
  const slot = currentSlot(at("2026-10-25T02:30:00Z"), 2, "Europe/Rome");
  assert.ok(slot, "03:30 local is the second check");
});

test("times read relative to now, and absolute for text kept in the log", () => {
  const now = at("2026-11-05T12:00:00Z");
  assert.equal(describeAt(at("2026-11-05T15:00:00Z"), now, "UTC"), "at 15:00");
  assert.equal(
    describeAt(at("2026-11-06T02:00:00Z"), now, "UTC"),
    "tomorrow at 02:00",
  );
  assert.equal(
    describeAt(at("2026-11-08T02:00:00Z"), now, "UTC"),
    "on 8 Nov at 02:00",
  );
  assert.equal(
    wallClock(at("2026-11-06T01:00:00Z"), "Europe/Rome"),
    "6 Nov at 02:00",
  );
});
