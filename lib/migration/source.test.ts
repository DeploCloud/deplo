import { test } from "node:test";
import assert from "node:assert/strict";

import { teamAvatarUrl } from "./source";

/**
 * The source team's picture is the one string of a panel's answer that the
 * operator's browser goes and fetches, so it is read as an address, not text.
 */

test("the two shapes a panel really writes are kept", () => {
  // Dokploy resizes an upload to a 256px WebP data URI, and stores a sanitised
  // SVG as one too; a typed address stays an address.
  assert.equal(
    teamAvatarUrl("data:image/webp;base64,AAAA"),
    "data:image/webp;base64,AAAA",
  );
  assert.equal(
    teamAvatarUrl("data:image/svg+xml,%3Csvg%3E"),
    "data:image/svg+xml,%3Csvg%3E",
  );
  assert.equal(
    teamAvatarUrl("  https://acme.com/logo.png  "),
    "https://acme.com/logo.png",
  );
});

test("anything that is not an image address is no picture", () => {
  for (const v of [
    null,
    undefined,
    "",
    "   ",
    "data:text/html,<script>alert(1)</script>",
    "javascript:alert(1)",
    "/logo.png",
    "logo.png",
    "https://",
  ])
    assert.equal(teamAvatarUrl(v), null, `kept ${String(v)}`);
});

// A panel is free to answer with a megabyte; the wizard is not free to carry it.
test("an absurd one is dropped rather than carried", () => {
  assert.equal(teamAvatarUrl(`data:image/png;base64,${"A".repeat(2e6)}`), null);
});
