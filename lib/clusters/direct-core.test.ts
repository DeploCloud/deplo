import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { directCore, relayLevel, type PathReport } from "./direct-core";

const all = (ids: string[], relayed: [string, string][] = []): PathReport[] =>
  ids.flatMap((a) =>
    ids
      .filter((b) => b !== a)
      .map((b) => ({
        serverId: a,
        peerServerId: b,
        path: relayed.some(
          ([x, y]) => (x === a && y === b) || (x === b && y === a),
        )
          ? ("relay" as const)
          : ("direct" as const),
      })),
  );

describe("direct core and relay levels", () => {
  const ids = ["eu-1", "eu-2", "eu-3"];

  it("every pair direct is level 0, with everyone in the core", () => {
    assert.deepEqual(relayLevel(ids, all(ids)), {
      level: 0,
      relayed: [],
      core: ids,
    });
  });

  it("one relayed server leaves a direct majority: level 1, the icon on that server only", () => {
    const r = relayLevel(
      ids,
      all(ids, [
        ["eu-3", "eu-1"],
        ["eu-3", "eu-2"],
      ]),
    );
    assert.equal(r.level, 1);
    assert.deepEqual(r.relayed, ["eu-3"]);
    assert.deepEqual(r.core, ["eu-1", "eu-2"]);
  });

  it("one relayed pair names the server outside the direct majority", () => {
    const r = relayLevel(ids, all(ids, [["eu-1", "eu-2"]]));
    assert.equal(r.level, 1);
    assert.deepEqual(r.relayed, ["eu-2"]);
  });

  it("every pair relayed: no direct majority, level 2", () => {
    const r = relayLevel(
      ids,
      all(ids, [
        ["eu-1", "eu-2"],
        ["eu-1", "eu-3"],
        ["eu-2", "eu-3"],
      ]),
    );
    assert.equal(r.level, 2);
    assert.deepEqual(r.relayed, ids);
  });

  it("half of an even cluster is no majority", () => {
    const four = ["a", "b", "c", "d"];
    const r = relayLevel(
      four,
      all(four, [
        ["a", "c"],
        ["a", "d"],
        ["b", "c"],
        ["b", "d"],
      ]),
    );
    assert.equal(r.level, 2);
  });

  it("a server that has not reported yet is not counted as relayed", () => {
    const r = relayLevel(ids, all(["eu-1", "eu-2"]));
    assert.equal(r.level, 0);
  });

  it("a leader is placed only on a pair someone reported direct", () => {
    assert.deepEqual(directCore(ids, all(["eu-1", "eu-2"])), ["eu-1", "eu-2"]);
    assert.deepEqual(directCore(ids, []), ["eu-1"]);
  });
});
