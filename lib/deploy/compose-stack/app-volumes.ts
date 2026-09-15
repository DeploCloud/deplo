import "server-only";

import type { MountPropagation } from "../../types/container";
import { mountOptions } from "../../apps/volume-model";
import { hostVolumeName } from "../../utils";
import { isReservedSharedName } from "../compose-lint/networks";
import type { App, ComposeDoc, ComposeStackInput } from "./types";

type StackMount = {
  source: string;
  target: string;
  readOnly: boolean;
  propagation?: MountPropagation;
};

function containerPathOf(entry: unknown): string | null {
  if (typeof entry === "string") {
    const parts = entry.split(":");
    const target = parts.length > 1 ? parts[1] : parts[0];
    const t = target.trim().replace(/\/+$/, "");
    return t || null;
  }
  if (entry && typeof entry === "object") {
    const t = (entry as Record<string, unknown>).target;
    if (typeof t === "string") return t.trim().replace(/\/+$/, "") || null;
  }
  return null;
}

function mergeVolumes(svc: App, mounts: StackMount[]): void {
  if (mounts.length === 0) return;
  const existing: unknown[] = Array.isArray(svc.volumes)
    ? [...svc.volumes]
    : [];
  const declared = new Set(
    existing.map(containerPathOf).filter((p): p is string => p !== null),
  );
  const added = mounts
    .filter((m) => !declared.has(m.target.replace(/\/+$/, "")))
    .map((m) => `${m.source}:${m.target}${mountOptions(m)}`);
  if (added.length === 0) return;
  svc.volumes = [...existing, ...added];
}

function rewriteMountSource(source: string, filesDir: string): string {
  if (source.includes("..")) return source;
  const m = source.match(/^\.\/?(.*)$/);
  if (!m) return source;
  const rel = m[1].replace(/^\/+/, "").replace(/\/+$/, "");
  return rel ? `${filesDir}/${rel}` : filesDir;
}

export function rewriteAppVolumes(svc: App, filesDir: string): void {
  const vols = svc.volumes;
  if (!Array.isArray(vols)) return;
  svc.volumes = vols.map((v) => {
    if (typeof v === "string") {
      const idx = v.indexOf(":");
      if (idx <= 0) return v;
      const source = v.slice(0, idx);
      return `${rewriteMountSource(source, filesDir)}${v.slice(idx)}`;
    }
    if (v && typeof v === "object") {
      const rec = v as Record<string, unknown>;
      if (typeof rec.source === "string") {
        rec.source = rewriteMountSource(rec.source, filesDir);
      }
    }
    return v;
  });
}

function defaultVolumeService(services: Record<string, App>): string {
  const names = Object.keys(services).filter((n) => !isReservedSharedName(n));
  const published = names.find((n) => {
    const ports = services[n]?.ports;
    return Array.isArray(ports) && ports.length > 0;
  });
  return published ?? names[0] ?? Object.keys(services)[0];
}

export function injectAppVolumes(
  doc: ComposeDoc,
  services: Record<string, App>,
  input: ComposeStackInput,
): void {
  const volumes = input.volumes ?? [];
  if (volumes.length === 0) return;

  const fallback = defaultVolumeService(services);
  const topLevel = (
    doc.volumes && typeof doc.volumes === "object" ? doc.volumes : {}
  ) as Record<string, unknown>;
  const takenKeys = new Set(Object.keys(topLevel));
  const byService = new Map<string, StackMount[]>();
  const declaredBySvc = new Map<string, Set<string>>();
  const declaredFor = (name: string): Set<string> => {
    let paths = declaredBySvc.get(name);
    if (!paths) {
      const vols = services[name].volumes;
      paths = new Set(
        (Array.isArray(vols) ? vols : [])
          .map(containerPathOf)
          .filter((p): p is string => p !== null),
      );
      declaredBySvc.set(name, paths);
    }
    return paths;
  };

  for (const v of volumes) {
    const svcName = (v.service ?? "").trim() || fallback;
    if (!svcName || !services[svcName]) {
      throw new Error(
        `Volume "${v.name || v.mountPath}" is set to mount into compose service ` +
          `"${svcName || "?"}", which this compose file does not define. Pick an ` +
          `existing service in Settings → Storage.`,
      );
    }
    const declared = declaredFor(svcName);
    const targetPath = v.mountPath.replace(/\/+$/, "");
    if (declared.has(targetPath)) continue;
    declared.add(targetPath);
    let source: string;
    if (v.type === "host") {
      source = (v.hostPath ?? "").trim();
    } else if (v.type === "app") {
      if (!input.filesDir) {
        throw new Error(
          `Volume "${v.name || v.mountPath}" mounts a file from this app, which ` +
            `needs the app's files directory - internal error.`,
        );
      }
      source = `${input.filesDir}/${(v.projectPath ?? "").replace(/^\.\/+/, "")}`;
    } else {
      let key = v.name;
      for (let n = 2; takenKeys.has(key); n++) key = `${v.name}-${n}`;
      takenKeys.add(key);
      topLevel[key] = { name: hostVolumeName(input.deployKey, v.name) };
      source = key;
    }
    const list = byService.get(svcName) ?? [];
    list.push({
      source,
      target: v.mountPath,
      readOnly: Boolean(v.readOnly),
      ...(v.propagation ? { propagation: v.propagation } : {}),
    });
    byService.set(svcName, list);
  }

  for (const [service, mounts] of byService) {
    mergeVolumes(services[service], mounts);
  }
  if (Object.keys(topLevel).length > 0) doc.volumes = topLevel;
}
