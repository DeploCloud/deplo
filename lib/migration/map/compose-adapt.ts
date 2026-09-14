import {
  isMap,
  isScalar,
  isSeq,
  Scalar,
  type Document,
  type YAMLMap,
} from "../../yaml";

import {
  DOKPLOY_PLATFORM,
  deploFilesPath,
  type SourcePlatformShape,
} from "./source-platform";
import {
  envFileScalars,
  readComposeDoc,
  serviceLikeMaps,
  stringScalar,
  toPlain,
} from "./compose-yaml";
import {
  externalNetworkKeys,
  platformNetworkKeys,
  stripHostNetworkMode,
  stripNetworks,
} from "./compose-networks";

/**
 * Keys a panel's own compose dialect adds and `docker compose` refuses outright:
 * `exclude_from_hc` on a service, `content` / `is_directory` on a long-syntax
 * volume. The file content already travels as a Files entry, so nothing is lost.
 */
function stripPanelComposeExtensions(
  serviceName: string,
  holder: YAMLMap,
  changes: string[],
): void {
  if (holder.has("exclude_from_hc")) {
    holder.delete("exclude_from_hc");
    changes.push(
      `${serviceName}: exclude_from_hc is the old panel's own key, which compose refuses - it was removed.`,
    );
  }
  const vols = holder.get("volumes", true);
  if (!isSeq(vols)) return;
  let stripped = 0;
  for (const entry of vols.items) {
    if (!isMap(entry)) continue;
    for (const key of ["content", "is_directory"])
      if (entry.has(key)) {
        entry.delete(key);
        stripped++;
      }
  }
  if (stripped > 0)
    changes.push(
      `${serviceName}: ${stripped} inline file key(s) (content, is_directory) are the old panel's own, which compose refuses - the files themselves came across under Files.`,
    );
}

/**
 * Docker's own rule for telling a NAMED volume from a path: no separator, and no
 * leading `.`, `~` or `$`.
 */
const NAMED_VOLUME_SOURCE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function isNamedVolumeSource(source: string): boolean {
  return NAMED_VOLUME_SOURCE.test(source.trim());
}

/**
 * A volume NAME somebody typed a slash onto (`memos/`). With no leading `./`,
 * `../` or `/` compose reads it as a name, not a path - then refuses the whole
 * stack over it. The source platform normalises on render; Deplo does it here.
 */
const VOLUME_NAME_WITH_SLASH = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\/+$/;

function trailingSlashOffVolume(source: string): string | null {
  return VOLUME_NAME_WITH_SLASH.exec(source.trim())?.[1] ?? null;
}

/**
 * A top-level volume naming storage OUTSIDE this stack - `external:`, a pinned
 * `name:`, a `driver_opts` bind - is storage the destination does not have. The
 * copy fills the stack's OWN volume, so the declaration has to point at it.
 */
function localiseStackVolumes(root: YAMLMap, changes: string[]): void {
  const declared = root.get("volumes", true);
  if (!isMap(declared)) return;
  for (const item of declared.items) {
    const body = item.value;
    if (!isMap(body)) continue;
    const pinned = stringScalar(body, "name")?.value;
    const opts = body.get("driver_opts", true);
    const device = isMap(opts) ? stringScalar(opts, "device")?.value : null;
    const external = body.get("external");
    const outside =
      external === true ||
      isMap(external) ||
      typeof pinned === "string" ||
      typeof device === "string";
    if (!outside) continue;
    const key = String((item.key as Scalar).value);
    item.value = null;
    changes.push(
      `${key} pointed at storage outside this stack${
        typeof device === "string" ? ` (${device} on the server)` : ""
      } - it is this app's own volume here, which is where its data was copied.`,
    );
  }
}

/**
 * Declare every named volume the services mount that the file itself does not: a
 * one-click template's compose is a FRAGMENT, and the platform synthesises the
 * top-level `volumes:` block on render, so the stored file is refused outright.
 */
