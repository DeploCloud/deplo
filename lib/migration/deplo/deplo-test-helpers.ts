import { buildConfigFor } from "../../frameworks";
import {
  DEPLO_EXPORT_VERSION,
  type DeploExport,
  type DeploExportApp,
  type DeploExportDatabase,
} from "./export-shape";

export function exportApp(over: Partial<DeploExportApp> = {}): DeploExportApp {
  return {
    id: "prj_web",
    name: "web",
    slug: "web",
    projectId: "prc_shop",
    environmentId: "environ_prod",
    folderId: null,
    serverId: "srv_1",
    status: "active",
    source: "github",
    repo: {
      provider: "github",
      url: "https://github.com/acme/web.git",
      repo: "acme/web",
      branch: "main",
    },
    dockerImage: null,
    compose: null,
    files: [],
    volumes: [],
    ports: [],
    build: buildConfigFor({}),
    autoDeploy: true,
    previewEnabled: false,
    resources: null,
    healthCheck: null,
    logo: null,
    env: [],
    domains: [],
    basicAuth: [],
    crons: [],
    backups: [],
    data: { volumes: [], hostMounts: [] },
    notes: [],
    ...over,
  };
}

export function exportDatabase(
  over: Partial<DeploExportDatabase> = {},
): DeploExportDatabase {
  return {
    id: "db_main",
    name: "main",
    type: "postgres",
    version: "16",
    host: "db-main",
    username: "app",
    dbName: "app",
    password: "pw",
    environmentId: "environ_prod",
    serverId: "srv_1",
    status: "running",
    exposedPort: null,
    customImage: null,
    customCommand: null,
    resources: null,
    mounts: [],
    crons: [],
    backups: [],
    data: {
      volumes: [
        {
          name: "deplo-db-main_db-main-data",
          mountPath: "/var/lib/postgresql/data",
        },
      ],
      hostMounts: [],
    },
    notes: [],
    ...over,
  };
}

export function deploExport(over: Partial<DeploExport> = {}): DeploExport {
  return {
    version: DEPLO_EXPORT_VERSION,
    instance: "another-instance",
    team: { id: "team_src", name: "Acme", slug: "acme" },
    otherTeams: [],
    canControl: { apps: true, databases: true },
    projects: [
      {
        id: "prc_shop",
        name: "Shop",
        environments: [
          { id: "environ_prod", name: "production", isDefault: true },
          { id: "environ_stage", name: "staging", isDefault: false },
        ],
      },
    ],
    folders: [],
    apps: [exportApp()],
    withheld: 0,
    databases: [exportDatabase()],
    sharedVars: [],
    servers: [],
    members: [],
    destinations: [],
    ...over,
  };
}
