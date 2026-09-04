import { test } from "node:test";
import assert from "node:assert/strict";

import { getConvertedCompose, listProjects } from "./client";
import { dokployClient } from "./adapter";
import {
  __resetMigrationFetchForTest,
  __setMigrationFetchForTest,
  describeTransportError,
  normalizeSourceBaseUrl,
} from "../transport";

/**
 * The transport half of the import. Both cases here were measured against a real
 * Dokploy: a repo-backed stack answering the JSON body `null`, and the bare
 * "fetch failed" every connection problem used to arrive as.
 */

const cred = {
  kind: "dokploy" as const,
  baseUrl: "http://dokploy.test:3000",
  apiKey: "k",
};

function answers(body: unknown): void {
  __setMigrationFetchForTest(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
}

test("a compose Dokploy has not resolved yet is nothing, not the string null", async (t) => {
  t.after(__resetMigrationFetchForTest);

  // What the endpoint really answers for a git-backed stack it has not cloned.
  answers(null);
  assert.equal(await getConvertedCompose(cred, "c1"), null);

  // The same body arriving as text, which is how a Dokploy behind a proxy sends it.
  __setMigrationFetchForTest(
    async () => new Response("null\n", { status: 200 }),
  );
  assert.equal(await getConvertedCompose(cred, "c1"), null);

  answers("");
  assert.equal(await getConvertedCompose(cred, "c1"), null);
});

test("a real compose comes through, however Dokploy wraps it", async (t) => {
  t.after(__resetMigrationFetchForTest);

  answers("services:\n  web:\n    image: nginx\n");
  assert.match((await getConvertedCompose(cred, "c1")) ?? "", /^services:/);

  answers({
    compose: "null",
    resolved: "services:\n  web:\n    image: nginx\n",
  });
  assert.match((await getConvertedCompose(cred, "c1")) ?? "", /^services:/);
});

/** Route by procedure, which is the last path segment of a Dokploy call. */
function routes(by: Record<string, unknown>): void {
  __setMigrationFetchForTest(async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const proc = url.pathname.split("/").pop() ?? "";
    const body = proc in by ? by[proc] : null;
    return new Response(JSON.stringify(body), {
      status: proc in by ? 200 : 404,
      headers: { "content-type": "application/json" },
    });
  });
}

test("a network the PANEL attached is reported, not silently dropped", async (t) => {
  t.after(__resetMigrationFetchForTest);

  // The compose file never names it: Dokploy holds the attachment on its own row
  // and injects it at deploy time, so nothing in the YAML says it existed.
  routes({
    "network.all": [{ networkId: "n1", name: "shared-net" }],
    "compose.one": {
      composeId: "c1",
      composeFile: "services:\n  app:\n    image: nginx\n",
      serviceNetworks: [{ serviceName: "app", networkIds: ["n1"] }],
    },
  });
  const stack = await dokployClient(cred).getService("compose", "c1");
  assert.deepEqual(stack.platformNotes, [
    "Attached on {panel} to shared-net, a network on the server rather than part of this app - here every app in the same Environment already shares one network.",
  ]);

  // An application carries the same attachment under its own column.
  routes({
    "network.all": [{ networkId: "n1", name: "shared-net" }],
    "application.one": { applicationId: "a1", networkIds: ["n1"] },
  });
  const app = await dokployClient(cred).getService("application", "a1");
  assert.match(String(app.platformNotes?.[0]), /shared-net/);

  // Nothing attached, nothing said.
  routes({ "compose.one": { composeId: "c2", serviceNetworks: [] } });
  assert.deepEqual(
    (await dokployClient(cred).getService("compose", "c2")).platformNotes,
    [],
  );
});

