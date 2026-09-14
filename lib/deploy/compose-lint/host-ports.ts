import { interpolates, loadComposeDoc, type ComposeDocShape } from "./document";

// Whether a `ports:` entry is a well-formed mapping.
export function isValidPortMapping(p: unknown): boolean {
  if (typeof p === "number") return p > 0 && p < 65536;
  if (typeof p === "string") {
    // `- "${PORT}:80"` is a host binding the moment the env-file is read, and the
    // shape below cannot match it. Counted, so the grant is asked for.
    if (interpolates(p)) return true;
    // "8080:80", "8080:80/tcp", "127.0.0.1:8080:80", "80", "8000-8010:8000-8010"
    return /^(\d{1,3}(\.\d{1,3}){3}:)?[\d-]+(:[\d-]+){0,2}(\/(tcp|udp))?$/.test(
      p.trim(),
    );
  }
  if (p && typeof p === "object") {
    // long form { target, published, protocol }
    return "target" in (p as object);
  }
  return false;
}

// Whether ANY service publishes a port on the HOST - the `canExposePorts` gate.
// `expose:` is NOT publishing and is deliberately not counted: it binds nothing, and
// gating it charged the grant for two thirds of a measured fleet.
export function composePublishesPorts(composeYaml: string): boolean {
  const doc = loadComposeDoc<ComposeDocShape>(composeYaml);
  const services = doc?.services;
  if (!services || typeof services !== "object") return false;
  for (const svc of Object.values(services)) {
    // Host-published mappings: any well-formed entry counts.
    const ports = svc?.ports;
    if (Array.isArray(ports) && ports.some(isValidPortMapping)) return true;
  }
  return false;
}

// The HOST ports a compose file would bind, deduped - WHICH, where
// `composePublishesPorts` answers whether. For the import, which has to say a
// `80:80` will not land before anything is created. Ranges expanded, bounded.
export function composeHostPorts(composeYaml: string): number[] {
  const doc = loadComposeDoc<ComposeDocShape>(composeYaml);
  const out = new Set<number>();
  const add = (n: unknown) => {
    const port = typeof n === "number" ? n : Number(String(n ?? "").trim());
    if (Number.isInteger(port) && port > 0 && port < 65536) out.add(port);
  };
  for (const svc of Object.values(doc?.services ?? {})) {
    const ports = svc?.ports;
    if (!Array.isArray(ports)) continue;
    for (const entry of ports) {
      if (entry && typeof entry === "object") {
        add((entry as { published?: unknown }).published);
        continue;
      }
      if (typeof entry === "number") continue; // `- 3000` is a container port
      if (typeof entry !== "string") continue;
      // `[ip:]host[-range]:container[/proto]` - the host side is the
      // second-to-last colon-separated field when there are two or more.
      const parts = entry.split("/")[0].split(":");
      if (parts.length < 2) continue;
      const host = parts[parts.length - 2];
      const range = /^(\d+)-(\d+)$/.exec(host);
      if (range) {
        const from = Number(range[1]);
        const to = Math.min(Number(range[2]), from + 24);
        for (let p = from; p <= to; p++) add(p);
        continue;
      }
      add(host);
    }
  }
  return [...out];
}
