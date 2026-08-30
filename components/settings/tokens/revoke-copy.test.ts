// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from "node:test";
import assert from "node:assert/strict";

import { joinNames, revokeDescription } from "./revoke-copy";

/**
 * What Revoke promises, against what `revokeToken` does.
 */

const A = { id: "team_a", name: "Acme" };
const B = { id: "team_b", name: "Beta" };
const C = { id: "team_c", name: "Gamma" };

test("a credential that only reaches this team gets the plain sentence", () => {
  const text = revokeDescription({
    teams: [A],
    activeTeamId: A.id,
    scoped: true,
  });
  assert.match(
    text,
    /Every client using it loses access immediately, including/,
  );
  assert.doesNotMatch(text, /too/);
});

test("a multi-team token names the other teams it takes down", () => {
  const text = revokeDescription({
    teams: [A, B, C],
    activeTeamId: A.id,
    scoped: true,
  });
  assert.match(text, /loses access immediately, in Beta and Gamma too/);
  assert.doesNotMatch(text, /keeps working/);
});

test("revoking your own token from outside its reach names its teams too", () => {
  // The tokens page lists every token you minted, so the active team may be one
  // the credential never touched - and revoking it there still kills the teams
  // it does reach.
  const text = revokeDescription({
    teams: [B, C],
    activeTeamId: A.id,
    scoped: true,
  });
  assert.match(text, /in Beta and Gamma too/);
});

test("an unscoped token has no stored teams to name", () => {
  // Its reach is "every team the creator belongs to", resolved live.
  const text = revokeDescription({
    teams: [],
    activeTeamId: A.id,
    scoped: false,
  });
  assert.match(
    text,
    /Every client using it loses access immediately, including/,
  );
});

test("joinNames reads like a sentence at every length", () => {
  assert.equal(joinNames([]), "");
  assert.equal(joinNames(["Acme"]), "Acme");
  assert.equal(joinNames(["Acme", "Beta"]), "Acme and Beta");
  assert.equal(joinNames(["Acme", "Beta", "Gamma"]), "Acme, Beta and Gamma");
});
