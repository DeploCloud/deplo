import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SOCKET_FILTER_CFG,
  SSHD_CONFIG,
  WRAPPER_SCRIPT,
  renderGatewayCompose,
  GATEWAY_PORT,
} from "./gateway-config";

// ---- Socket-filter allowlist (ADR-0003: which-verb axis) ----

test("socket filter default-denies (the catch-all 403 is present)", () => {
  assert.match(SOCKET_FILTER_CFG, /http-request deny deny_status 403/);
});

test("socket filter allows ONLY exec + inspect + handshake — never create/start/cp/run", () => {
  // Allowed verbs.
  assert.match(SOCKET_FILTER_CFG, /\/containers\/\[a-zA-Z0-9_\.-\]\+\/exec\$/); // create exec
  assert.match(SOCKET_FILTER_CFG, /\/containers\/\[a-zA-Z0-9_\.-\]\+\/json\$/); // inspect
  assert.match(SOCKET_FILTER_CFG, /\/exec\/\[a-zA-Z0-9_\.-\]\+\/start\$/); // run exec
  // The dangerous endpoints must NOT be in any allow rule.
  const allowLines = SOCKET_FILTER_CFG.split("\n").filter((l) => l.includes("http-request allow"));
  const allow = allowLines.join("\n");
  assert.ok(!/\/containers\/create/.test(allow), "must not allow container create");
  assert.ok(!/\/archive/.test(allow), "must not allow docker cp (archive)");
  assert.ok(!/\/containers\/\[a-zA-Z0-9_\.-\]\+\/start/.test(allow), "must not allow container start");
  assert.ok(!/\/images\//.test(allow), "must not allow image pull/run");
});

// ---- sshd hardening ----

test("sshd denies every forwarding/escape vector and forces the wrapper", () => {
  assert.match(SSHD_CONFIG, /ForceCommand \/usr\/local\/bin\/deplo-dev-shell/);
  assert.match(SSHD_CONFIG, /AllowTcpForwarding no/);
  assert.match(SSHD_CONFIG, /PermitOpen none/);
  assert.match(SSHD_CONFIG, /PermitTunnel no/);
  assert.match(SSHD_CONFIG, /PermitRootLogin no/);
  assert.match(SSHD_CONFIG, new RegExp(`Port ${GATEWAY_PORT}`));
});

// ---- ForceCommand wrapper: the exec-target guard + UID pin ----

test("wrapper guards the exec target and pins UID 1000", () => {
  // The dev-container case + control-plane refusals.
  assert.match(WRAPPER_SCRIPT, /deplo-dev-\*\) :/);
  assert.match(WRAPPER_SCRIPT, /refusing to exec into a non-dev container/);
  assert.match(WRAPPER_SCRIPT, /refusing to exec into a control-plane container/);
  // Always exec as UID 1000, never a name.
  assert.match(WRAPPER_SCRIPT, /docker exec -i -u 1000 -w \/workspace/);
  // The cross-reference comment to the TS twin.
  assert.match(WRAPPER_SCRIPT, /isValidExecTarget/);
});

// ---- compose: only the proxy mounts the raw socket ----

test("gateway compose: only the proxy mounts the raw docker socket", () => {
  const compose = renderGatewayCompose("/data/ssh-gateway");
  const socketMounts = compose
    .split("\n")
    .filter((l) => l.includes("/var/run/docker.sock"));
  assert.equal(socketMounts.length, 1, "exactly one service mounts the socket");
  // The gateway talks docker only via the proxy.
  assert.match(compose, /DOCKER_HOST: "tcp:\/\/proxy:2375"/);
  // The single SSH port is published.
  assert.match(compose, new RegExp(`"${GATEWAY_PORT}:${GATEWAY_PORT}"`));
});
