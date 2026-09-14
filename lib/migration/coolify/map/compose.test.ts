import { test } from "node:test";
import assert from "node:assert/strict";

import { coolifyCompose } from "./compose";
import { APP } from "./map-test-helpers";
import type { CoolifyApplication } from "../client";

test("a stack keeps the compose its author wrote", () => {
  const raw = "services:\n  app:\n    image: nginx\n";
  const { value, notes } = coolifyCompose({
    uuid: "svc-1",
    name: "wordpress",
    docker_compose_raw: raw,
    docker_compose: "services:\n  app:\n    container_name: app-ewc08w0\n",
  });
  assert.equal(value.composeFile, raw);
  assert.deepEqual(notes, []);
});

test("with no authored copy the rendered one comes across, and says so", () => {
  const { value, notes } = coolifyCompose({
    uuid: "svc-2",
    docker_compose: "services:\n  app:\n    image: nginx\n",
  });
  assert.match(value.composeFile ?? "", /^services:/);
  assert.equal(notes.length, 1);
  // The note carries the token, never a product's name.
  assert.match(notes[0], /\{panel\}/);
});

test("a service's address comes from SERVICE_FQDN_*, which is where Coolify keeps it", () => {
  // `services` has no fqdn column at all: 25 of 25 one-click services arrived with no domain while their own variables spelled one out.
  const raw = [
    "services:",
    "  it-tools:",
    "    image: corentinth/it-tools",
    "  worker:",
    "    image: busybox",
  ].join("\n");
  const { value } = coolifyCompose(
    { uuid: "svc-1", name: "it-tools", docker_compose_raw: raw },
    {
      env: [
        "SERVICE_FQDN_ITTOOLS_8080=https://tools.acme.com",
        "SERVICE_URL_ITTOOLS=tools.acme.com",
        "NOT_A_DOMAIN=x",
      ].join("\n"),
    },
  );
  assert.deepEqual(
    value.domains?.map((d) => [d.host, d.port, d.serviceName, d.https]),
    [["tools.acme.com", 8080, "it-tools", true]],
  );
});

test("a SERVICE_FQDN naming no service still brings the address over", () => {
  const { value } = coolifyCompose(
    {
      uuid: "svc-2",
      name: "ghost",
      docker_compose_raw: "services:\n  cms:\n    image: ghost\n",
    },
    { env: "SERVICE_FQDN_GHOST=https://blog.acme.com" },
  );
  assert.deepEqual(
    value.domains?.map((d) => [d.host, d.port, d.serviceName]),
    [["blog.acme.com", null, null]],
  );
});

test("SERVICE_FQDN_X and SERVICE_FQDN_X_PORT reach one domain with the port", () => {
  const raw = "services:\n  linkding:\n    image: sissbruecker/linkding\n";
  const { value } = coolifyCompose(
    { uuid: "svc-ld", name: "linkding", docker_compose_raw: raw },
    {
      env: [
        "SERVICE_FQDN_LINKDING=linkding.acme.com",
        "SERVICE_FQDN_LINKDING_9090=linkding.acme.com:9090",
      ].join("\n"),
    },
  );
  assert.deepEqual(
    value.domains?.map((d) => [d.host, d.port, d.serviceName]),
    [["linkding.acme.com", 9090, "linkding"]],
  );
});

test("the port survives when only the variable NAME carries it", () => {
  // Coolify resolves BOTH spellings to the same URL, so the port exists nowhere but the key - a portless compose domain falls back to the stack's default port and answers 502.
  const raw = "services:\n  linkding:\n    image: sissbruecker/linkding\n";
  const vars = [
    "SERVICE_FQDN_LINKDING=https://linkding.acme.com",
    "SERVICE_FQDN_LINKDING_9090=https://linkding.acme.com",
  ];
  for (const env of [vars.join("\n"), [...vars].reverse().join("\n")]) {
    const { value } = coolifyCompose(
      { uuid: "svc-ld", name: "linkding", docker_compose_raw: raw },
      { env },
    );
    assert.deepEqual(
      value.domains?.map((d) => [d.host, d.port, d.serviceName]),
      [["linkding.acme.com", 9090, "linkding"]],
      env,
    );
  }
});

