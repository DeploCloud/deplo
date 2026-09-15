import { test } from "node:test";
import assert from "node:assert/strict";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QRCodeSVG } from "qrcode.react";

import { deploMarkDataUri } from "../components/logo";

const TOTP_URI =
  "otpauth://totp/deplo:someone%40acme.com?secret=ONWWMRJXGVBE2SDPIN2TEZKDKVVEW2TMJU4WSMTHN5GW4LKSJRDQ&issuer=deplo&digits=6&period=30";

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
  const modules = Number(/viewBox="0 0 (\d+) \d+"/.exec(svg)![1]);
  assert.ok(modules > 20, `expected a real QR version, got ${modules} modules`);

  const logoModules = Math.ceil((LOGO_PX / SIZE) * modules);
  const covered = (logoModules * logoModules) / (modules * modules);

  assert.ok(
    covered < 0.15,
    `the mark covers ${(covered * 100).toFixed(1)}% of the code; keep it under 15%`,
  );
});

test("a lower error-correction level would not survive the same hole", () => {
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
  assert.doesNotMatch(svg, /currentColor/);
  assert.match(svg, /fill="#0a0a0a"/, "the glyph is drawn dark");
  assert.match(svg, /fill="#ffffff"/, "on its own light badge");
});
