import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  isUnnamedEntry,
  serviceImage,
  unnamedPlaces,
  unnamedVolumeName,
  volumeAdoptions,
} from "./unnamed-volumes";

const FISE = `
services:
  fise-web:
    build: .
  fise-db:
    image: postgres:17
    volumes:
      - "./data/db:/var/lib/postgresql"
  cache:
    image: redis:7
    volumes:
      - /data
      - type: volume
        target: /scratch
  web:
    image: \${IMAGE}
`;

describe("unnamed volumes", () => {
  test("an image's own volume under a parent folder is still unnamed", () => {
    const places = unnamedPlaces(
      { compose: FISE, composeStack: true, volumes: [] },
      new Map([["fise-db", ["/var/lib/postgresql/data"]]]),
    );
    assert.deepEqual(places, [
      { service: "fise-db", path: "/var/lib/postgresql/data", origin: "image" },
      { service: "cache", path: "/data", origin: "compose" },
      { service: "cache", path: "/scratch", origin: "compose" },
    ]);
  });

  test("a path the compose file or a Volume already names is left alone", () => {
    const compose = `
services:
  db:
    image: postgres:17
    volumes:
      - pg:/var/lib/postgresql/data/
volumes:
  pg: {}
`;
    const declared = new Map([["db", ["/var/lib/postgresql/data"]]]);
    assert.deepEqual(
      unnamedPlaces({ compose, composeStack: true, volumes: [] }, declared),
      [],
    );
    assert.deepEqual(
      unnamedPlaces(
        {
          compose: FISE,
          composeStack: true,
          volumes: [
            { service: "fise-db", mountPath: "/var/lib/postgresql/data" },
            { service: "cache", mountPath: "/data/" },
            { service: "cache", mountPath: "/scratch" },
          ],
        },
        new Map([["fise-db", ["/var/lib/postgresql/data"]]]),
      ),
      [],
    );
  });

  test("a single image's volumes are its one container's", () => {
    assert.deepEqual(
      unnamedPlaces(
        { composeStack: false, volumes: [{ mountPath: "/var/lib/mysql" }] },
        new Map([["", ["/var/lib/mysql", "/etc/mysql/conf.d"]]]),
      ),
      [{ service: null, path: "/etc/mysql/conf.d", origin: "image" }],
    );
  });

  test("only a published image is read: no build, no variable", () => {
    assert.equal(serviceImage({ image: "postgres:17" }), "postgres:17");
    assert.equal(serviceImage({ image: "x", build: "." }), null);
    assert.equal(serviceImage({ image: "${IMAGE}" }), null);
    assert.equal(serviceImage({}), null);
  });

  test("an entry names nothing only without a source", () => {
    assert.equal(isUnnamedEntry("/data"), true);
    assert.equal(isUnnamedEntry({ type: "volume", target: "/d" }), true);
    assert.equal(isUnnamedEntry("pg:/data"), false);
    assert.equal(isUnnamedEntry({ type: "tmpfs", target: "/t" }), false);
    assert.equal(
      isUnnamedEntry({ type: "bind", source: "./x", target: "/t" }),
      false,
    );
  });

  test("names read as the place and never repeat", () => {
    const taken = new Set(["fise-db-data"]);
    const place = {
      service: "fise-db",
      path: "/var/lib/postgresql/data",
      origin: "image" as const,
    };
    assert.equal(unnamedVolumeName(place, taken), "fise-db-data-2");
    assert.equal(unnamedVolumeName({ ...place, service: null }, taken), "data");
  });

  test("the agent is told each mount onto a Volume Deplo made", () => {
    const rendered = `
services:
  fise-db:
    volumes:
      - /srv/files/fise/data/db:/var/lib/postgresql
      - fise-db-data:/var/lib/postgresql/data
  web:
    volumes:
      - mine:/x
volumes:
  fise-db-data:
    name: deplo-fise-fise-db-data
  mine:
    name: deplo-fise-mine
`;
    assert.deepEqual(
      volumeAdoptions(rendered, new Set(["deplo-fise-fise-db-data"])),
      [
        {
          service: "fise-db",
          target: "/var/lib/postgresql/data",
          volume: "deplo-fise-fise-db-data",
        },
      ],
    );
    assert.deepEqual(volumeAdoptions(rendered, new Set()), []);
  });
});
