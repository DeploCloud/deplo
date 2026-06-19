import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CAPABILITY_PRESETS,
  capabilitiesForRole,
  roleLabelForCapabilities,
} from "./membership-shared";
import { ALL_CAPABILITIES } from "./types";

test("owner preset grants every capability", () => {
  assert.equal(CAPABILITY_PRESETS.owner.length, ALL_CAPABILITIES.length);
  for (const cap of ALL_CAPABILITIES) {
    assert.ok(CAPABILITY_PRESETS.owner.includes(cap), `owner missing ${cap}`);
  }
});

test("viewer preset is read-only", () => {
  assert.deepEqual(CAPABILITY_PRESETS.viewer, ["view"]);
});

test("member can deploy + manage domains/env but not the team or members", () => {
  const m = CAPABILITY_PRESETS.member;
  assert.ok(m.includes("deploy"));
  assert.ok(m.includes("manage_domains"));
  assert.ok(m.includes("manage_env"));
  assert.ok(!m.includes("manage_team"));
  assert.ok(!m.includes("manage_members"));
  assert.ok(!m.includes("manage_infra"));
});

test("capabilitiesForRole returns a fresh copy (not the preset reference)", () => {
  const caps = capabilitiesForRole("member");
  caps.push("manage_team");
  assert.ok(!CAPABILITY_PRESETS.member.includes("manage_team"));
});

test("roleLabelForCapabilities recognizes exact presets, else 'custom'", () => {
  assert.equal(roleLabelForCapabilities(capabilitiesForRole("owner")), "owner");
  assert.equal(roleLabelForCapabilities(capabilitiesForRole("viewer")), "viewer");
  assert.equal(roleLabelForCapabilities(capabilitiesForRole("member")), "member");
  assert.equal(roleLabelForCapabilities(["view", "deploy"]), "custom");
});
