import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "../ui/tooltip";
import {
  DomainConfigFields,
  initialDomainConfig,
} from "./domain-config-fields";

const behindCloudflare = {
  certProvider: "letsencrypt",
  status: "cloudflare",
} as const;

test("a domain behind Cloudflare opens on the certificate it has", () => {
  assert.equal(
    initialDomainConfig(behindCloudflare).certProvider,
    "letsencrypt",
  );
  assert.equal(
    initialDomainConfig({ ...behindCloudflare, certProvider: undefined })
      .certProvider,
    "letsencrypt",
  );
});

function certTrigger(detected: boolean) {
  const html = renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(DomainConfigFields, {
        state: initialDomainConfig(behindCloudflare),
        onChange() {},
        idPrefix: "t",
        proxied: detected,
      }),
    ),
  );
  return html.match(/<button[^>]*id="t-cert"[^>]*>/)?.[0] ?? "";
}

test("the certificate stays editable while Cloudflare is detected", () => {
  assert.doesNotMatch(certTrigger(true), /\sdisabled=""/);
  assert.doesNotMatch(certTrigger(false), /\sdisabled=""/);
});
