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
  const input = { teams: [A], activeTeamId: A.id, scoped: true };
  assert.equal(revokeTitle("CI", input), "Revoke CI?");
  assert.match(revokeDescription(input), /Every client using it loses access/);
});

test("a multi-team token names what it loses and what survives", () => {
  const input = { teams: [A, B, C], activeTeamId: A.id, scoped: true };
  assert.equal(revokeTitle("CI", input), "Revoke CI from Acme?");
  const text = revokeDescription(input);
  assert.match(text, /loses access to Acme/);
  assert.match(text, /keeps working in Beta and Gamma/);
});

test("an unscoped token really is revoked everywhere, and says so", () => {
  // No per-team grant to take away: its reach is "every team the creator
  // belongs to", so the old sentence is the correct one.
  const input = { teams: [], activeTeamId: A.id, scoped: false };
  assert.equal(revokeTitle("CI", input), "Revoke CI?");
  assert.match(revokeDescription(input), /Every client using it loses access/);
});

test("revoking your own token from outside its reach promises it is gone", () => {
  // The tokens page lists every token you minted, so the active team may be one
  // the credential never touched, and there `revokeToken` deletes it outright.
  const input = { teams: [B, C], activeTeamId: A.id, scoped: true };
  assert.equal(revokeTitle("CI", input), "Revoke CI?");
  assert.match(revokeDescription(input), /Every client using it loses access/);
});

test("joinNames reads like a sentence at every length", () => {
  assert.equal(joinNames([]), "");
  assert.equal(joinNames(["Acme"]), "Acme");
  assert.equal(joinNames(["Acme", "Beta"]), "Acme and Beta");
  assert.equal(joinNames(["Acme", "Beta", "Gamma"]), "Acme, Beta and Gamma");
});
