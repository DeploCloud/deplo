import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TooltipProvider } from "@/components/ui/tooltip";
import { HEALTH_MESSAGES } from "@/lib/infra/server-health";
import type { PlanServer } from "../types";
import { MachineRow } from "./machine-row";
import type { MachineInstall } from "./use-machine-install";

const machine: PlanServer = {
  sourceId: "src_1",
  name: "eu-1",
  ipAddress: "203.0.113.7",
  cloudflare: false,
  deploServerId: null,
  deploServerName: null,
  deploServerOnline: false,
};

function offline(message: string, m: Partial<PlanServer> = {}): string {
  const noop = async () => {};
  const install: MachineInstall = {
    settled: false,
    pending: {
      src_1: {
        serverId: "srv_1",
        name: "eu-1",
        installCommand: "curl -fsSL https://deplo.example/install-agent.sh",
        address: "203.0.113.7",
      },
    },
    failed: {},
    adoptable: {},
    unreachable: { src_1: { status: "offline", message } },
    busy: {},
    draft: {},
    setDraft: () => {},
    editing: {},
    setEditing: () => {},
    saveAddress: noop,
    checkAgain: noop,
    adopt: noop,
    registerManually: noop,
  };
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(MachineRow, {
        m: { ...machine, ...m },
        canAddServers: true,
        install,
      }),
    ),
  );
}

test("a machine that cannot connect is told to check it is on and online, and nothing else", () => {
  for (const html of [
    offline(HEALTH_MESSAGES.offline),
    // What an older check stored, until the next one replaces it.
    offline(
      "The agent did not answer (connection refused). Is it running on the host?",
    ),
    offline("The agent did not answer within the health-check deadline.", {
      cloudflare: true,
    }),
  ]) {
    assert.ok(html.includes(HEALTH_MESSAGES.offline), html);
    assert.doesNotMatch(html, /did not answer|9443|firewall|inbound|outbound/i);
  }
});

test("the check-the-machine sentence is said once", () => {
  const html = offline(HEALTH_MESSAGES.offline);
  assert.equal(html.split(HEALTH_MESSAGES.offline).length - 1, 1, html);
});
