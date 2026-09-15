import { test } from "node:test";
import assert from "node:assert/strict";

import { describeTransportError, type PanelIdentity } from "./transport";

const DOKPLOY: PanelIdentity = { name: "Dokploy", portHint: ":3000" };

const certFail = (baseUrl: string, code = "DEPTH_ZERO_SELF_SIGNED_CERT") =>
  describeTransportError(
    Object.assign(new TypeError("fetch failed"), { cause: { code } }),
    baseUrl,
    DOKPLOY,
  );

test("a hostname with an untrusted certificate is given the way out", () => {
  const onName = certFail("https://dokploy.acme.com");
  assert.match(onName, /DEPTH_ZERO_SELF_SIGNED_CERT/);
  assert.match(onName, /plain http address/);
  assert.match(onName, /http:\/\/dokploy\.acme\.com:3000/);
  assert.doesNotMatch(onName, /next step/);

  const expired = certFail("https://panel.acme.com:8443", "CERT_HAS_EXPIRED");
  assert.match(expired, /http:\/\/panel\.acme\.com:3000/);
  assert.match(
    certFail("https://coolify.acme.com", "SELF_SIGNED_CERT_IN_CHAIN"),
    /plain http address/,
  );
});

test("an https IP with a bad certificate keeps the wrong-field lecture", () => {
  const onIp = certFail("https://185.58.122.151");
  assert.match(onIp, /issued for the panel's NAME/);
  assert.match(onIp, /asked for at the next step/);
  assert.doesNotMatch(onIp, /plain http address/);

  assert.match(certFail("https://[2001:db8::1]"), /next step/);
});

test("an unparseable address still gets a sentence, not a broken URL", () => {
  const broken = certFail("not a url");
  assert.match(broken, /not one this machine trusts/);
  assert.doesNotMatch(broken, /http:\/\/:/);
});
