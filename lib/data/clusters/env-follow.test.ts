import { test } from "node:test";
import assert from "node:assert/strict";

import { parse } from "yaml";

import type { FailoverStack } from "./bundles";
import { withVars } from "./env-follow";

const stack = (composeYaml: string, over: Partial<FailoverStack> = {}) =>
  ({
    slug: "web",
    projectId: "prj_web",
    imageRef: "deplo/web:dpl_1",
    composeYaml,
    network: "deplo-team-team_a",
    env: {},
    registryAuth: [],
    composeUpArgs: [],
    ...over,
  }) as FailoverStack;

const SINGLE = `services:
  web:
    image: deplo/web:dpl_1
    environment:
      PORT: "3000"
      API_URL: "https://old.example"
      GONE: "x"
  deplo-connector_web:
    image: cloudflare/cloudflared
    environment:
      TUNNEL_TOKEN: "t0k3n"
`;

const envOf = (yaml: string, service: string) =>
  (parse(yaml) as { services: Record<string, { environment?: unknown }> })
    .services[service].environment;

test("a single image takes the new variables in its own service, and Deplo's PORT stays", () => {
  const out = withVars(
    stack(SINGLE, { vars: { API_URL: "https://old.example", GONE: "x" } }),
    { API_URL: "https://new.example", PRICE: "$5" },
    false,
  );
  assert.deepEqual(envOf(out.composeYaml, "web"), {
    PORT: "3000",
    API_URL: "https://new.example",
    // Compose reads $ as a variable: it travels escaped, as the deploy writes it.
    PRICE: "$$5",
  });
  // The connector beside it is not the App.
  assert.deepEqual(envOf(out.composeYaml, "deplo-connector_web"), {
    TUNNEL_TOKEN: "t0k3n",
  });
  assert.deepEqual(out.vars, { API_URL: "https://new.example", PRICE: "$5" });
});

test("without a record of the variables, only PORT is kept as Deplo's", () => {
  const out = withVars(
    stack(SINGLE),
    { API_URL: "https://new.example" },
    false,
  );
  assert.deepEqual(envOf(out.composeYaml, "web"), {
    PORT: "3000",
    API_URL: "https://new.example",
  });
});

test("a compose stack takes them in its env file, and its YAML is left alone", () => {
  const yaml =
    "services:\n  api:\n    image: x\n    environment:\n      - KEY=${KEY}\n";
  const out = withVars(
    stack(yaml, { env: { KEY: "old" } }),
    { KEY: "new" },
    true,
  );
  assert.equal(out.composeYaml, yaml);
  assert.deepEqual(out.env, { KEY: "new" });
});
