import { test } from "node:test";
import assert from "node:assert/strict";

import { oneMemberPerAddress, sharedAddressWarnings } from "./shared-addresses";

test("an address two members share stays with the one that joined first, and the screen says why", () => {
  const { members, shared } = oneMemberPerAddress([
    { name: "pve-1", v4: ["203.0.113.5", "10.0.0.2"], v6: [] },
    { name: "pve-2", v4: ["203.0.113.5"], v6: ["2001:db8::2"] },
    { name: "pve-3", v4: ["203.0.113.5"], v6: [] },
  ]);
  assert.deepEqual(
    members.map((m) => [m.name, m.v4, m.v6]),
    [
      ["pve-1", ["203.0.113.5", "10.0.0.2"], []],
      ["pve-2", [], ["2001:db8::2"]],
      ["pve-3", [], []],
    ],
  );
  assert.deepEqual([...shared], [["203.0.113.5", ["pve-1", "pve-2", "pve-3"]]]);
  const [w] = sharedAddressWarnings(shared);
  assert.equal(w.title, "Two servers share one public address");
  assert.match(
    w.body,
    /^pve-1 and pve-2 and pve-3 both use the public address 203\.0\.113\.5\./,
  );
  assert.match(w.body, /names it once, for pve-1/);
});

test("members with addresses of their own are left as they are", () => {
  const input = [
    { name: "a", v4: ["203.0.113.1"], v6: [] },
    { name: "b", v4: ["203.0.113.2"], v6: [] },
  ];
  const { members, shared } = oneMemberPerAddress(input);
  assert.deepEqual(members, input);
  assert.equal(shared.size, 0);
  assert.deepEqual(sharedAddressWarnings(shared), []);
});
