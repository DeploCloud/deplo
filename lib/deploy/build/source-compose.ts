import "server-only";

import { posix } from "node:path";

import yaml from "../../yaml";
import { composeHostReach } from "../compose-lint/host-privileges";
import { stackSourceDir } from "../deploy-key";

type Rec = Record<string, unknown>;

export interface SourceComposeResult {
  // The stack as stored on the app: paths stay relative to the checkout.
  yaml: string;
  notes: string[];
}

const isRec = (v: unknown): v is Rec =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);

// A remote context is fetched by BuildKit itself, so it names no path on the server.
const isRemoteRef = (v: string) =>
  /^(https?:\/\/|git@|ssh:\/\/|docker-image:\/\/|service:|oci-layout:\/\/)/i.test(
    v.trim(),
  );

function insideCheckout(path: string): boolean {
  const p = path.trim();
  if (!p || p.startsWith("/") || p.startsWith("~") || p.includes("$"))
    return false;
  const norm = posix.normalize(p);
  return norm !== ".." && !norm.startsWith("../");
}

function refuse(message: string): never {
  throw new Error(`docker-compose from your repository: ${message}`);
}

// Whoever can push to the repository writes this file, so nothing in it may reach the server itself.
export function prepareSourceCompose(
  raw: string,
  opts: { deployKey: string; tag: string },
): SourceComposeResult {
  let doc: Rec;
  try {
    doc = (yaml.load(raw) as Rec) ?? {};
  } catch (e) {
    refuse(`it is not valid YAML (${e instanceof Error ? e.message : e}).`);
  }
  if (!isRec(doc) || !isRec(doc.services) || !Object.keys(doc.services).length)
    refuse("it has no services to deploy.");
  if (doc.include != null)
    refuse(
      "`include:` pulls in other files, which Deplo does not follow. Put those services in this file.",
    );

  const reach = composeHostReach(raw);
  if (reach.length > 0)
    refuse(
      `it reaches outside its containers (${reach.join("; ")}). A compose file read from a repository never may: ` +
        "use paths inside the repository (./data), or paste the file as a Docker Compose app.",
    );

  const notes: string[] = [];
  const services = doc.services as Rec;
  for (const [name, svc] of Object.entries(services)) {
    if (!isRec(svc)) continue;
    const ext = svc.extends;
    if (isRec(ext) && ext.file != null)
      refuse(
        `service \`${name}\` extends another file, which Deplo does not follow.`,
      );
    if (svc.build != null) prepareBuild(name, svc, opts, notes);
    if (svc.ports != null) {
      const exposed = containerPorts(svc.ports);
      delete svc.ports;
      if (exposed.length > 0)
        svc.expose = [
          ...new Set([
            ...(Array.isArray(svc.expose) ? svc.expose : []),
            ...exposed,
          ]),
        ];
      notes.push(
        `Service ${name}: its published ports are not opened on the server; its domain reaches it instead.`,
      );
    }
    if (svc.env_file != null)
      svc.env_file = optionalEnvFiles(name, svc.env_file);
  }
  for (const key of ["secrets", "configs"]) {
    const top = doc[key];
    if (!isRec(top)) continue;
    for (const [name, def] of Object.entries(top))
      if (
        isRec(def) &&
        typeof def.file === "string" &&
        !insideCheckout(def.file)
      )
        refuse(
          `${key.slice(0, -1)} \`${name}\` reads a file outside the repository.`,
        );
  }
  refuseSwappableEnvFiles(services);
  return { yaml: yaml.dump(doc, { lineWidth: -1, noRefs: true }), notes };
}

// Folders of the checkout a service mounts writable, as "a/b" ("" for the whole checkout).
export function writableSourceBinds(
  services: Rec,
): { service: string; folder: string }[] {
  const out: { service: string; folder: string }[] = [];
  for (const [service, svc] of Object.entries(services)) {
    if (!isRec(svc) || !Array.isArray(svc.volumes)) continue;
    for (const v of svc.volumes) {
      let source: string | null = null;
      let readOnly = false;
      if (typeof v === "string") {
        const parts = v.split(":");
        if (parts.length < 2) continue;
        source = parts[0];
        readOnly = parts.slice(2).join(":").split(",").includes("ro");
      } else if (isRec(v) && typeof v.source === "string") {
        source = v.source;
        readOnly = v.read_only === true;
      }
      if (!source || readOnly || !/^\.(\/|$)/.test(source)) continue;
      out.push({ service, folder: checkoutRel(source) });
    }
  }
  return out;
}

