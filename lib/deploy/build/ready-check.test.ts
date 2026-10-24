import { test } from "node:test";
import assert from "node:assert/strict";

import { defaultRoute } from "../../data/domains/routes";
import { readyCheckFor } from "./ready-check";

test("an app with a domain must answer on the routed port", () => {
  assert.deepEqual(
    readyCheckFor({ routes: [defaultRoute("a.example.com")], appPort: 3000 }),
    { port: 3000, portRequired: true, service: "" },
  );
  assert.deepEqual(
    readyCheckFor({
      routes: [defaultRoute("a.example.com", null, 8080)],
      appPort: 3000,
    }),
    { port: 8080, portRequired: true, service: "" },
  );
});

test("an app with no domain only has to stay up, its port is just watched", () => {
  assert.deepEqual(readyCheckFor({ routes: [], appPort: 3000 }), {
    port: 3000,
    portRequired: false,
    service: "",
  });
});

test("a stack checks the routed service, on its declared port when the domain names none", () => {
  const compose = `services:\n  web:\n    image: nginx\n    expose: ["8000"]\n  db:\n    image: postgres:16\n`;
  assert.deepEqual(
    readyCheckFor({
      routes: [defaultRoute("a.example.com", "web")],
      stack: true,
      compose,
    }),
    { port: 8000, portRequired: true, service: "web" },
  );
  assert.deepEqual(readyCheckFor({ routes: [], stack: true, compose }), {
    port: 0,
    portRequired: false,
    service: "",
  });
});