function declareMissingVolumes(
  doc: Document,
  root: YAMLMap,
  mounted: Set<string>,
  changes: string[],
): void {
  if (mounted.size === 0) return;
  const declared = root.get("volumes", true);
  const known = isMap(declared)
    ? new Set(declared.items.map((i) => String((i.key as Scalar).value)))
    : new Set<string>();
  const missing = [...mounted].filter((v) => !known.has(v));
  if (missing.length === 0) return;

  if (isMap(declared)) for (const name of missing) declared.set(name, null);
  else
    root.set(
      "volumes",
      doc.createNode(Object.fromEntries(missing.map((n) => [n, null]))),
    );
  changes.push(
    `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} declared at the top of the compose file - {panel} added that block when it rendered the stack, and without it the stack will not start.`,
  );
}

/**
 * Every place OUTSIDE `services[].volumes` where a compose file names a file next
 * to itself: the env files, the label files, a build context, and the `secrets` /
 * `configs` blocks.
 */
function composeFileRefs(root: YAMLMap): [string, Scalar][] {
  const out: [string, Scalar][] = [];
  for (const { name: who, map: holder } of serviceLikeMaps(root)) {
    for (const target of envFileScalars(holder))
      out.push([`${who}.env_file`, target]);

    const label = holder.get("label_file", true);
    if (isScalar(label) && typeof label.value === "string")
      out.push([`${who}.label_file`, label]);
    else if (isSeq(label))
      for (const entry of label.items)
        if (isScalar(entry) && typeof entry.value === "string")
          out.push([`${who}.label_file`, entry]);

    const build = holder.get("build", true);
    if (isScalar(build) && typeof build.value === "string")
      out.push([`${who}.build`, build]);
    else if (isMap(build)) {
      const context = stringScalar(build, "context");
      if (context) out.push([`${who}.build`, context]);
    }
  }

  for (const block of ["secrets", "configs"] as const) {
    const declared = root.get(block, true);
    if (!isMap(declared)) continue;
    for (const item of declared.items) {
      if (!isMap(item.value)) continue;
      const file = stringScalar(item.value, "file");
      if (file)
        out.push([`${block}.${String((item.key as Scalar).value)}`, file]);
    }
  }
  return out;
}

/**
 * Turn the source platform's compose file into a Deplo one. A `../` source is not
 * merely wrong: Deplo reads it as climbing OUT of the sandbox, so the stack would
 * demand the host-volumes grant and then bind nothing. Edited as a DOCUMENT, so
 * anchors, comments and layout survive and an anchor is edited once.
 */
