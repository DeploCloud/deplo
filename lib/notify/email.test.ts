import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { captureFetch, type FetchCapture } from "./fetch-capture-test-helpers";
import { sendEmail, smtpSecure } from "./email";

/**
 * The Resend branch, which is one outbound POST and therefore worth pinning: the
 * URL, the bearer header and the body shape are a contract with a third party.
 *
 * The SMTP branch is deliberately not unit-tested — it is a five-line
 * pass-through to nodemailer, and a test of it would only assert that nodemailer
 * was called.
 */

let capture: FetchCapture | null = null;
afterEach(() => {
  capture?.restore();
  capture = null;
});

test("implicit TLS is port 465 and nothing else", () => {
  assert.equal(smtpSecure(465), true);
  assert.equal(smtpSecure(587), false);
  assert.equal(smtpSecure(25), false);
});

test("Resend gets one POST with the key, the sender and the text", async () => {
  capture = captureFetch();
  await sendEmail(
    { provider: "resend", apiKey: "re_test", from: "deplo@acme.com" },
    {
      to: "ops@acme.com",
      subject: "api failed to deploy",
      text: "See the log.",
    },
  );
  assert.equal(capture.calls.length, 1);
  const call = capture.calls[0];
  assert.equal(call.url, "https://api.resend.com/emails");
  assert.equal(call.method, "POST");
  assert.equal(call.headers.Authorization, "Bearer re_test");
  assert.deepEqual(call.body, {
    from: "deplo@acme.com",
    to: ["ops@acme.com"],
    subject: "api failed to deploy",
    text: "See the log.",
  });
});

test("a refusal surfaces Resend's own words, not a generic failure", async () => {
  capture = captureFetch(
    () =>
      new Response(
        JSON.stringify({ message: "The acme.com domain is not verified" }),
        {
          status: 403,
        },
      ),
  );
  await assert.rejects(
    () =>
      sendEmail(
        { provider: "resend", apiKey: "re_test", from: "deplo@acme.com" },
        { to: "ops@acme.com", subject: "x", text: "y" },
      ),
    /domain is not verified/,
  );
});

test("a non-JSON refusal still says something useful", async () => {
  capture = captureFetch(
    () => new Response("<html>502</html>", { status: 502 }),
  );
  await assert.rejects(
    () =>
      sendEmail(
        { provider: "resend", apiKey: "re_test", from: "deplo@acme.com" },
        { to: "ops@acme.com", subject: "x", text: "y" },
      ),
    /502/,
  );
});
