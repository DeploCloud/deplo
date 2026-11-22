import { test } from "node:test";
import assert from "node:assert/strict";

import {
  answerRecordSet,
  checkAnswerRecords,
  type AnswerServer,
} from "./answer-dns";

const srv = (
  id: string,
  v4: string,
  v6 = "",
  over: Partial<AnswerServer> = {},
): AnswerServer => ({
  id,
  online: true,
  emptying: false,
  v4: v4 ? [v4, "10.9.9.9"] : [],
  v6: v6 ? [v6] : [],
  ...over,
});

test("the set names every healthy server once, its first address of each family", () => {
  const { a, aaaa, members } = answerRecordSet([
    srv("a", "203.0.113.2", "2001:db8::2"),
    srv("b", "203.0.113.1"),
    srv("c", "203.0.113.3", "", { online: false }),
    srv("d", "203.0.113.4", "", { emptying: true }),
  ]);
  assert.deepEqual(
    { a, aaaa },
    { a: ["203.0.113.1", "203.0.113.2"], aaaa: ["2001:db8::2"] },
  );
  // Every server's addresses, stopped and emptied ones included, are the cluster's.
  assert.ok(
    members?.includes("203.0.113.3") && members.includes("203.0.113.4"),
  );
});

test("DNS is valid only when it answers exactly the set", () => {
  const set = { a: ["203.0.113.1", "203.0.113.2"], aaaa: [] };
  assert.equal(
    checkAnswerRecords({ a: ["203.0.113.2", "203.0.113.1"], aaaa: [] }, set)
      .status,
    "valid",
  );
  assert.deepEqual(checkAnswerRecords({ a: ["203.0.113.1"], aaaa: [] }, set), {
    status: "misconfigured",
    missing: ["203.0.113.2"],
    extra: [],
  });
  // A stopped server still listed: visitors would try it first.
  assert.deepEqual(
    checkAnswerRecords(
      { a: ["203.0.113.1", "203.0.113.2", "203.0.113.3"], aaaa: [] },
      set,
    ),
    {
      status: "misconfigured",
      missing: [],
      extra: ["203.0.113.3"],
    },
  );
  assert.equal(checkAnswerRecords({ a: [], aaaa: [] }, set).status, "pending");
});

// Found on the lab: a stopped server's record flipped the domain to misconfigured, and the failover's reroute unrouted it.
test("a stopped server still listed keeps the domain routed, and is still said", () => {
  const set = answerRecordSet([
    srv("a", "203.0.113.1"),
    srv("b", "203.0.113.2"),
    srv("c", "203.0.113.3", "", { online: false }),
  ]);
  const stale = checkAnswerRecords(
    { a: ["203.0.113.1", "203.0.113.2", "203.0.113.3"], aaaa: [] },
    set,
  );
  assert.deepEqual(stale, {
    status: "valid",
    missing: [],
    extra: ["203.0.113.3"],
  });
  // Another host's address, or only stopped servers, does not reach the App.
  assert.equal(
    checkAnswerRecords({ a: ["203.0.113.1", "198.51.100.7"], aaaa: [] }, set)
      .status,
    "misconfigured",
  );
  assert.equal(
    checkAnswerRecords({ a: ["203.0.113.3"], aaaa: [] }, set).status,
    "misconfigured",
  );
  // A stopped server's agent cannot list its IPv6: its AAAA is unknown, not another host's.
  const blind = answerRecordSet([
    srv("a", "203.0.113.1", "2001:db8::1"),
    srv("c", "203.0.113.3", "", { online: false, known: false }),
  ]);
  assert.equal(
    checkAnswerRecords(
      {
        a: ["203.0.113.1", "203.0.113.3"],
        aaaa: ["2001:db8::1", "2001:db8::3"],
      },
      blind,
    ).status,
    "valid",
  );
  // A healthy server left out is a change to make, not a broken domain.
  assert.equal(
    checkAnswerRecords({ a: ["203.0.113.1"], aaaa: [] }, set).status,
    "valid",
  );
});
