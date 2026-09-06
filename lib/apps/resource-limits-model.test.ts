import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY_RESOURCE_FORM,
  resourcesToForm,
  formToLimitsInput,
  serializeResourceForm,
  activeResourcePreset,
  RESOURCE_PRESETS,
  sizeFitsHost,
  usagePeak,
  suggestedSize,
  fmtMemMb,
  fmtCpu,
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
  assert.equal(
    formToLimitsInput({ ...EMPTY_RESOURCE_FORM, cpuCores: "0.5" }).cpuMilli,
    500,
  );
  assert.equal(
    formToLimitsInput({ ...EMPTY_RESOURCE_FORM, cpuCores: "2" }).cpuMilli,
    2000,
  );
});

test("empty strings clear a dimension (→ null)", () => {
  const input = formToLimitsInput(EMPTY_RESOURCE_FORM);
  assert.equal(
    Object.values(input).every((v) => v === null),
    true,
  );
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
  const form = {
    ...EMPTY_RESOURCE_FORM,
    memoryMb: String(small.memoryMb),
    cpuCores: String(small.cpuCores),
  };
  assert.equal(activeResourcePreset(form)?.label, "Small");
  // A tweaked memory value no longer matches any preset.
  assert.equal(activeResourcePreset({ ...form, memoryMb: "1000" }), undefined);
});

test("a size fits an unknown host, and a known host on both axes", () => {
  const small = RESOURCE_PRESETS[2]; // 1 GB, 1 CPU
  assert.equal(sizeFitsHost(small, null), true);
  assert.equal(sizeFitsHost(small, { memoryMb: 0, cpuCores: 0 }), true);
  assert.equal(sizeFitsHost(small, { memoryMb: 2048, cpuCores: 2 }), true);
  assert.equal(sizeFitsHost(small, { memoryMb: 512, cpuCores: 2 }), false);
  assert.equal(sizeFitsHost(small, { memoryMb: 2048, cpuCores: 0.5 }), false);
});

test("the peak of a window is its highest memory and CPU, in form units", () => {
  assert.equal(usagePeak([]), null);
  assert.equal(usagePeak([{ memUsed: 0, cpu: 0 }]), null);
  const peak = usagePeak([
    { memUsed: 100 * 1048576, cpu: 20 },
    { memUsed: 480 * 1048576, cpu: 5 },
    { memUsed: 200 * 1048576, cpu: 150 },
  ]);
  assert.deepEqual(peak, { memoryMb: 480, cpuCores: 1.5 });
});

test("the suggestion is the smallest preset with 1.5x headroom that fits", () => {
  // 480 MB × 1.5 = 720 → Small (1 GB); 0.4 CPU × 1.5 = 0.6 → Small too.
  assert.equal(
    suggestedSize({ memoryMb: 480, cpuCores: 0.4 }, null)?.label,
    "Small",
  );
  // CPU alone can push the size up: 1.5 cores needs 2.25 → Large.
  assert.equal(
    suggestedSize({ memoryMb: 480, cpuCores: 1.5 }, null)?.label,
    "Large",
  );
  // A host too small for Large skips it: nothing preset fits, so 2x rounded.
  assert.deepEqual(
    suggestedSize(
      { memoryMb: 480, cpuCores: 1.5 },
      { memoryMb: 3072, cpuCores: 4 },
    ),
    { label: "Custom", memoryMb: 1024, cpuCores: 3 },
  );
  // Past every preset: twice the peak, rounded up to 256 MB / 0.25 CPU.
  assert.deepEqual(suggestedSize({ memoryMb: 3000, cpuCores: 2.1 }, null), {
    label: "Custom",
    memoryMb: 6144,
    cpuCores: 4.25,
  });
  // No headroom on the host at all: no suggestion rather than a wrong one.
  assert.equal(
    suggestedSize(
      { memoryMb: 3000, cpuCores: 2.1 },
      { memoryMb: 4096, cpuCores: 4 },
    ),
    null,
  );
});

test("sizes format in the form's own units", () => {
  assert.equal(fmtMemMb(256), "256 MB");
  assert.equal(fmtMemMb(1024), "1 GB");
  assert.equal(fmtMemMb(1536), "1.5 GB");
  assert.equal(fmtCpu(0.25), "0.25 CPU");
  assert.equal(fmtCpu(1), "1 CPU");
  assert.equal(fmtCpu(2), "2 CPUs");
  assert.equal(fmtCpu(1.1), "1.1 CPUs");
});