test("a dockercompose application's own address gets a service and a port", () => {
  // The address is on the APPLICATION, not on a compose service, so the domain arrived naming neither and Deplo rendered no router at all - a 404 on every one of them.
  const raw = [
    "services:",
    "  web:",
    "    image: acme/web",
    "    ports:",
    "      - 8000:8000",
    "  worker:",
    "    image: acme/worker",
    "",
  ].join("\n");
  const { value } = coolifyCompose({
    uuid: "app-1",
    name: "stack-git",
    build_pack: "dockercompose",
    fqdn: "https://stack.acme.com",
    ports_exposes: "8000",
    docker_compose_raw: raw,
  } as CoolifyApplication);

  assert.deepEqual(
    value.domains?.map((d) => [d.host, d.port, d.serviceName]),
    [["stack.acme.com", 8000, "web"]],
  );
  assert.equal(value.routingPort, 8000);
  assert.match(value.platformNotes?.join(" ") ?? "", /routes it to "web"/);
});

test("two services exposing a port is a question, not a default", () => {
  const raw = [
    "services:",
    "  web:",
    "    image: acme/web",
    "    ports:",
    "      - 8000:8000",
    "  api:",
    "    image: acme/api",
    "    ports:",
    "      - 9000:9000",
    "",
  ].join("\n");
  const { value } = coolifyCompose({
    uuid: "app-2",
    name: "two",
    build_pack: "dockercompose",
    fqdn: "https://two.acme.com",
    ports_exposes: "8000",
    docker_compose_raw: raw,
  } as CoolifyApplication);
  assert.equal(value.domains?.[0].serviceName, null);
  assert.equal(
    value.platformNotes?.some((n) => /routes it to/.test(n)),
    false,
  );
});

test("a config file is named after the source its own compose binds", () => {
  const compose = [
    "services:",
    "  filebrowser:",
    "    image: filebrowser/filebrowser",
    "    volumes:",
    "      - ./filebrowser.json:/.filebrowser.json",
  ].join("\n");
  const { value } = coolifyCompose(
    {
      uuid: "svc-fb",
      name: "filebrowser",
      docker_compose_raw: compose,
    } as unknown as CoolifyApplication,
    {
      mounts: [
        {
          mountId: "f1",
          type: "file",
          // What Coolify records: the container path, whose basename is a DIFFERENT string from the file the compose actually binds.
          filePath: ".filebrowser.json",
          content: "{}",
          mountPath: "/.filebrowser.json",
        },
      ],
    },
  );
  assert.equal(value.mounts?.[0].filePath, "filebrowser.json");
  assert.equal(value.mounts?.[0].mountPath, "/.filebrowser.json");
});

test("the same file named by the panel's own absolute path lands the same way", () => {
  const compose = [
    "services:",
    "  app:",
    "    image: nginx",
    "    volumes:",
    "      - /data/coolify/services/svc-x/nginx.conf:/etc/nginx/nginx.conf",
  ].join("\n");
  const { value } = coolifyCompose(
    {
      uuid: "svc-x",
      name: "x",
      docker_compose_raw: compose,
    } as unknown as CoolifyApplication,
    {
      mounts: [
        {
          mountId: "f1",
          type: "file",
          filePath: "nginx.conf",
          content: "server {}",
          mountPath: "/etc/nginx/nginx.conf",
        },
      ],
    },
  );
  assert.equal(value.mounts?.[0].filePath, "nginx.conf");
});

test("a compose build pack pointed at a repository keeps the repository", () => {
  const { value } = coolifyCompose({
    ...APP,
    uuid: "cmp-1",
    build_pack: "dockercompose",
    docker_compose_raw: "services:\n  web:\n    build: .\n",
    docker_compose_location: "/docker-compose.yml",
    base_directory: "/apps/web",
  });
  assert.equal(value.sourceType, "git");
  assert.equal(value.customGitUrl, "https://github.com/acme/web");
  assert.equal(value.customGitBranch, "main");
  assert.equal(value.composePath, "/docker-compose.yml");
  // No repository, no build: the raw file is the whole stack.
  const { value: raw } = coolifyCompose({
    uuid: "cmp-2",
    name: "kv",
    docker_compose_raw: "services:\n  kv:\n    image: alpine\n",
  });
  assert.equal(raw.sourceType, "raw");
});
