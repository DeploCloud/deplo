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
    server: { name: "eu-1", isDeploHost: false },
    address: "203.0.113.7",
    onAddressChange: () => {},
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

// Every server links in (ADR-0040): Deplo never contacts it to save an address.
test("the address dialog has no agent port and promises no check", () => {
  const html = form({ refusal: "Address is already in use" });
  assert.ok(html.includes('id="server-address"'));
  assert.ok(!html.includes('id="server-agent-port"'));
  assert.doesNotMatch(html, /Agent port/);
  assert.doesNotMatch(html, /checks that the server agent answers/);
  assert.doesNotMatch(html, /Save anyway/);
  assert.match(html, /Address is already in use/);
  assert.doesNotMatch(html, PORT_WORDS);
});

test("on the server that runs Deplo, a wrong address is said to break its apps' addresses", () => {
  const html = form({ server: { name: "eu-1", isDeploHost: true } });
  assert.match(html, /breaks the addresses of its apps/);
  assert.doesNotMatch(html, /cuts this dashboard off/);
});
