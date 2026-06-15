import "server-only";

import { randomBytes } from "node:crypto";
import type {
  DeploData,
  Deployment,
  LogLine,
  Project,
} from "./types";
import { hashPassword, encryptSecret, randomToken } from "./crypto";

function id(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function iso(offsetMs: number): string {
  return new Date(Date.now() - offsetMs).toISOString();
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function buildLogs(framework: string): LogLine[] {
  const base = Date.now() - 4 * MIN;
  const t = (i: number) => new Date(base + i * 1200).toISOString();
  const lines: [string, LogLine["level"], string][] = [
    [t(0), "command", "Cloning github repository (branch: main)"],
    [t(1), "info", "Cloning completed in 842ms"],
    [t(2), "command", "Detected framework: " + framework],
    [t(3), "command", "Running \"install\" command: `bun install`"],
    [t(4), "info", "bun install v1.3.13"],
    [t(5), "info", "Resolved, downloaded and extracted 412 packages"],
    [t(6), "info", "Done in 6.10s"],
    [t(7), "command", "Running \"build\" command: `bun run build`"],
    [t(8), "info", "▲ Next.js 16.2.9"],
    [t(9), "info", "Creating an optimized production build ..."],
    [t(10), "info", "✓ Compiled successfully"],
    [t(11), "info", "✓ Collecting page data"],
    [t(12), "info", "✓ Generating static pages (18/18)"],
    [t(13), "info", "Route (app)                      Size    First Load JS"],
    [t(14), "info", "○ /                              5.2 kB        102 kB"],
    [t(15), "command", "Building container image (docker)"],
    [t(16), "info", "Pushing image to registry ... done"],
    [t(17), "command", "Configuring Traefik route + TLS (Let's Encrypt)"],
    [t(18), "info", "Deployment ready. Assigned production domain."],
  ];
  return lines.map(([ts, level, text]) => ({ ts, level, text }));
}

export function buildSeed(): DeploData {
  const teamId = id("team");
  const serverId = id("srv");
  const remoteServerId = id("srv");
  const userId = id("usr");

  const adminEmail = process.env.DEPLO_ADMIN_EMAIL || "admin@deluxhost.net";
  // Never seed a well-known default password in production. If the operator
  // didn't set DEPLO_ADMIN_PASSWORD, generate a random one and surface it once
  // in the server logs. The friendly fixed default is dev-only convenience.
  let adminPassword = process.env.DEPLO_ADMIN_PASSWORD;
  if (!adminPassword) {
    if (process.env.NODE_ENV === "production") {
      adminPassword = randomToken(12);
      console.warn(
        `\n[deplo] No DEPLO_ADMIN_PASSWORD set. Generated a one-time admin password for ${adminEmail}:\n\n    ${adminPassword}\n\nLog in and change it, or set DEPLO_ADMIN_PASSWORD and re-initialize for a stable credential.\n`
      );
    } else {
      adminPassword = "deplo-admin-2026";
    }
  }

  const deployments: Deployment[] = [];
  const logs: Record<string, LogLine[]> = {};

  function makeProject(opts: {
    name: string;
    framework: Project["framework"];
    repo: string;
    domain: string;
    branch?: string;
    build: Partial<Project["build"]>;
    extraDeploys?: number;
  }): Project {
    const projectId = id("prj");
    const branch = opts.branch || "main";
    const messages = [
      "Update ExtraView component to replace an outdated image asset",
      "Refactor Supabase connection handling in payload config",
      "fix: contact name in PrivacyPolicy section of PolicyModal",
      "chore: bump dependencies and lockfile",
      "feat: add dark mode toggle to navbar",
    ];
    const n = opts.extraDeploys ?? 3;
    let latestId: string | null = null;
    for (let i = 0; i < n; i++) {
      const depId = id("dpl");
      if (i === 0) latestId = depId;
      const status: Deployment["status"] = i === 0 ? "ready" : "ready";
      const dep: Deployment = {
        id: depId,
        projectId,
        status,
        environment: i === 0 ? "production" : i % 2 === 0 ? "production" : "preview",
        commitSha: randomBytes(4).toString("hex") + randomBytes(3).toString("hex"),
        commitMessage: messages[i % messages.length],
        commitAuthor: "IdraDev",
        branch,
        url: `https://${opts.domain.replace(/^https?:\/\//, "")}`,
        createdAt: iso(i * 7 * HOUR + 3 * MIN),
        readyAt: iso(i * 7 * HOUR),
        buildDurationMs: 38_000 + i * 4200,
        creator: "IdraDev",
      };
      deployments.push(dep);
      logs[depId] = buildLogs(frameworkLabel(opts.framework));
    }

    return {
      id: projectId,
      name: opts.name,
      slug: opts.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      teamId,
      serverId,
      framework: opts.framework,
      source: "github",
      dockerImage: null,
      repo: {
        provider: "github",
        url: `https://github.com/${opts.repo}`,
        repo: opts.repo,
        branch,
      },
      build: {
        framework: opts.framework,
        rootDirectory: "./",
        installCommand: "bun install",
        buildCommand: "bun run build",
        outputDirectory: ".next",
        startCommand: "bun run start",
        nodeVersion: "22.x",
        port: 3000,
        ...opts.build,
      },
      productionUrl: `https://${opts.domain.replace(/^https?:\/\//, "")}`,
      status: "active",
      autoDeploy: true,
      latestDeploymentId: latestId,
      createdAt: iso(40 * DAY),
      updatedAt: iso(3 * HOUR),
    };
  }

  const projects: Project[] = [
    makeProject({
      name: "showcase-esame",
      framework: "nextjs",
      repo: "IdraDev/showcase-esame",
      domain: "showcase-esame.deplo.app",
      build: { outputDirectory: ".next" },
    }),
    makeProject({
      name: "blinkmypc-temp",
      framework: "vite",
      repo: "IdraDev/blinkmypc-temp",
      domain: "blinkmypc-temp.deplo.app",
      build: {
        buildCommand: "bun run build",
        outputDirectory: "dist",
        startCommand: "",
      },
    }),
    makeProject({
      name: "idraweb",
      framework: "nextjs",
      repo: "IdraDev/idraweb",
      domain: "idragraphics.com",
      build: {},
    }),
  ];

  const dbId = id("db");
  const redisId = id("db");

  const s3Id = id("s3");

  const data: DeploData = {
    users: [
      {
        id: userId,
        email: adminEmail,
        name: "Idra Admin",
        passwordHash: hashPassword(adminPassword),
        role: "owner",
        avatarColor: "#50e3c2",
        createdAt: iso(60 * DAY),
      },
    ],
    teams: [
      {
        id: teamId,
        name: "Idra Arts",
        slug: "idra-arts",
        plan: "hobby",
        createdAt: iso(60 * DAY),
      },
    ],
    servers: [
      {
        id: serverId,
        name: "master",
        host: "localhost",
        type: "localhost",
        status: "online",
        ip: "127.0.0.1",
        dockerVersion: "27.3.1",
        traefikEnabled: true,
        cpuCores: 8,
        memoryMb: 16384,
        diskGb: 512,
        cpuUsage: 24,
        memoryUsage: 41,
        diskUsage: 38,
        createdAt: iso(60 * DAY),
      },
      {
        id: remoteServerId,
        name: "eu-west-1",
        host: "eu-west-1.deplo.app",
        type: "remote",
        status: "online",
        ip: "203.0.113.24",
        dockerVersion: "27.3.1",
        traefikEnabled: true,
        cpuCores: 4,
        memoryMb: 8192,
        diskGb: 160,
        cpuUsage: 12,
        memoryUsage: 33,
        diskUsage: 21,
        createdAt: iso(20 * DAY),
      },
    ],
    projects,
    deployments,
    logs,
    envVars: [
      {
        id: id("env"),
        projectId: projects[0].id,
        key: "DATABASE_URL",
        valueEnc: encryptSecret("postgres://app:secret@db.internal:5432/app"),
        targets: ["production", "preview", "development"],
        type: "secret",
        createdAt: iso(20 * DAY),
        updatedAt: iso(20 * DAY),
      },
      {
        id: id("env"),
        projectId: projects[0].id,
        key: "NEXT_PUBLIC_API_URL",
        valueEnc: encryptSecret("https://api.deplo.app"),
        targets: ["production", "preview", "development"],
        type: "plain",
        createdAt: iso(20 * DAY),
        updatedAt: iso(20 * DAY),
      },
      {
        id: id("env"),
        projectId: projects[0].id,
        key: "STRIPE_SECRET_KEY",
        valueEnc: encryptSecret("sk_live_51Hxxxxxxxxxxxxxxxxxxxxxx"),
        targets: ["production"],
        type: "secret",
        createdAt: iso(12 * DAY),
        updatedAt: iso(12 * DAY),
      },
    ],
    domains: [
      {
        id: id("dom"),
        projectId: projects[2].id,
        name: "idragraphics.com",
        status: "valid",
        primary: true,
        redirectTo: null,
        ssl: true,
        createdAt: iso(30 * DAY),
      },
      {
        id: id("dom"),
        projectId: projects[2].id,
        name: "www.idragraphics.com",
        status: "valid",
        primary: false,
        redirectTo: "idragraphics.com",
        ssl: true,
        createdAt: iso(30 * DAY),
      },
      {
        id: id("dom"),
        projectId: projects[0].id,
        name: "showcase-esame.deplo.app",
        status: "valid",
        primary: true,
        redirectTo: null,
        ssl: true,
        createdAt: iso(25 * DAY),
      },
    ],
    databases: [
      {
        id: dbId,
        name: "app-postgres",
        type: "postgres",
        version: "16",
        status: "running",
        serverId,
        host: "db-app-postgres.internal",
        port: 5432,
        connectionStringEnc: encryptSecret(
          "postgres://app:secret@db-app-postgres.internal:5432/app"
        ),
        exposedPublicly: false,
        sizeMb: 248,
        createdAt: iso(30 * DAY),
      },
      {
        id: redisId,
        name: "cache-redis",
        type: "redis",
        version: "7",
        status: "running",
        serverId,
        host: "db-cache-redis.internal",
        port: 6379,
        connectionStringEnc: encryptSecret(
          "redis://default:secret@db-cache-redis.internal:6379"
        ),
        exposedPublicly: false,
        sizeMb: 32,
        createdAt: iso(28 * DAY),
      },
    ],
    s3Destinations: [
      {
        id: s3Id,
        name: "Cloudflare R2 — backups",
        provider: "cloudflare-r2",
        endpoint: "https://<account>.r2.cloudflarestorage.com",
        region: "auto",
        bucket: "deplo-backups",
        accessKeyEnc: encryptSecret("R2_ACCESS_KEY_EXAMPLE"),
        secretKeyEnc: encryptSecret("R2_SECRET_KEY_EXAMPLE"),
        status: "connected",
        createdAt: iso(15 * DAY),
      },
    ],
    backups: [
      {
        id: id("bkp"),
        name: "Daily Postgres backup",
        databaseId: dbId,
        destinationId: s3Id,
        schedule: "0 3 * * *",
        retentionDays: 14,
        lastRunAt: iso(8 * HOUR),
        lastStatus: "success",
        enabled: true,
        createdAt: iso(15 * DAY),
      },
    ],
    apiTokens: [],
    activities: [
      activity("deployment", "Deployed showcase-esame to production", projects[0].id, 3 * HOUR),
      activity("deployment", "Deployed idraweb to production", projects[2].id, 5 * HOUR),
      activity("database", "Created database app-postgres", null, 30 * DAY),
      activity("domain", "Domain idragraphics.com verified", projects[2].id, 30 * DAY),
      activity("backup", "Backup Daily Postgres backup completed", null, 8 * HOUR),
      activity("s3", "Connected S3 destination Cloudflare R2", null, 15 * DAY),
    ],
  };

  return data;

  function activity(
    type: DeploData["activities"][number]["type"],
    message: string,
    projectId: string | null,
    offset: number
  ) {
    return {
      id: id("act"),
      type,
      message,
      actor: "IdraDev",
      projectId,
      createdAt: iso(offset),
    };
  }
}

function frameworkLabel(f: string): string {
  const map: Record<string, string> = {
    nextjs: "Next.js",
    vite: "Vite",
    sveltekit: "SvelteKit",
    svelte: "Svelte",
    astro: "Astro",
    nuxt: "Nuxt",
    remix: "Remix",
  };
  return map[f] || f;
}
