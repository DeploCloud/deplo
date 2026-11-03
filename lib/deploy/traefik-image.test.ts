import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { TRAEFIK_IMAGE, withTraefikImage } from "./traefik-stack";

const stack = (image: string) => `services:
  traefik:
    image: ${image} # the proxy
    container_name: deplo-traefik
    command:
      - --entrypoints.web.address=:80
`;

test("a stack on the floating tag or an older patch is moved to the pin", () => {
  for (const image of ["traefik:v3.7", "traefik:v3.7.16", "traefik:v3.7.10"]) {
    const next = withTraefikImage(stack(image));
    assert.ok(next, image);
    assert.match(next, new RegExp(`image: ${TRAEFIK_IMAGE} # the proxy\\n`));
    assert.match(next, /- --entrypoints\.web\.address=:80/);
  }
});

test("a stack on the pin, past it, or on a line someone picked is left alone", () => {
  const [, minor, patch] = TRAEFIK_IMAGE.match(/^traefik:(v\d+\.\d+)\.(\d+)$/)!;
  for (const image of [
    TRAEFIK_IMAGE,
    `traefik:${minor}.${Number(patch) + 1}`,
    "traefik:v3.6",
    "traefik:v3",
    "traefik:latest",
    "docker.io/library/traefik:v3.7",
  ])
    assert.equal(withTraefikImage(stack(image)), null, image);
});

test("both install scripts write the pinned image", () => {
  for (const script of ["install.sh", "install-agent.sh"]) {
    const text = readFileSync(join(process.cwd(), script), "utf8");
    const images = [...text.matchAll(/^\s+image: (traefik:\S+)$/gm)].map(
      (m) => m[1],
    );
    assert.deepEqual(images, [TRAEFIK_IMAGE], script);
  }
});
