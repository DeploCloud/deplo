import type { DatabaseType } from "../../types/database";
import type { SourceDatabase, SourceDbKind } from "../model";

import { type Mapped, truncate } from "./source-platform";
import { parseEnvBlob } from "./env";
import { mapMounts } from "./mounts";

const DB_ENGINE: Record<string, DatabaseType> = {
  postgres: "postgres",
  mysql: "mysql",
  mariadb: "mariadb",
  mongo: "mongodb",
  redis: "redis",
  postgresql: "postgres",
  mongodb: "mongodb",
  clickhouse: "clickhouse",
};

export function deploEngineFor(kind: string): DatabaseType | null {
  return DB_ENGINE[kind] ?? null;
}

export interface MappedDatabase {
  type: DatabaseType;
  name: string;
  version: string;
  username: string | null;
  dbName: string | null;
  password: string | null;
  exposedPort: number | null;
  customImage: string;
  command: string | null;
  mounts: { filePath: string; content: string; mountPath: string }[];
}

export function imageTag(image: string | null | undefined): string | null {
  const s = image?.trim();
  if (!s) return null;
  const at = s.indexOf("@");
  const ref = at === -1 ? s : s.slice(0, at);
  const slash = ref.lastIndexOf("/");
  const colon = ref.lastIndexOf(":");
  if (colon === -1 || colon < slash) return null;
  const tag = ref.slice(colon + 1).trim();
  return /^[A-Za-z0-9._-]+$/.test(tag) ? tag : null;
}

function imageRepo(image: string | null | undefined): string | null {
  const s = image?.trim();
  if (!s) return null;
  const tag = imageTag(s);
  return tag ? s.slice(0, s.length - tag.length - 1) : s;
}

export function mapDatabase(
  kind: SourceDbKind,
  row: SourceDatabase,
): Mapped<MappedDatabase | null> {
  const notes: string[] = [];
  const type = deploEngineFor(kind);
  if (!type) {
    notes.push(
      kind === "unknown"
        ? `${row.name}: {panel} does not say which engine this database runs, so Deplo could not create it. Add it here and copy its data over.`
        : `${row.name}: Deplo has no ${kind} engine - not imported.`,
    );
    return { value: null, notes };
  }

  const customImage = row.dockerImage?.trim() || `${kind}:latest`;
  const tag = imageTag(customImage);
  const version = tag ?? "latest";
  if (!tag)
    notes.push(
      `{panel} runs ${customImage} with no version pinned, so what it resolves to can change under the data. Pin a version under Advanced.`,
    );
  const repo = imageRepo(row.dockerImage);
  const canonical =
    !repo ||
    repo === kind ||
    repo === type ||
    repo === `library/${kind}` ||
    (kind === "mongo" && repo === "mongo");
  if (!canonical)
    notes.push(
      `Runs ${customImage} on {panel} instead of a plain ${type}. Kept as it is - check that it starts.`,
    );

  const command = row.command?.trim() || null;
  if (command && /[\r\n\t]/.test(command))
    notes.push(
      `Custom start command on {panel} ("${truncate(command, 60)}") spans more than one line - set it under Advanced if you still need it.`,
    );
  const mapped = mapMounts(
    (row.mounts ?? []).filter((m) => m.type === "file"),
    { isCompose: false },
  );
  notes.push(...mapped.notes);
  const binds = (row.mounts ?? []).filter((m) => m.type === "bind");
  if (binds.length > 0)
    notes.push(
      `This database bind-mounts ${binds.length === 1 ? "a folder" : "folders"} from its host on {panel} (${binds
        .map((m) => m.hostPath || m.mountPath)
        .join(
          ", ",
        )}). Deplo databases have no host mounts - move what is in there another way.`,
    );

  const rootPassword =
    (type === "mysql" || type === "mariadb") && row.databaseRootPassword?.trim()
      ? row.databaseRootPassword.trim()
      : null;
  if (rootPassword && row.databaseUser?.trim() !== "root")
    notes.push(
      `Connects as root, because that is the login Deplo's own backups and console use and the copied data keeps {panel}'s users. "${row.databaseUser?.trim() || "the application user"}" still works from inside the database.`,
    );

  const carried = new Set(
    [
      rootPassword,
      row.databasePassword?.trim(),
      row.databaseUser?.trim(),
      row.databaseName?.trim(),
    ].filter((v): v is string => Boolean(v)),
  );
  const envKeys = parseEnvBlob(row.env)
    .filter((e) => !carried.has(e.value.trim()))
    .map((e) => e.key);
  if (envKeys.length > 0)
    notes.push(
      `Carried ${envKeys.length} environment variable(s) on {panel} (${envKeys.join(", ")}). A Deplo database has none - fold what matters into the image, the start command or a config file under Settings -> Advanced.`,
    );

  return {
    value: {
      type,
      name: row.name?.trim() || "database",
      version,
      username: rootPassword ? "root" : row.databaseUser?.trim() || null,
      dbName: row.databaseName?.trim() || null,
      password: rootPassword ?? (row.databasePassword?.trim() || null),
      exposedPort:
        typeof row.externalPort === "number" && row.externalPort > 0
          ? row.externalPort
          : null,
      customImage,
      command: command && !/[\r\n\t]/.test(command) ? command : null,
      mounts: mapped.value.files.filter((f) => f.mountPath),
    },
    notes,
  };
}
