import "server-only";

import { and, eq, or, sql } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  serverRetiredCerts,
  servers as serversTable,
} from "../../db/schema/control-plane/servers";
import { parseHostAddress } from "../../host-address";
import { nowIso } from "../../ids";
import { isLoopbackIp } from "../../deploy/domains";
import { dispatchServerAlert } from "../../notify/dispatch";
import { serverAddresses } from "./addresses";
import { getServerById } from "./roster";

// A server is known by its agent's key, never by its address (ADR-0050).

export type IdentityKind = "current" | "next" | "retired";

export interface ClaimedIdentity {
  serverId: string;
  name: string;
  /** The certificate the claim names: its key is what the handshake must prove. */
  certPem: string;
  kind: IdentityKind;
}

/** The server a link's claimed certificate belongs to, and whether it is still that server's identity. */
export async function claimedIdentity(
  fingerprint: string,
): Promise<ClaimedIdentity | null> {
  if (!fingerprint) return null;
  const [row] = await getDb()
    .select({
      id: serversTable.id,
      name: serversTable.name,
      current: serversTable.agentCertFingerprint,
      currentPem: serversTable.agentCertPem,
      nextPem: serversTable.agentNextCertPem,
    })
    .from(serversTable)
    .where(
      or(
        eq(serversTable.agentCertFingerprint, fingerprint),
        eq(serversTable.agentNextCertFingerprint, fingerprint),
      ),
    )
    .limit(1);
  if (row) {
    const current = row.current === fingerprint;
    const certPem = (current ? row.currentPem : row.nextPem) ?? "";
    // A pin with no certificate behind it has no key to prove: nothing can link to it.
    if (!certPem) return null;
    return {
      serverId: row.id,
      name: row.name,
      certPem,
      kind: current ? "current" : "next",
    };
  }
  const [old] = await getDb()
    .select({
      id: serversTable.id,
      name: serversTable.name,
      certPem: serverRetiredCerts.certPem,
    })
    .from(serverRetiredCerts)
    .innerJoin(serversTable, eq(serversTable.id, serverRetiredCerts.serverId))
    .where(eq(serverRetiredCerts.fingerprint, fingerprint))
    .limit(1);
  return old
    ? {
        serverId: old.id,
        name: old.name,
        certPem: old.certPem,
        kind: "retired",
      }
    : null;
}

/** Stored before the agent installs it, so a rotation cut halfway still has a certificate the door accepts. */
export async function stageNextCert(
  serverId: string,
  cert: { certPem: string; fingerprint: string },
): Promise<void> {
  await getDb()
    .update(serversTable)
    .set({
      agentNextCertPem: cert.certPem,
      agentNextCertFingerprint: cert.fingerprint,
    })
    .where(eq(serversTable.id, serverId));
}

export async function dropNextCert(
  serverId: string,
  fingerprint: string,
): Promise<void> {
  await getDb()
    .update(serversTable)
    .set({ agentNextCertPem: null, agentNextCertFingerprint: null })
    .where(
      and(
        eq(serversTable.id, serverId),
        eq(serversTable.agentNextCertFingerprint, fingerprint),
      ),
    );
}

/** The staged certificate becomes the server's own, and the one it replaces is retired. False when none was staged. */
export async function promoteNextCert(
  serverId: string,
  fingerprint: string,
): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const [row] = await tx
      .select({
        fingerprint: serversTable.agentCertFingerprint,
        certPem: serversTable.agentCertPem,
        nextPem: serversTable.agentNextCertPem,
      })
      .from(serversTable)
      .where(
        and(
          eq(serversTable.id, serverId),
          eq(serversTable.agentNextCertFingerprint, fingerprint),
        ),
      )
      .for("update");
    if (!row?.nextPem) return false;
    if (row.fingerprint && row.certPem)
      await tx
        .insert(serverRetiredCerts)
        .values({
          fingerprint: row.fingerprint,
          serverId,
          certPem: row.certPem,
          retiredAt: nowIso(),
        })
        .onConflictDoNothing();
    await tx
      .update(serversTable)
      .set({
        agentCertFingerprint: fingerprint,
        agentCertPem: row.nextPem,
        agentNextCertPem: null,
        agentNextCertFingerprint: null,
      })
      .where(eq(serversTable.id, serverId));
    return true;
  });
}

/** Forgets every key a server held: a new enrollment starts a new identity (ADR-0011). */
export async function forgetRetiredCerts(serverId: string): Promise<void> {
  await getDb()
    .delete(serverRetiredCerts)
    .where(eq(serverRetiredCerts.serverId, serverId));
}

export type CopySign = "both-answer" | "missed-rotation";

let sendAlert = dispatchServerAlert;

/** Stands in for the alert fan-out; unset puts it back. */
export function __setCopyAlertForTest(fn?: typeof dispatchServerAlert): void {
  sendAlert = fn ?? dispatchServerAlert;
}

/** A second machine holds this server's key: it is told apart only by behaving like one (ADR-0050). */
export function identityCopied(
  server: { serverId: string; name: string },
  sign: CopySign,
): void {
  const seen =
    sign === "both-answer"
      ? "Both connected to Deplo at once, and Deplo kept the one that was connected first."
      : "One of them connected with a key this server gave up when Deplo last renewed it, and Deplo refused it.";
  console.warn(
    `[deplo] two machines are using the identity of ${server.name} (${server.serverId}): ${sign}`,
  );
  sendAlert(server.serverId, {
    key: "server_identity_copied",
    dedupe: { id: `identity:${server.serverId}`, state: sign },
    title: `Two machines are using the identity of ${server.name}`,
    body:
      `${seen} This usually means a virtual machine was copied with Deplo's agent inside. ` +
      "On the copy, run the install command of a new server: it gives that machine its own identity.",
    path: `/settings/servers/${server.serverId}`,
  });
}

/** Where its link came from, whether that is one of its own addresses, and, for a server added without one, its address. */
export async function recordLinkOrigin(
  serverId: string,
  from: string | null,
  publicAddresses: readonly string[],
): Promise<void> {
  const own = publicAddresses
    .map((a) => parseHostAddress(a))
    .filter((p) => p && p.kind !== "hostname")
    .map((p) => p!.host);
  const first =
    own.find((a) => parseHostAddress(a)?.kind === "ipv4") ?? own[0] ?? null;
  try {
    const server = await getServerById(serverId);
    if (!server) return;
    const stored = await serverAddresses(server, { askAgent: false });
    const mine = new Set([...own, ...stored.v4, ...stored.v6]);
    const at = parseHostAddress(from)?.host;
    const behindRouter =
      !!at && !isLoopbackIp(at) && at !== "::1" && !mine.has(at);
    await getDb()
      .update(serversTable)
      .set({
        connectedFrom: from,
        behindRouter,
        ...(first
          ? {
              ip: sql`case when ${serversTable.ip} = '' then ${first} else ${serversTable.ip} end`,
              host: sql`case when ${serversTable.host} = '' then ${first} else ${serversTable.host} end`,
            }
          : {}),
      })
      .where(eq(serversTable.id, serverId));
  } catch (e) {
    console.error(
      `[deplo] could not record where ${serverId} connects from:`,
      e,
    );
  }
}

/** The installer's own server, marked once: every later check reads the mark, never an address. */
export async function markDeploHost(serverId: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx
      .update(serversTable)
      .set({ deploHost: false })
      .where(eq(serversTable.deploHost, true));
    await tx
      .update(serversTable)
      .set({ deploHost: true })
      .where(eq(serversTable.id, serverId));
  });
}
