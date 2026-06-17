import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import {
  isValidExecTarget,
  shellQuote,
  mapFileBody,
  provisionSteps,
  deprovisionSteps,
} from "./gateway-projection";

// ---- isValidExecTarget: the control-plane guard (was only in shell) ----

test("isValidExecTarget: accepts a real dev container", () => {
  assert.equal(isValidExecTarget("deplo-dev-myapp"), true);
  assert.equal(isValidExecTarget("deplo-dev-some-slug-123"), true);
});

test("isValidExecTarget: rejects non-dev containers", () => {
  assert.equal(isValidExecTarget("nginx"), false);
  assert.equal(isValidExecTarget("postgres"), false);
  assert.equal(isValidExecTarget(""), false);
});

test("isValidExecTarget: rejects the control-plane and gateway containers", () => {
  // Re-escalation paths: execing into the control plane or the gateway itself.
  assert.equal(isValidExecTarget("deplo"), false);
  assert.equal(isValidExecTarget("deplo-ssh-gateway"), false);
});

test("isValidExecTarget: a deplo-dev- prefix on a control-plane-looking name still passes the prefix but the exact-match guard is separate", () => {
  // `deplo-dev-ssh-gateway` is a (weird) dev container name; it is NOT the exact
  // gateway container `deplo-ssh-gateway`, so it passes — the guard rejects only
  // the exact control-plane names, by design.
  assert.equal(isValidExecTarget("deplo-dev-ssh-gateway"), true);
});

// ---- shellQuote: the lone injection defense ----

test("shellQuote: wraps in single quotes", () => {
  assert.equal(shellQuote("plain"), "'plain'");
});

test("shellQuote: escapes embedded single quotes (the classic break-out)", () => {
  // a'b → 'a'\''b' — closes the quote, escapes a literal ', reopens.
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
  // A naive attempt to inject a command is fully neutralised.
  assert.equal(shellQuote("'; rm -rf / #"), "''\\''; rm -rf / #'");
});

// ---- mapFileBody: SLUG + DEV_CONTAINER only, quoted ----

test("mapFileBody: only SLUG and DEV_CONTAINER, both quoted", () => {
  assert.equal(
    mapFileBody({ slug: "myapp", container: "deplo-dev-myapp" }),
    "SLUG='myapp'\nDEV_CONTAINER='deplo-dev-myapp'\n",
  );
  // No exec user, no secret in the map body.
  assert.ok(!mapFileBody({ slug: "x", container: "deplo-dev-x" }).includes("UID"));
});

// ---- provisionSteps: the credential decision + ordering ----

test("provisionSteps: a key-only user disables password without locking, writes the key", () => {
  const steps = provisionSteps(
    { username: "myapp-bob", password: null, publicKey: "ssh-ed25519 AAAA bob" },
    { slug: "myapp", container: "deplo-dev-myapp" },
  );
  // 1 account, 2 credential (usermod -p '*'), 3a mkdir keydir, 3b write key, 4 map.
  assert.equal(steps.length, 5);
  assert.deepEqual(steps[1].argv, ["usermod", "-p", "*", "myapp-bob"]);
  // The key is written with the restrict,pty prefix over stdin.
  const keyWrite = steps.find((s) => s.input?.startsWith("restrict,pty"));
  assert.ok(keyWrite, "a step pipes the restrict,pty key line");
  assert.equal(keyWrite!.input, "restrict,pty ssh-ed25519 AAAA bob\n");
});

test("provisionSteps: a password user gets chpasswd over stdin, key dir removed", () => {
  const steps = provisionSteps(
    { username: "myapp-alice", password: "s3cr3t", publicKey: null },
    { slug: "myapp", container: "deplo-dev-myapp" },
  );
  const chpasswd = steps.find((s) => s.argv.join(" ") === "sh -c chpasswd");
  assert.ok(chpasswd, "a chpasswd step exists");
  // Secret only on stdin, never in argv.
  assert.equal(chpasswd!.input, "myapp-alice:s3cr3t\n");
  assert.ok(!steps.some((s) => s.argv.some((a) => a.includes("s3cr3t"))), "secret never in argv");
  // No public key → the key dir is removed.
  assert.ok(steps.some((s) => s.argv.join(" ").includes("rm -rf '/data/ssh-gateway/keys/myapp-alice'")));
});

test("provisionSteps: account creation is idempotent (id || adduser)", () => {
  const steps = provisionSteps(
    { username: "x-carol", password: "pw", publicKey: null },
    { slug: "x", container: "deplo-dev-x" },
  );
  assert.match(steps[0].argv[2], /^id 'x-carol' >\/dev\/null 2>&1 \|\| adduser -D -G devusers/);
});

test("shellQuote: a hostile value, fed through a REAL shell, expands to itself", () => {
  // The gold-standard injection test: run `printf %s <quoted>` in an actual
  // /bin/sh and confirm the shell sees exactly the original bytes — no command
  // substitution, no break-out, no expansion.
  const evil = [
    "a'; rm -rf / #",
    "$(touch /tmp/deplo-pwned)",
    "`id`",
    "x\"; echo hi; \"",
    "normal-name",
  ];
  for (const v of evil) {
    const out = execFileSync("/bin/sh", ["-c", `printf %s ${shellQuote(v)}`], {
      encoding: "utf8",
    });
    assert.equal(out, v, `shell must see the literal value, not expand it: ${v}`);
  }
});

test("provisionSteps: the hostile username only ever reaches a `sh -c` arg quoted", () => {
  const hostile = "a'; rm -rf / #";
  const steps = provisionSteps(
    { username: hostile, password: null, publicKey: null },
    { slug: "s", container: "deplo-dev-s" },
  );
  for (const s of steps) {
    const isShellC = s.argv[0] === "sh" && s.argv[1] === "-c";
    if (!isShellC) continue;
    // The raw (unquoted) hostile string never appears in the shell command.
    assert.ok(
      !s.argv[2].includes(hostile),
      `hostile string must be quoted inside sh -c: ${s.argv[2]}`,
    );
  }
});

// ---- deprovisionSteps: evict, delete account, remove files ----

test("deprovisionSteps: pkill → deluser → rm, all quoted", () => {
  const steps = deprovisionSteps("myapp-alice");
  assert.equal(steps.length, 3);
  assert.match(steps[0].argv[2], /^pkill -u 'myapp-alice'/);
  assert.match(steps[1].argv[2], /^deluser 'myapp-alice'/);
  assert.match(steps[2].argv[2], /rm -rf \/data\/ssh-gateway\/keys\/'myapp-alice'/);
});
