import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const API = "http://127.0.0.1:3000/api/graphql";
const TOKEN = readFileSync("/root/projects/deplo/.fwm/token", "utf8").trim();
const SERVER = "srv_3667cf1973005952"; // eu-main-1
const INSTALL = "ghi_fb046534356f874a"; // the team's GitHub App installation
const PREFIX = "fwm-";
const MATRIX = JSON.parse(
  readFileSync("/root/projects/deplo/.fwm/matrix.json", "utf8"),
);

async function gql(query, variables = {}) {
  const r = await fetch(API, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 400));
  return j.data;
}

const DETECT = `query($repo:String!,$url:String,$branch:String,$installationId:String,$buildMethod:String!,$rootDirectory:String){
  detectRepoFramework(repo:$repo,url:$url,branch:$branch,installationId:$installationId,buildMethod:$buildMethod,rootDirectory:$rootDirectory){
    id name defaultPort buildCommand startCommand } }`;

const CREATE = `mutation($input:CreateAppInput!){ createApp(input:$input){ id slug } }`;
const APP = `query($slug:String!){ app(slug:$slug){ id slug status framework frameworkDetected productionUrl
  latestDeployment { id status } } }`;
const DELETE = `mutation($id:String!){ deleteApp(id:$id) }`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Everything the wizard does for one repo, then wait for the first deploy. */
async function createOne(e, opts) {
  const url = `https://github.com/${e.repo}`;
  // The SERVER-SIDE detection, called as the resolver calls it. The panel on :3000
  // is the owner's own process and predates these fixes, so it is not restarted.
  const d = JSON.parse(
    execFileSync(
      "/usr/bin/node",
      [
        "--env-file=.env",
        "--require",
        "./lib/test/server-only-shim.cjs",
        "--import",
        "tsx",
        ".fwm/detect-fixed.mts",
        JSON.stringify({
          repo: e.repo,
          url,
          branch: e.branch,
          installationId: INSTALL,
          rootDirectory: e.root || null,
        }),
      ],
      { cwd: "/root/projects/deplo", maxBuffer: 16e6 },
    )
      .toString()
      .trim()
      .split("\n")
      .pop(),
  );

  const build = {
    buildMethod: opts.method,
    settings: {
      dockerfilePath: "Dockerfile",
      dockerContextPath: ".",
      railpackVersion: "latest",
      staticSinglePageApp: false,
    },
    installCommand: null,
    buildCommand: d?.buildCommand ?? null,
    outputDir: d?.staticOutput ?? null,
    // The whole point of the A/B: `legacy` reproduces what the wizard used to seed.
    startCommand: d?.startCommand ?? null,
    rootDir: e.root ? `./${e.root}` : "./",
    runtimeVersion: "",
    port: d?.defaultPort ?? 3000,
  };
  const app = (
    await gql(CREATE, {
      input: {
        name: `${PREFIX}${opts.prefix}${e.key}`,
        source: "GIT",
        serverId: SERVER,
        repo: {
          provider: "github",
          url,
          repo: e.repo,
          branch: e.branch,
          installationId: INSTALL,
        },
        build,
        autoDeploy: false,
        env: e.env ?? undefined,
      },
    })
  ).createApp;
  return { entry: e, detect: d, build, app };
}

async function waitReady(slug, budgetMs) {
  const until = Date.now() + budgetMs;
  let last = null;
  while (Date.now() < until) {
    const a = (await gql(APP, { slug })).app;
    last = a;
    const s = a?.latestDeployment?.status;
    if (
      s &&
      !["queued", "building", "deploying", "pending", "running"].includes(s)
    )
      return a;
    await sleep(15000);
  }
  return last;
}

/** The check that would have caught the Vite report: is the page the BUILD?
 * Retried: a deployment reads `ready` a few seconds before Traefik has its router. */
async function httpCheck(url, budgetMs = 120000) {
  const until = Date.now() + budgetMs;
  for (;;) {
    const r = await httpOnce(url);
    if (r.ok || Date.now() > until) return r;
    await sleep(10000);
  }
}

async function httpOnce(url) {
  if (!url) return { ok: false, why: "no url" };
  try {
    const r = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    });
    const body = (await r.text()).slice(0, 20000);
    const servesSource =
      /<script[^>]+src=["']\/(src|app)\//i.test(body) ||
      /\.(tsx|jsx)["']/i.test(body);
    return {
      ok: r.status === 200 && !servesSource,
      status: r.status,
      servesSource,
      len: body.length,
      snippet: body.slice(0, 200).replace(/\s+/g, " "),
    };
  } catch (err) {
    return { ok: false, why: String(err.message ?? err).slice(0, 120) };
  }
}

