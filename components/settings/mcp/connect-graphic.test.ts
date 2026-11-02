import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DEPLO } from "../../iso/parts";
import { AGENTS } from "./agents";
import { ConnectGraphic } from "./connect-graphic";

test("the cable is drawn over Deplo's right face, so it reaches the port", () => {
  const agent = AGENTS.find((a) => a.id === "claude-code")!;
  const svg = renderToStaticMarkup(
    createElement(ConnectGraphic, { state: "connected", agent }),
  );
  const cube = svg.indexOf(`fill="${DEPLO.right}"`);
  const cable = svg.indexOf("iso-mcp-cable");
  assert.ok(cube > 0 && cable > 0, "both are drawn");
  assert.ok(cable > cube, "the cable comes after the cube");
});
