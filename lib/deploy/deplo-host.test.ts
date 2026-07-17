import { test } from "node:test";
import assert from "node:assert/strict";

import { deploHostSelfAddresses, isDeploHostServer } from "./domains";

/**
 * `isDeploHostServer` is the DISPLAY-only classifier that tells the one host running
 * Deplo itself ("agent 0") apart from the pure deploy-target remotes on the Servers
 * page. It never gates anything — a wrong answer only mis-badges a card — so the bar
 * is: match the control-plane host when a self-signal names its address, and NEVER
 * mis-tag a remote as the Deplo host.
 *
 * The self-signals come from the environment, so each case sets/clears the two env
 * vars it cares about and restores them, keeping the NIC-derived addresses (which we
 * can't control in a test) out of the way by using addresses no NIC would carry.
 */

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

test("DEPLO_SERVER_IP identifies the Deplo host by its ip", () => {
  withEnv(
    { DEPLO_SERVER_IP: "203.0.113.10", DEPLO_PUBLIC_URL: undefined },
    () => {
      const self = deploHostSelfAddresses();
      assert.ok(self.has("203.0.113.10"));
      assert.equal(
        isDeploHostServer({ ip: "203.0.113.10", host: "203.0.113.10" }, self),
        true,
      );
      // A remote on a different address is never the Deplo host.
      assert.equal(
        isDeploHostServer({ ip: "198.51.100.7", host: "198.51.100.7" }, self),
        false,
      );
    },
  );
});

test("matches the server row's host when only the host (not ip) carries the address", () => {
  withEnv(
    { DEPLO_SERVER_IP: "203.0.113.10", DEPLO_PUBLIC_URL: undefined },
    () => {
      const self = deploHostSelfAddresses();
      // host holds the self-address, ip is something else — still the Deplo host.
      assert.equal(
        isDeploHostServer({ ip: "10.0.0.5", host: "203.0.113.10" }, self),
        true,
      );
    },
  );
});

test("an IPv4 DEPLO_PUBLIC_URL host also identifies the Deplo host", () => {
  withEnv(
    { DEPLO_SERVER_IP: undefined, DEPLO_PUBLIC_URL: "https://203.0.113.10:3000" },
    () => {
      const self = deploHostSelfAddresses();
      assert.ok(self.has("203.0.113.10"));
      assert.equal(isDeploHostServer({ ip: "203.0.113.10" }, self), true);
    },
  );
});

test("a hostname-valued DEPLO_PUBLIC_URL matches a host registered under that hostname", () => {
  withEnv(
    { DEPLO_SERVER_IP: undefined, DEPLO_PUBLIC_URL: "https://Deplo.Example.COM" },
    () => {
      const self = deploHostSelfAddresses();
      // Lower-cased, so a case-different row still matches.
      assert.equal(
        isDeploHostServer({ ip: "198.51.100.7", host: "deplo.example.com" }, self),
        true,
      );
    },
  );
});

test("matching is case-insensitive and tolerant of surrounding whitespace", () => {
  withEnv(
    { DEPLO_SERVER_IP: "203.0.113.10", DEPLO_PUBLIC_URL: undefined },
    () => {
      const self = deploHostSelfAddresses();
      assert.equal(isDeploHostServer({ ip: "  203.0.113.10 " }, self), true);
    },
  );
});

test("an empty self-address set never classifies any server as the Deplo host", () => {
  // No self-signal matches this remote's address, so it stays a plain remote even
  // when the set is non-empty from NIC detection.
  withEnv(
    { DEPLO_SERVER_IP: undefined, DEPLO_PUBLIC_URL: undefined },
    () => {
      const self = deploHostSelfAddresses();
      assert.equal(
        isDeploHostServer({ ip: "198.51.100.250", host: "" }, self),
        false,
      );
      // And an explicitly empty set short-circuits to false regardless of the row.
      assert.equal(
        isDeploHostServer({ ip: "198.51.100.250" }, new Set()),
        false,
      );
    },
  );
});
