import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY_RESOURCE_FORM,
  resourcesToForm,
  formToLimitsInput,
  serializeResourceForm,
  activeResourcePreset,
  RESOURCE_PRESETS,
} from "./resource-limits-model";
import type { ResourceLimits } from "../types";

/**
 * The Resources form's pure data model: string ⇄ number mapping (notably CPU
 * cores ⇄ milli-CPUs), ""→null clearing, dirty-key stability, and preset match.
 * This is the UI's only non-declarative logic, so it's tested without a browser.
 */

function mk(p: Partial<ResourceLimits>): ResourceLimits {
  return {
    memoryMb: null,
    memoryReservationMb: null,
    swapMb: null,
    cpuMilli: null,
    cpuShares: null,
    cpuset: null,
    pidsLimit: null,
    shmSizeMb: null,
    storageGb: null,
    nofile: null,
    nproc: null,
    oomScoreAdj: null,
    ...p,
  };
}

test("null limits ⇒ every field blank", () => {
  assert.deepEqual(resourcesToForm(null), EMPTY_RESOURCE_FORM);
});

test("CPU is shown in cores but round-trips to milli-CPUs", () => {
  assert.equal(resourcesToForm(mk({ cpuMilli: 500 })).cpuCores, "0.5");
  assert.equal(resourcesToForm(mk({ cpuMilli: 2000 })).cpuCores, "2");
  assert.equal(formToLimitsInput({ ...EMPTY_RESOURCE_FORM, cpuCores: "0.5" }).cpuMilli, 500);
  assert.equal(formToLimitsInput({ ...EMPTY_RESOURCE_FORM, cpuCores: "2" }).cpuMilli, 2000);
});

test("empty strings clear a dimension (→ null)", () => {
  const input = formToLimitsInput(EMPTY_RESOURCE_FORM);
  assert.equal(Object.values(input).every((v) => v === null), true);
});

test("form → input round-trips a full ResourceLimits", () => {
  const r = mk({
    memoryMb: 512,
    memoryReservationMb: 256,
    swapMb: 1024,
    cpuMilli: 1500,
    cpuShares: 1024,
    cpuset: "0-3",
    pidsLimit: 200,
    shmSizeMb: 64,
    storageGb: 20,
    nofile: 4096,
    nproc: 512,
    oomScoreAdj: -500,
  });
  const back = formToLimitsInput(resourcesToForm(r));
  assert.deepEqual(back, {
    memoryMb: 512,
    memoryReservationMb: 256,
    swapMb: 1024,
    cpuMilli: 1500,
    cpuShares: 1024,
    cpuset: "0-3",
    pidsLimit: 200,
    shmSizeMb: 64,
    storageGb: 20,
    nofile: 4096,
    nproc: 512,
    oomScoreAdj: -500,
  });
});

test("dirty key is stable: a form built from saved limits matches its snapshot", () => {
  const r = mk({ memoryMb: 512, cpuMilli: 500 });
  const a = serializeResourceForm(resourcesToForm(r));
  const b = serializeResourceForm(resourcesToForm(r));
  assert.equal(a, b);
  // A change flips the key.
  const edited = { ...resourcesToForm(r), memoryMb: "1024" };
  assert.notEqual(serializeResourceForm(edited), a);
});

test("preset detection matches Memory + CPU exactly", () => {
  const small = RESOURCE_PRESETS.find((p) => p.label === "Small")!;
  const form = { ...EMPTY_RESOURCE_FORM, memoryMb: String(small.memoryMb), cpuCores: String(small.cpuCores) };
  assert.equal(activeResourcePreset(form)?.label, "Small");
  // A tweaked memory value no longer matches any preset.
  assert.equal(activeResourcePreset({ ...form, memoryMb: "1000" }), undefined);
});
