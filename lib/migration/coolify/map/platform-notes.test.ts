import { test } from "node:test";
import assert from "node:assert/strict";

import { coolifyNotes } from "./platform-notes";
import { APP } from "./map-test-helpers";
import type { CoolifyApplication } from "../client";

test("coolifyNotes never puts a basic-auth credential in the report", () => {
  const notes = coolifyNotes({
    uuid: "app-9",
    build_pack: "dockerimage",
    custom_labels: Buffer.from(
      [
        "traefik.http.middlewares.http-basic-auth-app-9.basicauth.users=mxadmin:$2y$10$abcdefghijklmnopqrstuv",
        "traefik.http.routers.http-0-app-9.middlewares=http-basic-auth-app-9",
        "traefik.http.middlewares.staff.basicauth.users=ops:$apr1$xyz",
        "traefik.http.middlewares.staff.basicauth.usersfile=/etc/htpasswd",
      ].join("\n"),
      "utf8",
    ).toString("base64"),
  });
  assert.equal(notes.length, 1);
  assert.doesNotMatch(notes[0], /\$2y\$|\$apr1\$|http-basic-auth-app-9/);
  assert.match(notes[0], /staff\.basicauth\.users=<credentials>/);
  assert.match(notes[0], /staff\.basicauth\.usersfile=<credentials>/);
});

test("coolifyNotes names everything Deplo has nowhere to put", () => {
  const notes = coolifyNotes({
    uuid: "app-3",
    build_pack: "dockerfile",
    custom_labels: Buffer.from(
      "traefik.enable=true\ncom.acme.tier=web\n",
      "utf8",
    ).toString("base64"),
    custom_docker_run_options: "--gpus all",
    custom_network_aliases: "legacy-api",
    pre_deployment_command: "php artisan down",
    pre_deployment_command_container: "app",
    post_deployment_command: "php artisan up",
    redirect: "www",
    limits_cpuset: "0-1",
    limits_memory_swap: "1G",
    health_check_enabled: true,
    health_check_method: "POST",
    health_check_return_code: 204,
  });
  const all = notes.join("\n");

  assert.doesNotMatch(all, /traefik\.enable/);
  assert.match(all, /com\.acme\.tier=web/);
  assert.match(all, /--gpus all/);
  assert.match(all, /legacy-api/);
  assert.match(all, /ran before every deploy/);
  assert.match(all, /ran after every deploy/);
  assert.match(all, /bare domain to www/);
  assert.match(all, /CPUs 0-1/);
  assert.match(all, /memory swap limit of 1G/);
  assert.match(all, /method POST/);
  assert.match(all, /expected code 204/);
  assert.match(all, /Dockerfile was typed into/);
  assert.doesNotMatch(all, /Dokploy|Coolify/);
});

test("an application with nothing exotic produces no notes", () => {
  assert.deepEqual(coolifyNotes(APP), []);
});

test("custom labels Coolify never encoded are read as they came", () => {
  const plain = "com.acme.team=core\ncom.acme.tier=web";
  const notes = coolifyNotes({
    uuid: "a",
    custom_labels: plain,
  } as CoolifyApplication);
  assert.match(notes.join(" "), /com\.acme\.team=core, com\.acme\.tier=web/);

  const encoded = Buffer.from(plain).toString("base64");
  assert.deepEqual(
    coolifyNotes({ uuid: "a", custom_labels: encoded } as CoolifyApplication),
    notes,
  );
});

test("the panel's own proxy labels are dropped, a middleware somebody wrote is named", () => {
  const labels = [
    "traefik.enable=true",
    "traefik.http.routers.app-1-https.rule=Host(`web.acme.com`)",
    "traefik.http.services.app-1-https.loadbalancer.server.port=3000",
    "traefik.http.middlewares.gzip.compress=true",
    "traefik.http.middlewares.office.ipallowlist.sourcerange=10.0.0.0/8",
    "caddy_0=https://web.acme.com",
    "com.acme.tier=gold",
  ].join("\n");
  const notes = coolifyNotes({
    ...APP,
    custom_labels: Buffer.from(labels).toString("base64"),
  });
  const line = notes.find((n) => /label/.test(n)) ?? "";
  assert.match(line, /ipallowlist/);
  assert.match(line, /com\.acme\.tier/);
  assert.doesNotMatch(line, /traefik\.enable|routers\.app-1|gzip|caddy_0/);
});
