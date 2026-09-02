import { test } from "node:test";
import assert from "node:assert/strict";

import { composeDeclaredMounts } from "./compose-storage";

/**
 * What the Storage tab shows for a stack whose volumes live in its own compose.
 */

const stack = (compose: string) => ({
  slug: "wp",
  source: "compose",
  compose,
  repo: null,
  dockerImage: null,
});

test("named volumes the compose declares", () => {
  assert.deepEqual(
    composeDeclaredMounts(
      stack(`services:
  db:
    image: mariadb
    volumes:
      - db_data:/var/lib/mysql
  wordpress:
    image: wordpress
    volumes:
      - wp_data:/var/www/html
volumes:
  db_data:
  wp_data:
`),
    ),
    [
      { kind: "named", source: "db_data", mountPath: "/var/lib/mysql" },
      { kind: "named", source: "wp_data", mountPath: "/var/www/html" },
    ],
  );
});

test("a host bind is a row too", () => {
  assert.deepEqual(
    composeDeclaredMounts(
      stack(`services:
  app:
    image: nginx
    volumes:
      - /srv/media:/media
`),
    ),
    [{ kind: "host", source: "/srv/media", mountPath: "/media" }],
  );
});

test("a ./x bind resolves to the stack's own directory", () => {
  assert.deepEqual(
    composeDeclaredMounts(
      stack(`services:
  app:
    image: nginx
    volumes:
      - ./conf:/etc/nginx/conf.d
`),
    ),
    [
      {
        kind: "host",
        source: `${process.env.DEPLO_DATA_DIR || "/data"}/stacks/files/wp/conf`,
        mountPath: "/etc/nginx/conf.d",
      },
    ],
  );
});

test("a stack that mounts nothing has no rows", () => {
  assert.deepEqual(
    composeDeclaredMounts(
      stack(`services:
  app:
    image: nginx
`),
    ),
    [],
  );
});

test("an alias with no top-level volumes entry is not a volume", () => {
  assert.deepEqual(
    composeDeclaredMounts(
      stack(`services:
  app:
    image: nginx
    volumes:
      - undeclared:/data
`),
    ),
    [],
  );
});

test("an app that is not a compose stack declares nothing", () => {
  assert.deepEqual(
    composeDeclaredMounts({
      slug: "site",
      source: "github",
      compose: `services:
  app:
    image: nginx
    volumes:
      - db_data:/var/lib/mysql
volumes:
  db_data:
`,
      repo: { owner: "acme", name: "site" },
      dockerImage: null,
    }),
    [],
  );
});
