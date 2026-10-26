import { test } from "node:test";
import assert from "node:assert/strict";

import { captureFetch } from "../notify/fetch-capture-test-helpers";
import {
  OsvUnavailableError,
  affectedFor,
  osvAffectedRows,
  osvQueryBatch,
  osvVuln,
  recordSeverity,
  type OsvRecord,
} from "./osv";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

test("osvQueryBatch: keeps the queries' order and follows page tokens", async () => {
  let call = 0;
  const cap = captureFetch(() => {
    call++;
    if (call === 1)
      return json({
        results: [
          { vulns: [{ id: "A", modified: "1" }], next_page_token: "p2" },
          {},
        ],
      });
    return json({ results: [{ vulns: [{ id: "B", modified: "2" }] }] });
  });
  try {
    const out = await osvQueryBatch([
      { ecosystem: "npm", name: "a", version: "1" },
      { ecosystem: "npm", name: "b", version: "1" },
    ]);
    assert.deepEqual(
      out.map((r) => r.map((v) => v.id)),
      [["A", "B"], []],
    );
    assert.equal(cap.calls.length, 2);
    const second = cap.calls[1].body as { queries: { page_token?: string }[] };
    assert.equal(second.queries.length, 1);
    assert.equal(second.queries[0].page_token, "p2");
  } finally {
    cap.restore();
  }
});

test("osvQueryBatch: sends at most 1000 queries per call", async () => {
  const cap = captureFetch(() => json({ results: [] }));
  try {
    const qs = Array.from({ length: 1500 }, (_, i) => ({
      ecosystem: "npm",
      name: `p${i}`,
      version: "1",
    }));
    await osvQueryBatch(qs);
    assert.deepEqual(
      cap.calls.map((c) => (c.body as { queries: unknown[] }).queries.length),
      [1000, 500],
    );
  } finally {
    cap.restore();
  }
});

test("OSV down: a failed call throws OsvUnavailableError, a 404 vuln is null", async () => {
  let cap = captureFetch(() => json({}, 503));
  try {
    await assert.rejects(
      osvQueryBatch([{ ecosystem: "npm", name: "a", version: "1" }]),
      OsvUnavailableError,
    );
  } finally {
    cap.restore();
  }
  cap = captureFetch(() => json({}, 404));
  try {
    assert.equal(await osvVuln("GHSA-x"), null);
  } finally {
    cap.restore();
  }
});

const debianRecord: OsvRecord = {
  id: "DEBIAN-CVE-2024-5535",
  modified: "2026-01-01T00:00:00Z",
  upstream: ["CVE-2024-5535"],
  severity: [
    { type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:H" },
  ],
  affected: [
    {
      package: { ecosystem: "Debian:12", name: "openssl" },
      ranges: [
        {
          type: "ECOSYSTEM",
          events: [{ introduced: "0" }, { fixed: "3.0.15-1~deb12u1" }],
        },
      ],
    },
    {
      package: { ecosystem: "Debian:13", name: "openssl" },
      ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }] }],
    },
  ],
};

test("osvAffectedRows: one row per affected package, with fix, CVE and score", () => {
  const rows = osvAffectedRows(debianRecord);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    {
      ...rows[0],
      modified: undefined,
      summary: undefined,
    },
    {
      vulnId: "DEBIAN-CVE-2024-5535",
      ecosystem: "Debian:12",
      name: "openssl",
      ranges: [
        { introduced: "0", fixed: "3.0.15-1~deb12u1", lastAffected: null },
      ],
      cve: "CVE-2024-5535",
      severity: "critical",
      cvssTenths: 91,
      modified: undefined,
      summary: undefined,
    },
  );
  assert.deepEqual(rows[1].ranges, [
    { introduced: "0", fixed: null, lastAffected: null },
  ]);
  assert.deepEqual(osvAffectedRows({ ...debianRecord, withdrawn: "x" }), []);
});

test("osvAffectedRows: a package named once per release line keeps every line", () => {
  const [row] = osvAffectedRows({
    id: "GHSA-next",
    affected: [
      {
        package: { ecosystem: "npm", name: "next" },
        ranges: [
          {
            type: "SEMVER",
            events: [{ introduced: "0" }, { fixed: "15.5.28" }],
          },
        ],
      },
      {
        package: { ecosystem: "npm", name: "next" },
        ranges: [
          {
            type: "SEMVER",
            events: [{ introduced: "16.0.0" }, { fixed: "16.3.6" }],
          },
        ],
      },
    ],
  });
  assert.deepEqual(
    row.ranges.map((r) => r.fixed),
    ["15.5.28", "16.3.6"],
  );
});

test("recordSeverity: GHSA text, Ubuntu priority, then the CVE fallback", () => {
  assert.deepEqual(
    recordSeverity({
      id: "GHSA-1",
      database_specific: { severity: "MODERATE" },
    }),
    { severity: "medium", cvssTenths: null },
  );
  assert.deepEqual(
    recordSeverity({
      id: "USN-1",
      severity: [{ type: "Ubuntu", score: "high" }],
    }),
    { severity: "high", cvssTenths: null },
  );
  const rows = osvAffectedRows(
    {
      id: "ALPINE-CVE-1",
      affected: [{ package: { ecosystem: "Alpine:v3.21", name: "curl" } }],
    },
    { severity: "critical", cvssTenths: 98 },
  );
  assert.equal(rows[0].severity, "critical");
  assert.equal(rows[0].cvssTenths, 98);
});

test("affectedFor: an ecosystem OSV qualifies further still matches", () => {
  const rows = [{ ecosystem: "Ubuntu:24.04:LTS", name: "openssl" }];
  assert.equal(affectedFor(rows, "Ubuntu:24.04", "openssl"), rows[0]);
  assert.equal(affectedFor(rows, "Ubuntu:22.04", "openssl"), undefined);
});
