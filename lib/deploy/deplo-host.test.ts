import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deploHostSelfAddresses,
  isDeploHostServer,
  isThisMachineAddress,
} from "./domains";

function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void,
): void {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

test("the host running Deplo is the server the installer enrolled, whatever its address", () => {
  withEnv(
    { DEPLO_SERVER_IP: "203.0.113.10", DEPLO_PUBLIC_URL: undefined },
    () => {
      // Behind NAT the machine's own address is not the one the row was added at.
      assert.equal(isDeploHostServer({ deploHost: true }), true);
      assert.equal(isDeploHostServer({ deploHost: false }), false);
      assert.equal(isDeploHostServer({}), false);
      assert.equal(isDeploHostServer(null), false);
    },
  );
});

test("DEPLO_SERVER_IP is one of this machine's addresses", () => {
  withEnv(
    { DEPLO_SERVER_IP: "203.0.113.10", DEPLO_PUBLIC_URL: undefined },
    () => {
      const self = deploHostSelfAddresses();
      assert.ok(self.has("203.0.113.10"));
      assert.equal(isThisMachineAddress("203.0.113.10", self), true);
      assert.equal(isThisMachineAddress("198.51.100.7", self), false);
    },
  );
});

test("an IPv6 address of this machine is recognised in any spelling, bracketed or not", () => {
  withEnv(
    {
      DEPLO_SERVER_IP: "2001:DB8:0::10",
      DEPLO_PUBLIC_URL: "http://[2001:db8::10]:3000",
    },
    () => {
      const self = deploHostSelfAddresses();
      for (const ip of ["2001:db8::10", "[2001:0db8::10]"])
        assert.equal(isThisMachineAddress(ip, self), true, ip);
      assert.equal(isThisMachineAddress("2001:db8::11", self), false);
    },
  );
});

test("an IPv4 DEPLO_PUBLIC_URL host is one of this machine's addresses", () => {
  withEnv(
    {
      DEPLO_SERVER_IP: undefined,
      DEPLO_PUBLIC_URL: "https://203.0.113.10:3000",
    },
    () => {
      const self = deploHostSelfAddresses();
      assert.ok(self.has("203.0.113.10"));
      assert.equal(isThisMachineAddress("203.0.113.10", self), true);
    },
  );
});

test("a hostname-valued DEPLO_PUBLIC_URL names this machine", () => {
  withEnv(
    {
      DEPLO_SERVER_IP: undefined,
      DEPLO_PUBLIC_URL: "https://Deplo.Example.COM",
    },
    () => {
      assert.equal(
        isThisMachineAddress("deplo.example.com", deploHostSelfAddresses()),
        true,
      );
    },
  );
});

test("matching is case-insensitive and tolerant of surrounding whitespace", () => {
  withEnv(
    { DEPLO_SERVER_IP: "203.0.113.10", DEPLO_PUBLIC_URL: undefined },
    () => {
      assert.equal(
        isThisMachineAddress("  203.0.113.10 ", deploHostSelfAddresses()),
        true,
      );
    },
  );
});

test("an empty self-address set names no address as this machine", () => {
  assert.equal(isThisMachineAddress("198.51.100.250", new Set()), false);
  assert.equal(isThisMachineAddress("", new Set(["198.51.100.250"])), false);
});
