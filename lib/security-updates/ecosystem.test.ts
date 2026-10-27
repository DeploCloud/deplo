import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isDistroEcosystem,
  osvQueryFor,
  parsePurl,
  versionFromImageTag,
} from "./ecosystem";

const debian = { id: "debian", version: "12.13" };

test("parsePurl: type, namespace, name, version and qualifiers", () => {
  assert.deepEqual(parsePurl("pkg:npm/%40babel/core@7.24.0?foo=bar#sub"), {
    type: "npm",
    namespace: "@babel",
    name: "core",
    version: "7.24.0",
    qualifiers: { foo: "bar" },
  });
  assert.equal(parsePurl("not-a-purl"), null);
  assert.equal(parsePurl("pkg:npm"), null);
});

test("osvQueryFor: Debian queries the SOURCE package of the image's release", () => {
  assert.deepEqual(
    osvQueryFor(
      "pkg:deb/debian/libssl3@3.0.11-1~deb12u2?arch=amd64&distro=debian-12.13&upstream=openssl",
      debian,
    ),
    { ecosystem: "Debian:12", name: "openssl", version: "3.0.11-1~deb12u2" },
  );
  assert.deepEqual(
    osvQueryFor(
      "pkg:deb/debian/libcurl4@7.88.1-10%2Bdeb12u14?upstream=curl%407.88.1-10%2Bdeb12u5",
      debian,
    ),
    { ecosystem: "Debian:12", name: "curl", version: "7.88.1-10+deb12u5" },
  );
});

test("osvQueryFor: Ubuntu, Alpine and Wolfi map to their OSV ecosystems", () => {
  assert.equal(
    osvQueryFor("pkg:deb/ubuntu/openssl@3.0.13-0ubuntu3", {
      id: "ubuntu",
      version: "24.04",
    })?.ecosystem,
    "Ubuntu:24.04",
  );
  assert.deepEqual(
    osvQueryFor("pkg:apk/alpine/libssl3@3.3.3-r0?upstream=openssl", {
      id: "alpine",
      version: "3.21.3",
    }),
    { ecosystem: "Alpine:v3.21", name: "openssl", version: "3.3.3-r0" },
  );
  assert.equal(
    osvQueryFor("pkg:apk/wolfi/glibc@2.40-r1", { id: "wolfi", version: "" })
      ?.ecosystem,
    "Wolfi",
  );
});

test("osvQueryFor: kernel headers are never queried", () => {
  assert.equal(
    osvQueryFor(
      "pkg:deb/debian/linux-libc-dev@6.1.164-1?upstream=linux",
      debian,
    ),
    null,
  );
  assert.equal(
    osvQueryFor("pkg:apk/alpine/linux-headers@6.6-r0", {
      id: "alpine",
      version: "3.21.3",
    }),
    null,
  );
});

test("osvQueryFor: language packages keep the name OSV expects", () => {
  assert.deepEqual(osvQueryFor("pkg:npm/%40scope/pkg@1.0.0", debian), {
    ecosystem: "npm",
    name: "@scope/pkg",
    version: "1.0.0",
  });
  assert.equal(
    osvQueryFor("pkg:pypi/Django_Rest.Framework@3.0", debian)?.name,
    "django-rest-framework",
  );
  assert.equal(
    osvQueryFor("pkg:maven/org.apache.logging.log4j/log4j-core@2.14.1", debian)
      ?.name,
    "org.apache.logging.log4j:log4j-core",
  );
  assert.deepEqual(osvQueryFor("pkg:golang/stdlib@go1.24.6", debian), {
    ecosystem: "Go",
    name: "stdlib",
    version: "1.24.6",
  });
  assert.equal(
    osvQueryFor("pkg:golang/github.com/gin-gonic/gin@v1.7.0", debian)?.name,
    "github.com/gin-gonic/gin",
  );
});

test("osvQueryFor: rpm, unknown types and a missing version are skipped", () => {
  assert.equal(osvQueryFor("pkg:rpm/redhat/openssl@3.0.7", debian), null);
  assert.equal(osvQueryFor("pkg:generic/foo@1", debian), null);
  assert.equal(osvQueryFor("pkg:npm/left-pad", debian), null);
  assert.equal(
    osvQueryFor("pkg:deb/debian/bash@5.2", { id: "debian", version: "" }),
    null,
  );
});

test("isDistroEcosystem", () => {
  assert.equal(isDistroEcosystem("Debian:12"), true);
  assert.equal(isDistroEcosystem("Alpine:v3.21"), true);
  assert.equal(isDistroEcosystem("npm"), false);
});

test("versionFromImageTag: a vendor's unversioned Go binary takes the image's tag", () => {
  assert.equal(
    versionFromImageTag(
      "pkg:golang/github.com/grafana/grafana",
      "grafana/grafana:8.3.0",
    ),
    "pkg:golang/github.com/grafana/grafana@v8.3.0",
  );
  assert.equal(
    versionFromImageTag(
      "pkg:golang/github.com/grafana/grafana?type=module",
      "grafana/grafana:v8.3.0",
    ),
    "pkg:golang/github.com/grafana/grafana@v8.3.0?type=module",
  );
  const keep = [
    [
      "pkg:golang/github.com/grafana/grafana@v8.3.1",
      "grafana/grafana:8.3.0",
      "it has its own version",
    ],
    [
      "pkg:golang/github.com/acme/tool",
      "grafana/grafana:8.3.0",
      "another module",
    ],
    [
      "pkg:golang/github.com/grafana/grafana",
      "grafana/grafana:latest",
      "a tag that is no version",
    ],
    ["pkg:npm/grafana", "grafana/grafana:8.3.0", "not a Go binary"],
  ];
  for (const [purl, ref, why] of keep)
    assert.equal(versionFromImageTag(purl, ref), purl, why);
});
