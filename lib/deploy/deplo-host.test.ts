import { test } from "node:test";
import assert from "node:assert/strict";

import { deploHostSelfAddresses, isDeploHostServer } from "./domains";

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
      assert.equal(
        isDeploHostServer({ ip: "10.0.0.5", host: "203.0.113.10" }, self),
        true,
      );
    },
  );
});

test("an IPv4 DEPLO_PUBLIC_URL host also identifies the Deplo host", () => {
  withEnv(
    {
      DEPLO_SERVER_IP: undefined,
      DEPLO_PUBLIC_URL: "https://203.0.113.10:3000",
    },
    () => {
      const self = deploHostSelfAddresses();
      assert.ok(self.has("203.0.113.10"));
      assert.equal(isDeploHostServer({ ip: "203.0.113.10" }, self), true);
    },
  );
});

test("a hostname-valued DEPLO_PUBLIC_URL matches a host registered under that hostname", () => {
  withEnv(
    {
      DEPLO_SERVER_IP: undefined,
      DEPLO_PUBLIC_URL: "https://Deplo.Example.COM",
    },
    () => {
      const self = deploHostSelfAddresses();
      assert.equal(
        isDeploHostServer(
          { ip: "198.51.100.7", host: "deplo.example.com" },
          self,
        ),
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
  withEnv({ DEPLO_SERVER_IP: undefined, DEPLO_PUBLIC_URL: undefined }, () => {
    const self = deploHostSelfAddresses();
    assert.equal(
      isDeploHostServer({ ip: "198.51.100.250", host: "" }, self),
      false,
    );
    assert.equal(isDeploHostServer({ ip: "198.51.100.250" }, new Set()), false);
  });
});