// Measured on v0.30.5: the file carries the panel's own basic-auth middleware and
// whatever the operator added by hand; only the latter is worth a line.
test("a middleware written into the app's own Traefik file is reported by name", async (t) => {
  t.after(__resetMigrationFetchForTest);
  const traefik = `http:
  routers:
    mxweb-48qeb8-router-1:
      rule: Host(\`mxweb.example.com\`)
      service: mxweb-48qeb8-service-1
      middlewares:
        - auth-mxweb-48qeb8
        - mx-headers
      entryPoints:
        - web
  middlewares:
    mx-headers:
      headers:
        customResponseHeaders:
          X-Mx: "yes"
`;
  routes({
    "application.one": {
      applicationId: "a1",
      appName: "mxweb-48qeb8",
      env: "",
    },
    "application.readTraefikConfig": traefik,
  });
  const row = await dokployClient(cred).getService("application", "a1");
  const notes = row.platformNotes ?? [];
  assert.equal(notes.length, 1);
  assert.match(notes[0], /custom middleware, mx-headers \(headers\)/);
  assert.doesNotMatch(notes[0], /auth-mxweb/);

  // Nothing but the panel's own: no line at all. And no file: no line either.
  routes({
    "application.one": {
      applicationId: "a1",
      appName: "mxweb-48qeb8",
      env: "",
    },
    "application.readTraefikConfig":
      "http:\n  routers:\n    r:\n      middlewares:\n        - auth-mxweb-48qeb8\n        - redirect-to-https\n",
  });
  assert.deepEqual(
    (await dokployClient(cred).getService("application", "a1")).platformNotes,
    [],
  );
  routes({
    "application.one": {
      applicationId: "a1",
      appName: "mxweb-48qeb8",
      env: "",
    },
  });
  assert.deepEqual(
    (await dokployClient(cred).getService("application", "a1")).platformNotes,
    [],
  );
});

test("the organization's S3 stores come across whole, or not at all", async (t) => {
  t.after(__resetMigrationFetchForTest);
  routes({
    "destination.all": [
      {
        name: "nightly",
        endpoint: "https://s3.acme.test",
        bucket: "b",
        region: "",
        accessKey: "AK",
        secretAccessKey: "SK",
      },
      // A row the key may not read fully: no secret, no destination.
      {
        name: "half",
        endpoint: "https://s3.acme.test",
        bucket: "c",
        accessKey: "AK",
      },
    ],
  });
  assert.deepEqual(await dokployClient(cred).listBackupDestinations(), [
    {
      name: "nightly",
      endpoint: "https://s3.acme.test",
      bucket: "b",
      region: "us-east-1",
      accessKeyId: "AK",
      secretAccessKey: "SK",
    },
  ]);
  // An older Dokploy without the procedure answers nothing, never a failure.
  routes({});
  assert.deepEqual(await dokployClient(cred).listBackupDestinations(), []);
});

