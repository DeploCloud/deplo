// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from "node:test";
import assert from "node:assert/strict";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QRCodeSVG } from "qrcode.react";

import { deploMarkDataUri } from "../components/logo";

/**
 * The enrolment QR carries the Deplo mark in the middle, which means modules are
 * CARVED OUT of a code a phone camera still has to read off a screen.
 */

// The real thing: what `enableTwoFactor` hands back, at full length. A shorter
// stand-in would encode to a smaller version with fewer modules and quietly
// flatter the numbers below.
const TOTP_URI =
  "otpauth://totp/deplo:someone%40acme.com?secret=ONWWMRJXGVBE2SDPIN2TEZKDKVVEW2TMJU4WSMTHN5GW4LKSJRDQ&issuer=deplo&digits=6&period=30";

/** The wizard's settings, kept in one place so the test and the UI cannot drift. */
const SIZE = 180;
const LOGO_PX = 44;

function render(level: "L" | "M" | "Q" | "H") {
  return renderToStaticMarkup(
    createElement(QRCodeSVG, {
      value: TOTP_URI,
      size: SIZE,
      level,
      bgColor: "#ffffff",
      fgColor: "#0a0a0a",
      marginSize: 0,
      imageSettings: {
        src: deploMarkDataUri(),
        height: LOGO_PX,
        width: LOGO_PX,
        excavate: true,
      },
    }),
  );
}

test("the mark is embedded in the QR, not painted beside it", () => {
  const svg = render("H");
  assert.match(svg, /<image/, "an embedded image is rendered");
  assert.match(
    svg,
    /data:image\/svg\+xml/,
    "the mark travels as a self-contained data URI, with no network fetch",
  );
});

test("the excavated centre stays well inside level H's error budget", () => {
  const svg = render("H");
  // qrcode.react renders in MODULE units: the viewBox side is the module count.
  const modules = Number(/viewBox="0 0 (\d+) \d+"/.exec(svg)![1]);
  assert.ok(modules > 20, `expected a real QR version, got ${modules} modules`);

  // The badge is square and centred, so its side in modules is what it covers.
  const logoModules = Math.ceil((LOGO_PX / SIZE) * modules);
  const covered = (logoModules * logoModules) / (modules * modules);

  // Level H recovers 30%. Half of that is the working ceiling: the finder and
  // timing patterns are not recoverable data, and a camera on a screen loses
  // modules of its own to glare and moiré.
  assert.ok(
    covered < 0.15,
    `the mark covers ${(covered * 100).toFixed(1)}% of the code; keep it under 15%`,
  );
});

test("a lower error-correction level would not survive the same hole", () => {
  // The guard rail for the next person who thinks `level` is cosmetic. Level L
  // recovers 7%; the badge alone is already a meaningful slice of that, before any
  // real-world loss.
  const svg = render("L");
  const modules = Number(/viewBox="0 0 (\d+) \d+"/.exec(svg)![1]);
  const logoModules = Math.ceil((LOGO_PX / SIZE) * modules);
  const covered = (logoModules * logoModules) / (modules * modules);
  assert.ok(
    covered > 0.07,
    "level L must remain visibly inadequate for this logo size",
  );
});

test("the mark data URI is a well-formed, self-contained SVG", () => {
  const uri = deploMarkDataUri();
  const svg = decodeURIComponent(uri.replace("data:image/svg+xml,", ""));
  assert.match(svg, /^<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /<\/svg>$/);
  // Fixed colours, never `currentColor`: an <image> has no inherited text colour
  // to resolve against, so a theme-aware fill would render as nothing.
  assert.doesNotMatch(svg, /currentColor/);
  assert.match(svg, /fill="#0a0a0a"/, "the glyph is drawn dark");
  assert.match(svg, /fill="#ffffff"/, "on its own light badge");
});
