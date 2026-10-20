import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "../ui/tooltip";
import {
  DomainConfigFields,
  initialDomainConfig,
  lockCloudflare,
} from "./domain-config-fields";

const behindCloudflare = {
  certProvider: "letsencrypt",
  status: "cloudflare",
} as const;
const direct = { certProvider: "letsencrypt", status: "valid" } as const;

test("a domain behind Cloudflare opens on the Cloudflare certificate", () => {
  assert.equal(
    initialDomainConfig(behindCloudflare).certProvider,
    "cloudflare",
  );
  assert.equal(initialDomainConfig(direct).certProvider, "letsencrypt");
});

test("lockCloudflare overrides the form only while Cloudflare is detected", () => {
  const state = initialDomainConfig(direct);
  assert.equal(lockCloudflare(state, true).certProvider, "cloudflare");
  assert.equal(lockCloudflare(state, false), state);
});

function certTrigger(detected: boolean) {
  const state = lockCloudflare(initialDomainConfig(direct), detected);
  const html = renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(DomainConfigFields, {
        state,
        onChange() {},
        idPrefix: "t",
        proxied: detected,
      }),
    ),
  );
  return html.match(/<button[^>]*id="t-cert"[^>]*>/)?.[0] ?? "";
}

test("the certificate select is locked while Cloudflare is detected", () => {
  assert.match(certTrigger(true), /\sdisabled=""/);
  assert.doesNotMatch(certTrigger(false), /\sdisabled=""/);
});
