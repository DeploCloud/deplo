import { sameCapabilities } from "./membership-shared";
import type { Capability } from "./types";

/**
 * The maths behind Settings → Users → a person → their access in one team: how
 * the ticked nodes in the scope picker become the `grants` the
 * `setUserTeamAccess` mutation takes, and what "nothing changed" means.
 *
 * Pure and free of React so it can be tested directly — the editor
 * (`components/settings/users/user-access-editor.tsx`) holds the state, this
 * holds the rules.
 */

/** One node the admin ticked, with the set that REPLACES the role inside it. */
export interface TickedNode {
  kind: "project" | "folder" | "app";
  nodeId: string;
  capabilities: Capability[];
}

/** The `NodeGrantInput` shape of the mutation: one set, and the nodes it lands on. */
export interface NodeGrantPayload {
  projectIds: string[];
  folderIds: string[];
  appIds: string[];
  capabilities: Capability[];
}

/**
 * `view` is never a grant of its own — the server implies it for anyone who can
 * reach a node at all, and stores rows only for the rest (`writeNodeGrants`). So
 * it is dropped here too, which is also what makes two sets that differ only by
 * it group together instead of being sent as two identical payloads.
 */
const granted = (caps: Capability[]): Capability[] =>
  caps.filter((c) => c !== "view");

/**
 * Fold ticked nodes into one payload per DISTINCT capability set — the shape the
 * mutation is built for ("one capability set, applied to every node named here").
 * Ten apps that share a set travel as one payload, not ten.
 *
 * A node whose set is empty is dropped: the server would store no row for it and
 * silently fall back to the team role, so sending it is a lie. The editor
 * refuses to save in that state (see {@link emptyTickedNodes}) — this is the
 * second guard, not the first.
 */
export function groupGrants(nodes: TickedNode[]): NodeGrantPayload[] {
  const groups: { caps: Capability[]; payload: NodeGrantPayload }[] = [];
  for (const node of nodes) {
    const caps = granted(node.capabilities);
    if (caps.length === 0) continue;
    let group = groups.find((g) => sameCapabilities(g.caps, caps));
    if (!group) {
      group = {
        caps,
        payload: {
          projectIds: [],
          folderIds: [],
          appIds: [],
          capabilities: caps,
        },
      };
      groups.push(group);
    }
    if (node.kind === "project") group.payload.projectIds.push(node.nodeId);
    else if (node.kind === "folder") group.payload.folderIds.push(node.nodeId);
    else group.payload.appIds.push(node.nodeId);
  }
  return groups.map((g) => g.payload);
}

/**
 * Ticked nodes that would grant nothing. A tick with an empty set reads as "this
 * person owns this corner" and would do the opposite (the role keeps applying
 * there), so the editor names them and blocks the save rather than writing a
 * no-op.
 */
export function emptyTickedNodes(nodes: TickedNode[]): TickedNode[] {
  return nodes.filter((n) => granted(n.capabilities).length === 0);
}

/**
 * What this card would save, as one comparable string — the dirty check.
 *
 * Node grants only count while `granular` is on: the mutation ignores them
 * otherwise, so a stale tree left over from a mode switch must not light up the
 * Save button.
 */
export function accessSignature(input: {
  roleId: string | null;
  granular: boolean;
  nodes: TickedNode[];
}): string {
  const nodes = input.granular
    ? input.nodes
        .map((n) => `${n.kind}:${n.nodeId}=${[...granted(n.capabilities)].sort().join(",")}`)
        .sort()
    : [];
  return JSON.stringify([input.roleId, input.granular, nodes]);
}
