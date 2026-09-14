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
  // Coolify's own spellings. keydb and dragonfly speak RESP but store their own
  // formats, and libsql has no twin at all: all three answer null.
  postgresql: "postgres",
  mongodb: "mongodb",
  clickhouse: "clickhouse",
};

/**
 * The Deplo engine for one of the source platform's database tables, or null when
 * there is none (libsql, keydb, dragonfly).
 */
export function deploEngineFor(kind: string): DatabaseType | null {
  return DB_ENGINE[kind] ?? null;
}

export interface MappedDatabase {
  type: DatabaseType;
  name: string;
  /** The source image's tag, or "latest" when it had none. Display only - the
   *  image a database actually runs is {@link MappedDatabase.customImage}. */
  version: string;
  username: string | null;
  dbName: string | null;
  password: string | null;
  exposedPort: number | null;
  /** The image Dokploy ran, ALWAYS kept verbatim - see `mapDatabase`. */
  customImage: string;
  /**
   * The start command Dokploy overrode, or null.
   */
  command: string | null;
  /** The engine's config files, in Deplo's shape. Almost always empty. */
  mounts: { filePath: string; content: string; mountPath: string }[];
}

/** The version tag out of an image ref, ignoring a registry port. */
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

/** The repository half of an image ref (`bitnami/postgresql:15` → `bitnami/postgresql`). */
function imageRepo(image: string | null | undefined): string | null {
  const s = image?.trim();
  if (!s) return null;
  const tag = imageTag(s);
  return tag ? s.slice(0, s.length - tag.length - 1) : s;
}

/**
 * One of Dokploy's five database tables → `createDatabase` input.
 */
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

  // The source's EXACT image is kept, canonical or not - Deplo never re-derives one
  // here. Data must be reopened by the binary that wrote it.
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

  // A multi-line command is not something Deplo's column takes (it renders as a
  // quoted scalar in the compose), so that one still has to be retyped.
  const command = row.command?.trim() || null;
  if (command && /[\r\n\t]/.test(command))
    notes.push(
      `Custom start command on {panel} ("${truncate(command, 60)}") spans more than one line - set it under Advanced if you still need it.`,
    );
  // Dokploy models a database's own DATA volume as a mount row, so counting every
  // mount announced "extra files that are not imported" about the one thing the Data
  // step exists to copy - on every single database.
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

  // mysql and mariadb keep TWO credentials on Dokploy - an application user and root
  // - while Deplo models ONE and uses it for both.
  const rootPassword =
    (type === "mysql" || type === "mariadb") && row.databaseRootPassword?.trim()
      ? row.databaseRootPassword.trim()
      : null;
  // Said whenever root IS the login Deplo carries, not only when the two passwords
  // differ: the login changed either way, and half the panels answer with one password.
  if (rootPassword && row.databaseUser?.trim() !== "root")
    notes.push(
      `Connects as root, because that is the login Deplo's own backups and console use and the copied data keeps {panel}'s users. "${row.databaseUser?.trim() || "the application user"}" still works from inside the database.`,
    );

  // A variable that IS a credential Deplo carried came across - counting it read
  // as "your password did not make it", which is the opposite of what happened.
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
      // The tree's row has no name for a database (only its id), so a caller that
      // maps one straight from `project.all` would create "" here. The detail row
      // always has it; the fallback keeps this pure function total either way.
      name: row.name?.trim() || "database",
      version,
      username: rootPassword ? "root" : row.databaseUser?.trim() || null,
      dbName: row.databaseName?.trim() || null,
      password: rootPassword ?? (row.databasePassword?.trim() || null),
      // A real published port or nothing.
      exposedPort:
        typeof row.externalPort === "number" && row.externalPort > 0
          ? row.externalPort
          : null,
      customImage,
      command: command && !/[\r\n\t]/.test(command) ? command : null,
      // Every file mount Dokploy had, named and pathed the way Deplo stores
      // them. A file with no container path cannot be mounted anywhere and is
      // dropped by `mapMounts` with a note of its own.
      mounts: mapped.value.files.filter((f) => f.mountPath),
    },
    notes,
  };
}
