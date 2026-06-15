import "server-only";

import { read, mutate } from "../store";
import { assertUser } from "../auth";
import { newId, nowIso } from "../ids";
import { recordActivity } from "./activity";
import type { Server } from "../types";

export async function listServers(): Promise<Server[]> {
  await assertUser();
  // Master (localhost) first, then remotes by creation order.
  return [...read().servers].sort((a, b) => {
    if (a.type === b.type) return a.createdAt < b.createdAt ? -1 : 1;
    return a.type === "localhost" ? -1 : 1;
  });
}

export async function getServer(id: string): Promise<Server | null> {
  await assertUser();
  return read().servers.find((x) => x.id === id) || null;
}

export async function getPrimaryServer(): Promise<Server> {
  await assertUser();
  return (
    read().servers.find((s) => s.type === "localhost") ?? read().servers[0]
  );
}

export interface AddServerInput {
  name: string;
  host: string;
  sshPort?: number;
  sshUser?: string;
}

/**
 * Register a remote server. In a real deployment this triggers an SSH connection
 * that installs Docker + the Deplo agent; here it records the server in a
 * "provisioning" state until the agent reports back.
 */
export async function addServer(input: AddServerInput): Promise<Server> {
  const user = await assertUser();
  const host = input.host.trim();
  const server: Server = {
    id: newId("srv"),
    name: input.name.trim() || host,
    host,
    type: "remote",
    status: "provisioning",
    ip: host,
    dockerVersion: "",
    traefikEnabled: false,
    cpuCores: 0,
    memoryMb: 0,
    diskGb: 0,
    cpuUsage: 0,
    memoryUsage: 0,
    diskUsage: 0,
    createdAt: nowIso(),
  };
  mutate((d) => d.servers.push(server));
  recordActivity("member", `Connected server ${server.name}`, user.name, null);
  return server;
}

export async function removeServer(id: string): Promise<void> {
  const user = await assertUser();
  const server = read().servers.find((s) => s.id === id);
  if (!server) throw new Error("Server not found");
  if (server.type === "localhost")
    throw new Error("The master server cannot be removed");
  if (read().projects.some((p) => p.serverId === id))
    throw new Error("Move or delete projects on this server first");
  mutate((d) => {
    d.servers = d.servers.filter((s) => s.id !== id);
  });
  recordActivity("member", `Removed server ${server.name}`, user.name, null);
}