export function adaptComposeForDeplo(
  source: string,
  platform: SourcePlatformShape = DOKPLOY_PLATFORM,
): {
  compose: string;
  changes: string[];
} {
  const doc = readComposeDoc(source);
  if (!doc) return { compose: source, changes: [] };
  const root = doc.contents as YAMLMap;

  const changes: string[] = [];
  const declaredNetworks = { networks: toPlain(root.get("networks")) };
  const platformKeys = platformNetworkKeys(declaredNetworks, platform.networks);
  // A network the stack does not create is one the destination host does not have,
  // and compose refuses the whole stack over it. Dropping it is the right mapping,
  // not a loss: an Environment is one network (ADR-0028), which is what a shared
  // network on the source was for.
  const strays = [...externalNetworkKeys(declaredNetworks)].filter(
    (k) => !platformKeys.has(k),
  );
  const keys = new Set([...platformKeys, ...strays]);

  if (keys.size > 0) {
    const declared = root.get("networks", true);
    if (isMap(declared)) {
      for (const key of keys) declared.delete(key);
      if (declared.items.length === 0) root.delete("networks");
    }
    if (platformKeys.size > 0)
      changes.push(
        `${platform.name}'s shared network was removed - Deplo attaches the services to its own.`,
      );
    if (strays.length > 0)
      changes.push(
        `${strays.join(", ")} ${strays.length === 1 ? "lives" : "live"} on the server rather than in this stack, so Deplo could not bring ${strays.length === 1 ? "it" : "them"} across - apps in the same Environment already share one network.`,
      );
  }

  // Every named volume a service mounts, so an undeclared one can be declared
  // below rather than refused by `docker compose up`.
  const mounted = new Set<string>();

  for (const { name: serviceName, map: holder } of serviceLikeMaps(root)) {
    if (keys.size > 0) stripNetworks(holder, keys);
    stripHostNetworkMode(serviceName, holder, changes);
    stripPanelComposeExtensions(serviceName, holder, changes);

    // The file-mount paths, off both shapes of a volume entry. A SEQUENCE is what
    // tells a service's mounts from the top-level named-volume block.
    const vols = holder.get("volumes", true);
    if (!isSeq(vols)) continue;
    for (const entry of vols.items) {
      if (isScalar(entry) && typeof entry.value === "string") {
        const spec: string = entry.value;
        const idx = spec.indexOf(":");
        if (idx <= 0) continue;
        let source = spec.slice(0, idx);
        const rest = spec.slice(idx);

        const trimmed = trailingSlashOffVolume(source);
        if (trimmed) {
          changes.push(
            `${source} is a volume name with a slash on the end, which compose refuses - it is ${trimmed} here.`,
          );
          source = trimmed;
          entry.value = `${source}${rest}`;
        }
        if (isNamedVolumeSource(source)) mounted.add(source.trim());
        const rewritten = deploFilesPath(source);
        if (rewritten == null) continue;
        changes.push(`${source} now points at Deplo's files directory.`);
        entry.value = `${rewritten}${rest}`;
      } else if (isMap(entry)) {
        const src = stringScalar(entry, "source");
        if (!src) continue;
        const trimmed = trailingSlashOffVolume(src.value as string);
        if (trimmed) {
          changes.push(
            `${src.value} is a volume name with a slash on the end, which compose refuses - it is ${trimmed} here.`,
          );
          src.value = trimmed;
        }
        const type = stringScalar(entry, "type")?.value;
        if (
          (type === "volume" || type == null) &&
          isNamedVolumeSource(src.value as string)
        )
          mounted.add((src.value as string).trim());
        const rewritten = deploFilesPath(src.value as string);
        if (rewritten == null) continue;
        changes.push(`${src.value} now points at Deplo's files directory.`);
        src.value = rewritten;
      }
    }
  }

  localiseStackVolumes(root, changes);
  declareMissingVolumes(doc, root, mounted, changes);

  // The SAME `../files/x` rewrite, everywhere else a compose file can name a file
  // next to itself.
  for (const [where, target] of composeFileRefs(root)) {
    const rewritten = deploFilesPath(target.value as string);
    if (rewritten == null) continue;
    changes.push(
      `${target.value} now points at Deplo's files directory (${where}).`,
    );
    target.value = rewritten;
  }

  if (changes.length === 0) return { compose: source, changes: [] };
  return { compose: String(doc), changes };
}

/**
 * Point an `env_file` at the env file DEPLO writes, when the stack names one it
 * did not bring with it. The rule is deliberately narrow: an entry is retargeted
 * ONLY when the file is not one this app carries.
 */
export function retargetPlatformEnvFiles(
  source: string,
  carried: string[],
): { compose: string; changes: string[] } {
  const doc = readComposeDoc(source);
  if (!doc) return { compose: source, changes: [] };
  const root = doc.contents as YAMLMap;

  const have = new Set(
    carried.map((f) =>
      f
        .trim()
        .replace(/^\.\/+/, "")
        .replace(/^\/+/, ""),
    ),
  );
  const changes: string[] = [];
  const retarget = (value: string): string | null => {
    const named = value.trim().replace(/^\.\/+/, "");
    if (!named || named === ".env") return null;
    // An absolute path or one climbing out is a host path, not the platform's
    // env file - the compose gates decide about those, not this.
    if (named.startsWith("/") || named.split("/").includes("..")) return null;
    if (have.has(named)) return null;
    return "./.env";
  };

  for (const { name: who, map: holder } of serviceLikeMaps(root)) {
    for (const target of envFileScalars(holder)) {
      const next = retarget(target.value as string);
      if (!next) continue;
      changes.push(
        `${who} reads its variables from ${target.value}, which is the file the other platform wrote. It now reads Deplo's own - the values are this app's variables.`,
      );
      target.value = next;
    }
  }

  if (changes.length === 0) return { compose: source, changes: [] };
  return { compose: String(doc), changes };
}
