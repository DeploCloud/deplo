import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import { ADDRESS_CHANGES_NOTE } from "../../lib/clusters/address-note";
import { docsUrl } from "../../lib/docs";
import { ClusterAddressNote } from "./cluster-address-note";

test("the address warning says what a failover does and links to connecting Cloudflare", () => {
  const html = renderToStaticMarkup(
    createElement(
      PathnameContext.Provider,
      { value: "/acme/apps/web" },
      createElement(ClusterAddressNote, { note: ADDRESS_CHANGES_NOTE }),
    ),
  );
  assert.match(
    html,
    /This App&#x27;s address changes when it fails over to another server\. A domain on Cloudflare keeps one address\./,
  );
  assert.match(html, /href="\/acme\/settings\/dns"[^>]*>Connect Cloudflare</);
  assert.ok(html.includes(`href="${docsUrl("clusters.addresses")}"`));
});
