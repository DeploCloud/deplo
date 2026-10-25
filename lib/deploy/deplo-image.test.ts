import { test } from "node:test";
import assert from "node:assert/strict";

import { deploImageClaim } from "./deplo-image";
import { buildComposeStack } from "./compose-stack/render";
import { prepareSourceCompose } from "./build/source-compose";
import { lintCompose } from "./compose-lint/lint";

test("deplo/ on Docker Hub is Deplo's own; a variable in the namespace cannot be told apart", () => {
  for (const ref of [
    "deplo/web:dpl_0a1b2c3d",
    "docker.io/deplo/web",
    "index.docker.io/deplo/web:1",
    "Deplo/Web:dpl_1",
    "deplo/${APP}:1",
  ])
    assert.equal(deploImageClaim(ref), "deplo", ref);
  for (const ref of [
    "${IMAGE}",
    "${IMAGE:-nginx}",
    "${REGISTRY}/app:1",
    "docker.io/${NS}/app",
    "docker.io/${NAME}",
  ])
    assert.equal(deploImageClaim(ref), "unknown", ref);
  for (const ref of [
    "nginx:1.27",
    "myapp:${TAG}",
    "acme/deplo:dpl_1",
    "ghcr.io/deplo/web:1",
    "ghcr.io/${ORG}/app",
    "localhost/deplo/web",
    "deplo-web:latest",
    "org/${NAME}:1",
    "docker.io/nginx",
  ])
    assert.equal(deploImageClaim(ref), null, ref);
});

const stack = (compose: string) =>
  buildComposeStack({
    network: "deplo-team-team_test",
    compose,
    name: "deplo-shop",
    deployKey: "shop",
    appId: "p1",
    domainRoutes: [],
  });

test("a stack cannot run an image Deplo built for another app", () => {
  assert.throws(
    () => stack("services:\n  web:\n    image: deplo/other-app:dpl_0a1b2c3d\n"),
    /`deplo\/other-app:dpl_0a1b2c3d`, a name under `deplo\/`/,
  );
  assert.throws(
    () => stack("services:\n  web:\n    image: ${IMAGE}\n"),
    /takes its image name from a variable/,
  );
  // A built service is tagged by Deplo with this stack's own name.
  assert.match(
    stack(
      "services:\n  api:\n    build: .\n    image: deplo/shop-api:abc123\n",
    ),
    /deplo\/shop-api:abc123/,
  );
  assert.throws(
    () => stack("services:\n  api:\n    image: deplo/shop-api:abc123\n"),
    /a name under `deplo\/`/,
    "the stack's own name without a build is somebody's image to run",
  );
});

test("a compose file from the repository may not name an image in deplo/ it does not build", () => {
  assert.throws(
    () =>
      prepareSourceCompose(
        "services:\n  web:\n    image: deplo/other:dpl_1\n",
        {
          deployKey: "shop",
          tag: "abc123",
        },
      ),
    /docker-compose from your repository: service `web` uses `deplo\/other:dpl_1`/,
  );
  const built = prepareSourceCompose(
    "services:\n  web:\n    build: .\n    image: deplo/other:dpl_1\n",
    { deployKey: "shop", tag: "abc123" },
  );
  assert.match(built.yaml, /image: deplo\/shop-web:abc123/);
});

test("the editor marks an image in deplo/ on its line", () => {
  const diag = lintCompose(
    "services:\n  web:\n    image: deplo/other:dpl_1\n",
  ).find((d) => d.rule === "deplo-image");
  assert.equal(diag?.severity, "error");
  assert.equal(diag?.line, 3);
});
