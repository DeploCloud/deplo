import { test } from "node:test";
import assert from "node:assert/strict";

import { mapResources, parseCpuMilli, parseMemoryMb } from "./app-settings";

test("parseMemoryMb reads docker's suffixes and a bare byte count", () => {
  assert.equal(parseMemoryMb("512m"), 512);
  assert.equal(parseMemoryMb("1g"), 1024);
  assert.equal(parseMemoryMb("1.5Gi"), 1536);
  assert.equal(parseMemoryMb("2048k"), 2);
  assert.equal(parseMemoryMb("1073741824"), 1024);
  assert.equal(parseMemoryMb("nonsense"), null);
  assert.equal(parseMemoryMb("0"), null);
  assert.equal(parseMemoryMb(null), null);
});

test("parseCpuMilli splits cores from nano-CPUs", () => {
  assert.equal(parseCpuMilli("0.5"), 500);
  assert.equal(parseCpuMilli("2"), 2000);
  assert.equal(parseCpuMilli("500000000"), 500);
  assert.equal(parseCpuMilli("0.001"), null);
  assert.equal(parseCpuMilli(""), null);
});

test("mapResources returns null when Dokploy set no limits", () => {
  assert.deepEqual(mapResources({}), { value: null, notes: [] });
});

test("mapResources carries what it can and reports what it cannot", () => {
  const { value, notes } = mapResources({
    memoryLimit: "1g",
    memoryReservation: "256m",
    cpuLimit: "0.5",
    cpuReservation: "0.25",
  });
  assert.deepEqual(value, {
    memoryMb: 1024,
    memoryReservationMb: 256,
    cpuMilli: 500,
  });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /CPU reservation/);
});

test("mapResources drops a reservation above the limit rather than losing both", () => {
  const { value, notes } = mapResources({
    memoryLimit: "256m",
    memoryReservation: "1g",
  });
  assert.deepEqual(value, {
    memoryMb: 256,
    memoryReservationMb: null,
    cpuMilli: null,
  });
  assert.match(notes.join(" "), /above the limit/);
});

test("mapResources reports a limit it could not read", () => {
  const { notes } = mapResources({ memoryLimit: "loads" });
  assert.match(notes.join(" "), /set it by hand/);
});

test("`0` in a limit column is no limit, not an unreadable value", () => {
  const { value, notes } = mapResources({
    memoryLimit: "0",
    memoryReservation: "0",
    cpuLimit: "0",
    cpuReservation: "0",
  });
  assert.equal(value, null);
  assert.deepEqual(notes, []);
  assert.equal(mapResources({ memoryLimit: "lots" }).notes.length, 1);
});