const [, , cmd, arg, ...flags] = process.argv;
const method = flags.includes("--nixpacks") ? "nixpacks" : "railpack";
const legacy = flags.includes("--legacy");
const prefix = flags.find((f) => f.startsWith("--prefix="))?.slice(9) ?? "";
const OUT = `/root/projects/deplo/.fwm/results-${method}${legacy ? "-legacy" : ""}.json`;

/** The control plane reads GitHub unauthenticated: 60/h for the whole instance,
 * and an exhausted budget makes detection answer null. Wait rather than measure it. */
async function awaitGithubBudget(need) {
  for (;;) {
    const r = await fetch("https://api.github.com/rate_limit").then((x) =>
      x.json(),
    );
    const { remaining, reset } = r.resources.core;
    if (remaining >= need) return remaining;
    const wait = Math.max(5, reset * 1000 - Date.now() + 5000);
    console.log(
      `github budget ${remaining}/${need}, waiting ${Math.round(wait / 1000)}s`,
    );
    await sleep(Math.min(wait, 15 * 60 * 1000));
  }
}

if (cmd === "create") {
  const only = flags
    .find((f) => f.startsWith("--only="))
    ?.slice(7)
    ?.split(",");
  const batch = MATRIX.filter(
    (e) =>
      (arg === "-" || String(e.batch) === String(arg)) &&
      (!only || only.includes(e.key)),
  );
  const made = [];
  for (const e of batch) {
    try {
      const r = await createOne(e, { method, legacy, prefix });
      made.push({
        key: e.key,
        slug: r.app.slug,
        id: r.app.id,
        detect: r.detect,
        sent: r.build,
      });
      console.log(
        "created",
        e.key,
        r.app.slug,
        "detected:",
        r.detect?.id,
        "port:",
        r.detect?.defaultPort,
        "out:",
        JSON.stringify(r.build.outputDir),
        "start:",
        JSON.stringify(r.build.startCommand),
      );
    } catch (err) {
      made.push({
        key: e.key,
        error: String(err.message ?? err).slice(0, 300),
      });
      console.log(
        "FAILED create",
        e.key,
        String(err.message ?? err).slice(0, 200),
      );
    }
  }
  writeFileSync(
    `/root/projects/deplo/.fwm/batch-${arg === "-" ? "x" : arg}-${method}${legacy ? "-legacy" : ""}.json`,
    JSON.stringify(made, null, 2),
  );
} else if (cmd === "wait") {
  const file = `/root/projects/deplo/.fwm/batch-${arg === "-" ? "x" : arg}-${method}${legacy ? "-legacy" : ""}.json`;
  const only = flags
    .find((f) => f.startsWith("--only="))
    ?.slice(7)
    ?.split(",");
  const made = JSON.parse(readFileSync(file, "utf8")).filter(
    (m) => !only || only.includes(m.key),
  );
  const out = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};
  await Promise.all(
    made
      .filter((m) => m.slug)
      .map(async (m) => {
        const a = await waitReady(m.slug, 25 * 60 * 1000);
        const http =
          a?.latestDeployment?.status === "ready"
            ? await httpCheck(a?.productionUrl)
            : { ok: false, why: "not ready" };
        const expected = MATRIX.find((e) => e.key === m.key).fw;
        out[m.key] = {
          expected,
          detectedByWizard: m.detect?.id ?? null,
          wizardPort: m.detect?.defaultPort ?? null,
          sentStart: m.sent?.startCommand ?? null,
          sentOutput: m.sent?.outputDir ?? null,
          storedFramework: a?.frameworkDetected ?? null,
          deploy: a?.latestDeployment?.status ?? null,
          url: a?.productionUrl ?? null,
          http,
          pass:
            a?.latestDeployment?.status === "ready" &&
            http.ok &&
            (a?.frameworkDetected ?? null) === expected,
        };
        console.log(
          out[m.key].pass ? "PASS" : "FAIL",
          m.key,
          JSON.stringify(out[m.key]).slice(0, 300),
        );
      }),
  );
  writeFileSync(OUT, JSON.stringify(out, null, 2));
} else if (cmd === "delete") {
  const apps = (await gql(`{ apps { id slug } }`)).apps.filter((a) =>
    a.slug.startsWith(PREFIX),
  );
  for (const a of apps) {
    await gql(DELETE, { id: a.id })
      .then(() => console.log("deleted", a.slug))
      .catch((e) => console.log("del fail", a.slug, e.message.slice(0, 120)));
  }
}
