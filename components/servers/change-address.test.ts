import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Dialog } from "@/components/ui/dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  ChangeAddressForm,
  type ChangeAddressFormProps,
} from "@/app/(dashboard)/[team]/settings/servers/[id]/advanced-tab/change-address";

const PORT_WORDS = /9443|firewall|inbound|outbound/i;

function form(over: Partial<ChangeAddressFormProps> = {}): string {
  const props: ChangeAddressFormProps = {
    server: {
      name: "eu-1",
      agentPort: 9443,
      linked: true,
      isDeploHost: false,
    },
    address: "203.0.113.7",
    port: "9443",
    onAddressChange: () => {},
    onPortChange: () => {},
    refusal: null,
    pending: false,
    onSave: () => {},
    onCancel: () => {},
    ...over,
  };
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(
        Dialog,
        { open: true },
        createElement(ChangeAddressForm, props),
      ),
    ),
  );
}

test("a linked server's address dialog has no agent port and promises no check", () => {
  const html = form({ refusal: "Address is already in use" });
  assert.ok(html.includes('id="server-address"'));
  assert.ok(!html.includes('id="server-agent-port"'));
  assert.doesNotMatch(html, /Agent port/);
  assert.doesNotMatch(html, /checks that the agent answers/);
  assert.doesNotMatch(html, /Save anyway/);
  assert.match(html, /Address is already in use/);
  assert.doesNotMatch(html, PORT_WORDS);
});

test("a server Deplo still dials keeps its agent port and the Save anyway escape", () => {
  const html = form({
    server: {
      name: "eu-1",
      agentPort: 9555,
      linked: false,
      isDeploHost: false,
    },
    port: "9555",
    refusal: "This server is unreachable.",
  });
  assert.ok(html.includes('id="server-agent-port"'));
  assert.match(html, /checks that the agent answers/);
  assert.match(html, /Save anyway/);
  assert.doesNotMatch(html, PORT_WORDS);
});
