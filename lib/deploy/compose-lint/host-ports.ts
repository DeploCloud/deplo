import { interpolates, loadComposeDoc, type ComposeDocShape } from "./document";

export function isValidPortMapping(p: unknown): boolean {
  if (typeof p === "number") return p > 0 && p < 65536;
  if (typeof p === "string") {
    // `- "${PORT}:80"` binds a host port once the env-file is read, so it counts and the grant is asked.
    if (interpolates(p)) return true;
    return /^(\d{1,3}(\.\d{1,3}){3}:)?[\d-]+(:[\d-]+){0,2}(\/(tcp|udp))?$/.test(
      p.trim(),
    );
  }
  if (p && typeof p === "object") {
    return "target" in (p as object);
  }
  return false;
}

// `expose:` binds nothing and is not counted: gating it charged the grant for two thirds of the fleet.
export function composePublishesPorts(composeYaml: string): boolean {
  const doc = loadComposeDoc<ComposeDocShape>(composeYaml);
  const services = doc?.services;
  if (!services || typeof services !== "object") return false;
  for (const svc of Object.values(services)) {
    const ports = svc?.ports;
    if (Array.isArray(ports) && ports.some(isValidPortMapping)) return true;
  }
  return false;
}

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
      if (typeof entry === "number") continue;
      if (typeof entry !== "string") continue;
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