// Measured on a two-machine Dokploy: every service on the remote server read as
// stopped, because the panel was asked about its OWN host's containers.
test("a service on a remote machine is inspected on that machine", async (t) => {
  t.after(__resetMigrationFetchForTest);
  const asked: string[] = [];
  __setMigrationFetchForTest(async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    asked.push(
      `${url.pathname.split("/").pop()}?serverId=${url.searchParams.get("serverId") ?? ""}`,
    );
    const proc = url.pathname.split("/").pop();
    const body =
      proc === "docker.getContainersByAppLabel"
        ? [{ containerId: "c1", name: "web", state: "running" }]
        : proc === "docker.getConfig"
          ? {
              State: { Running: true },
              Mounts: [
                { Type: "volume", Name: "web-data", Destination: "/data" },
              ],
            }
          : null;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const query = {
    kind: "application",
    id: "a1",
    appName: "web",
    declaredVolumes: [],
    declaredBindMounts: [],
    composeFile: null,
  };
  const remote = await dokployClient(cred).serviceRuntime({
    ...query,
    serverId: "srv-2",
  });
  assert.equal(remote.running, true);
  assert.deepEqual(
    remote.volumes.map((v) => v.name),
    ["web-data"],
  );
  assert.ok(
    asked.includes("docker.getContainersByAppLabel?serverId=srv-2"),
    asked.join(","),
  );
  assert.ok(asked.includes("docker.getConfig?serverId=srv-2"), asked.join(","));
  // The panel's own host carries no id, and none is sent.
  asked.length = 0;
  await dokployClient(cred).serviceRuntime({ ...query, serverId: "" });
  assert.ok(
    asked.every((a) => a.endsWith("?serverId=")),
    asked.join(","),
  );
});

test("a Dokploy with no networks endpoint still imports", async (t) => {
  t.after(__resetMigrationFetchForTest);

  // `network.all` arrived with Dokploy's own Networks feature. On an older one the
  // procedure 404s, and an import that died there would be a worse answer than a
  // note that names the id.
  routes({
    "application.one": { applicationId: "a1", networkIds: ["n1"] },
  });
  const app = await dokployClient(cred).getService("application", "a1");
  assert.match(String(app.platformNotes?.[0]), /n1/);
});

/** The panel every message in these tests is about. */
const DOKPLOY = { name: "Dokploy", portHint: ":3000" };

test("a connection failure says which one it was", () => {
  const withCode = (code: string) =>
    describeTransportError(
      Object.assign(new TypeError("fetch failed"), { cause: { code } }),
      "https://dokploy.test",
      DOKPLOY,
    );

  assert.match(withCode("ECONNREFUSED"), /Nothing is listening/);
  assert.match(withCode("ECONNREFUSED"), /:3000/);
  assert.match(withCode("ENOTFOUND"), /does not resolve/);
  assert.match(withCode("ERR_SSL_WRONG_VERSION_NUMBER"), /not over https/);
  assert.match(withCode("CERT_HAS_EXPIRED"), /certificate/);

  const timeout = describeTransportError(
    Object.assign(new Error("The operation was aborted"), {
      name: "TimeoutError",
    }),
    "https://dokploy.test",
    DOKPLOY,
  );
  assert.match(timeout, /did not answer within/);

  // Even an unrecognised one names the address instead of saying "fetch failed".
  assert.match(
    describeTransportError(
      new TypeError("fetch failed"),
      "https://dokploy.test",
      DOKPLOY,
    ),
    /Could not reach Dokploy at https:\/\/dokploy\.test/,
  );
});

test("an https IP with a bad certificate is told it is the wrong field", () => {
  // The trap this exists for: the NEXT step asks for the machine's own address, and a
  // fair number of people come back and put it in the PANEL field.
  const certFail = (baseUrl: string) =>
    describeTransportError(
      Object.assign(new TypeError("fetch failed"), {
        cause: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" },
      }),
      baseUrl,
      DOKPLOY,
    );

  const onIp = certFail("https://185.58.122.151");
  assert.match(onIp, /issued for the panel's NAME/);
  assert.match(onIp, /asked for at the next step/);

  // A NAME with a bad certificate is a certificate problem and nothing else -
  // saying "wrong field" there would send someone to edit a field that is right.
  const onName = certFail("https://dokploy.acme.com");
  assert.doesNotMatch(onName, /next step/);
  assert.match(onName, /certificate/);

  // http on an IP is the same-machine case the field's own placeholder suggests,
  // so it never gets the lecture.
  assert.doesNotMatch(certFail("http://172.17.0.1:3000"), /next step/);
});

test("a failure raised by the transport reaches the caller readable", async (t) => {
  t.after(__resetMigrationFetchForTest);
  __setMigrationFetchForTest(async () => {
    throw Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    });
  });
  await assert.rejects(listProjects(cred), /Nothing is listening/);
  // The compose call still swallows: a stack Dokploy cannot resolve is a report
  // line, never a failed import.
  assert.equal(await getConvertedCompose(cred, "c1"), null);
});

test("the address keeps rejecting a key smuggled into it", () => {
  assert.throws(
    () => normalizeSourceBaseUrl("https://user:pass@dokploy.test"),
    /API key field/,
  );
});

