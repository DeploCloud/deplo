import { test } from "node:test";
import assert from "node:assert/strict";

import { joinNames, revokeDescription, revokeTitle } from "./revoke-copy";

/**
 * What Revoke promises, against what `revokeToken` does.
 *
 * The button removes the ACTIVE team's access and leaves the rest, so the one
 * thing this copy must never do is claim a credential is gone when it is still
 * driving another team. Pure functions, so pinning it costs nothing.
 */

const A = { id: "team_a", name: "Acme" };
const B = { id: "team_b", name: "Beta" };
const C = { id: "team_c", name: "Gamma" };

test("a credential that only reaches this team keeps the old, true sentence", () => {
  const input = {
    kind: "client" as const,
    teams: [A],
    activeTeamId: A.id,
    scoped: true,
  };
  assert.equal(revokeTitle("Claude", input), "Revoke Claude?");
  assert.match(revokeDescription(input), /connected again from scratch/);
});

test("a multi-team connection names what it loses and what survives", () => {
  const input = {
    kind: "client" as const,
    teams: [A, B, C],
    activeTeamId: A.id,
    scoped: true,
  };
  assert.equal(revokeTitle("Claude", input), "Revoke Claude from Acme?");
  const text = revokeDescription(input);
  assert.match(text, /loses access to Acme/);
  assert.match(text, /stays connected to Beta and Gamma/);
});

test("an unscoped token really is revoked everywhere, and says so", () => {
  // No per-team grant to take away: its reach is "every team the creator
  // belongs to", so the old sentence is the correct one.
  const input = {
    kind: "token" as const,
    teams: [],
    activeTeamId: A.id,
    scoped: false,
  };
  assert.equal(revokeTitle("CI", input), "Revoke CI?");
  assert.match(revokeDescription(input), /Every client using it loses access/);
});

test("joinNames reads like a sentence at every length", () => {
  assert.equal(joinNames([]), "");
  assert.equal(joinNames(["Acme"]), "Acme");
  assert.equal(joinNames(["Acme", "Beta"]), "Acme and Beta");
  assert.equal(joinNames(["Acme", "Beta", "Gamma"]), "Acme, Beta and Gamma");
});
