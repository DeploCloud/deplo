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

const NAMED_VOLUME_SOURCE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function isNamedVolumeSource(source: string): boolean {
  return NAMED_VOLUME_SOURCE.test(source.trim());
}

const VOLUME_NAME_WITH_SLASH = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\/+$/;

function trailingSlashOffVolume(source: string): string | null {
  return VOLUME_NAME_WITH_SLASH.exec(source.trim())?.[1] ?? null;
}

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

  const mounted = new Set<string>();

  for (const { name: serviceName, map: holder } of serviceLikeMaps(root)) {
    if (keys.size > 0) stripNetworks(holder, keys);
    stripHostNetworkMode(serviceName, holder, changes);
    stripPanelComposeExtensions(serviceName, holder, changes);

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