test("starting a service again calls the stop procedure's own mirror", async (t) => {
  t.after(__resetMigrationFetchForTest);

  // Measured against a real Dokploy: `compose.stop` and `compose.start` are a
  // pair, and `application.start` exists too (it answered with its own tRPC
  // path, not a 404).
  const seen: { url: string; body: string }[] = [];
  __setMigrationFetchForTest(async (input, init) => {
    seen.push({
      url: String(input),
      body: String((init as RequestInit | undefined)?.body ?? ""),
    });
    return new Response("true", { status: 200 });
  });

  await dokployClient(cred).startService("compose", "c1");
  await dokployClient(cred).startService("application", "a1");

  assert.deepEqual(
    seen.map((s) => s.url),
    [
      "http://dokploy.test:3000/api/compose.start",
      "http://dokploy.test:3000/api/application.start",
    ],
  );
  assert.deepEqual(JSON.parse(seen[0].body), { composeId: "c1" });
  assert.deepEqual(JSON.parse(seen[1].body), { applicationId: "a1" });
});

test("a kind Dokploy has no procedure for is refused rather than posted", async () => {
  await assert.rejects(
    () => dokployClient(cred).startService("libsql", "x1"),
    /cannot start a libsql/i,
  );
});

test("a key that has run out of requests says where to raise it", async () => {
  __setMigrationFetchForTest(
    async () => new Response("Too many requests", { status: 429 }),
  );
  await assert.rejects(
    () => listProjects(cred),
    /hit its rate limit[\s\S]*raise or disable its rate limit/,
  );
  __resetMigrationFetchForTest();
});

// Measured on Dokploy v0.30.5: a key at its limit answers 401 Unauthorized, the
// same status as a wrong key. Only the history tells the two apart.
test("a 401 on a key that was accepted moments ago is the rate limit, not a typo", async (t) => {
  t.after(__resetMigrationFetchForTest);
  const fresh = { ...cred, apiKey: "born-limited" };
  const unauthorized = () =>
    new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
  // Never accepted: a plain refusal, said as one.
  __setMigrationFetchForTest(async () => unauthorized());
  await assert.rejects(
    () => listProjects(fresh),
    /failed \(401\)[\s\S]*Unauthorized/,
  );
  await assert.rejects(
    () => listProjects(fresh),
    (e: Error) => !/rate limit/.test(e.message),
  );
  // Accepted once, then refused: the limit.
  let calls = 0;
  __setMigrationFetchForTest(async () =>
    ++calls === 1
      ? new Response("[]", {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      : unauthorized(),
  );
  assert.deepEqual(await listProjects(fresh), []);
  await assert.rejects(
    () => listProjects(fresh),
    /accepted moments ago[\s\S]*rate limit or was revoked/,
  );
});

// A key is minted FOR one organization (Dokploy's own dialog picks one), and
// `organization.all` is the list the dialog is filled from - so the ones a key
// does not cover can be named instead of guessed at.
test("a key names its own organization and the ones it does not cover", async (t) => {
  t.after(__resetMigrationFetchForTest);

  __setMigrationFetchForTest(async (url) => {
    const body = url.includes("organization.all")
      ? [
          { id: "org_1", name: "Idra Arts" },
          { id: "org_2", name: "Acme" },
          { id: "org_3", name: "" },
        ]
      : {
          id: "org_1",
          name: "Idra Arts",
          logo: "data:image/webp;base64,AAAA",
        };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const src = dokployClient(cred);
  // Its picture comes over too: the wizard draws it on that team's row.
  assert.deepEqual(await src.sourceTeam(), {
    id: "org_1",
    name: "Idra Arts",
    avatarUrl: "data:image/webp;base64,AAAA",
  });
  assert.deepEqual(await src.otherTeams(), ["Acme", "org_3"]);
});

// An older Dokploy has no such procedure, and not knowing must never fail an
// import - or name teams that are not there.
test("a Dokploy that will not list its organizations says so", async (t) => {
  t.after(__resetMigrationFetchForTest);

  __setMigrationFetchForTest(
    async () => new Response("Not found", { status: 404 }),
  );

  const src = dokployClient(cred);
  assert.deepEqual(await src.sourceTeam(), {
    id: null,
    name: null,
    avatarUrl: null,
  });
  assert.equal(await src.otherTeams(), null);
});