const checkoutRel = (p: string) => {
  const n = posix.normalize(p.trim());
  return n === "." ? "" : n.replace(/^\.\//, "").replace(/\/+$/, "");
};

// compose reads env_file on the server at every start: one inside a folder a container can write could become a link.
function refuseSwappableEnvFiles(services: Rec): void {
  const binds = writableSourceBinds(services);
  for (const [name, svc] of Object.entries(services)) {
    if (!isRec(svc) || !Array.isArray(svc.env_file)) continue;
    for (const e of svc.env_file) {
      const file = checkoutRel(isRec(e) ? String(e.path ?? "") : String(e));
      const bind = binds.find(
        (b) =>
          b.folder === "" ||
          file === b.folder ||
          file.startsWith(`${b.folder}/`),
      );
      if (bind)
        refuse(
          `service \`${name}\` reads env_file \`${file}\` from \`./${bind.folder}\`, which service \`${bind.service}\` mounts writable, ` +
            "so a container could swap it for a link. Mount that folder read-only (:ro), or keep the env file outside it.",
        );
    }
  }
}

function prepareBuild(
  name: string,
  svc: Rec,
  opts: { deployKey: string; tag: string },
  notes: string[],
): void {
  const build: Rec = isRec(svc.build)
    ? svc.build
    : { context: String(svc.build) };
  const context = typeof build.context === "string" ? build.context : ".";
  if (!isRemoteRef(context) && !insideCheckout(context))
    refuse(
      `service \`${name}\` builds from \`${context}\`, outside the repository.`,
    );
  if (typeof build.dockerfile === "string" && !insideCheckout(build.dockerfile))
    refuse(`service \`${name}\` names a Dockerfile outside the repository.`);
  if (build.ssh != null)
    refuse(`service \`${name}\` forwards SSH keys into its build.`);
  if (
    String(build.network ?? "")
      .trim()
      .toLowerCase() === "host"
  )
    refuse(`service \`${name}\` builds on the server's own network.`);
  if (build.privileged != null || build.entitlements != null)
    refuse(`service \`${name}\` asks for a privileged build.`);
  for (const v of contextValues(build.additional_contexts))
    if (!isRemoteRef(v) && !insideCheckout(v))
      refuse(
        `service \`${name}\` adds a build context outside the repository.`,
      );
  // A local cache import or export is a path on the server.
  delete build.cache_from;
  delete build.cache_to;
  svc.build = build;
  const image = `deplo/${opts.deployKey}-${imageSafe(name)}:${opts.tag}`;
  if (typeof svc.image === "string" && svc.image.trim() && svc.image !== image)
    notes.push(
      `Service ${name}: built as ${image}, not ${svc.image}, so its build can never stand in for an image another app pulls.`,
    );
  svc.image = image;
}

// Compose takes a map or a `name=path` list.
function contextValues(raw: unknown): string[] {
  if (Array.isArray(raw))
    return raw.map((e) => String(e).split("=").slice(1).join("="));
  return isRec(raw) ? Object.values(raw).map(String) : [];
}

function imageSafe(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[^a-z0-9]+/, "") || "service"
  );
}

function containerPorts(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const p of raw) {
    if (typeof p === "number") out.push(String(p));
    else if (typeof p === "string") {
      const target = p.split(":").pop()!.trim();
      if (/^\d+(-\d+)?(\/(tcp|udp))?$/.test(target)) out.push(target);
    } else if (isRec(p) && p.target != null) out.push(String(p.target));
  }
  return out;
}

// The repository rarely carries its .env (it is in .gitignore); Deplo's variables arrive on their own.
function optionalEnvFiles(name: string, raw: unknown): Rec[] {
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((entry) => {
    const path = isRec(entry) ? String(entry.path ?? "") : String(entry);
    if (!insideCheckout(path))
      refuse(`service \`${name}\` reads an env_file outside the repository.`);
    return { ...(isRec(entry) ? entry : {}), path, required: false };
  });
}

// The working copy the agent keeps for this app (the agent's <stack dir>/<slug>.src).
export function sourceComposeDir(deployKey: string, subdir: string): string {
  const rel = posix.normalize((subdir || "").replace(/^\.?\/+/, "") || ".");
  return rel === "."
    ? stackSourceDir(deployKey)
    : posix.join(stackSourceDir(deployKey), rel);
}

// At render, every path the stack reads resolves inside that working copy, whatever directory compose runs from.
export function anchorSourcePaths(stored: string, dir: string): string {
  const doc = (yaml.load(stored) as Rec) ?? {};
  const at = (p: string) => (isRemoteRef(p) ? p : posix.join(dir, p));
  for (const svc of Object.values(isRec(doc.services) ? doc.services : {})) {
    if (!isRec(svc)) continue;
    if (isRec(svc.build)) {
      const b = svc.build;
      b.context = at(typeof b.context === "string" ? b.context : ".");
      if (Array.isArray(b.additional_contexts))
        b.additional_contexts = b.additional_contexts.map((e) => {
          const [k, ...v] = String(e).split("=");
          return `${k}=${at(v.join("="))}`;
        });
      else if (isRec(b.additional_contexts))
        for (const [k, v] of Object.entries(b.additional_contexts))
          if (typeof v === "string") b.additional_contexts[k] = at(v);
    }
    if (Array.isArray(svc.env_file))
      svc.env_file = svc.env_file.map((e) =>
        isRec(e) && typeof e.path === "string" ? { ...e, path: at(e.path) } : e,
      );
  }
  for (const key of ["secrets", "configs"]) {
    const top = doc[key];
    if (!isRec(top)) continue;
    for (const def of Object.values(top))
      if (isRec(def) && typeof def.file === "string") def.file = at(def.file);
  }
  return yaml.dump(doc, { lineWidth: -1, noRefs: true });
}
