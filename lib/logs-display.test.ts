import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LOGS_DISPLAY_DEFAULTS as D,
  MAX_LOG_SIZE,
  MIN_LOG_SIZE,
  clampLogSize,
  parseLogsDisplay,
} from "./logs-display";

test("nothing stored yet reads as the default", () => {
  assert.deepEqual(parseLogsDisplay(null), D);
  assert.deepEqual(parseLogsDisplay(""), D);
});

test("a round trip keeps an offered value", () => {
  const stored = JSON.stringify({ size: 18, leading: 2 });
  assert.deepEqual(parseLogsDisplay(stored), { size: 18, leading: 2 });
});

// The value is user-writable: devtools, a stale build, a hand-edited key.
test("a hostile or stale value never reaches the CSS", () => {
  for (const raw of [
    "not json",
    "null",
    "[]",
    '{"size":"huge"}',
    '{"size":NaN}',
    "{}",
  ]) {
    assert.deepEqual(parseLogsDisplay(raw), D, raw);
  }
  assert.equal(parseLogsDisplay('{"size":9000}').size, MAX_LOG_SIZE);
  assert.equal(parseLogsDisplay('{"size":-5}').size, MIN_LOG_SIZE);
  assert.equal(parseLogsDisplay('{"size":13.6}').size, 14);
  // A leading we stopped offering falls back instead of being applied.
  assert.equal(parseLogsDisplay('{"leading":99}').leading, D.leading);
});

test("clamp holds the offered range", () => {
  assert.equal(clampLogSize(MIN_LOG_SIZE - 1), MIN_LOG_SIZE);
  assert.equal(clampLogSize(MAX_LOG_SIZE + 1), MAX_LOG_SIZE);
  assert.equal(clampLogSize(D.size), D.size);
});
