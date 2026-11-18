import { test } from "node:test";
import assert from "node:assert/strict";

import {
  answerRecordChange,
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
  assert.deepEqual(
    answerRecordSet([
      srv("a", "203.0.113.2", "2001:db8::2"),
      srv("b", "203.0.113.1"),
      srv("c", "203.0.113.3", "", { online: false }),
      srv("d", "203.0.113.4", "", { emptying: true }),
    ]),
    { a: ["203.0.113.1", "203.0.113.2"], aaaa: ["2001:db8::2"] },
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

test("a provider gets only what differs, and a record Deplo did not write is never touched", () => {
  const set = { a: ["203.0.113.1", "203.0.113.2"], aaaa: ["2001:db8::2"] };
  const change = answerRecordChange(
    [
      { id: "r1", type: "A", content: "203.0.113.1", ours: true },
      { id: "r3", type: "A", content: "203.0.113.3", ours: true },
      { id: "t1", type: "TXT", content: "v=spf1", ours: false },
    ],
    set,
  );
  assert.deepEqual(change, {
    foreign: null,
    create: [
      { type: "A", content: "203.0.113.2" },
      { type: "AAAA", content: "2001:db8::2" },
    ],
    remove: ["r3"],
  });
  const theirs = answerRecordChange(
    [{ id: "x", type: "CNAME", content: "elsewhere.example.com", ours: false }],
    set,
  );
  assert.deepEqual(theirs.foreign, {
    type: "CNAME",
    content: "elsewhere.example.com",
  });
  assert.deepEqual(theirs.remove, []);
});
