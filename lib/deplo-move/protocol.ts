// The wire between two Deplos during a Deplo move (ADR-0035). Both sides run this file; a change bumps MOVE_PROTOCOL.
export const MOVE_PROTOCOL = 1;

// A move code names itself, so it is never mistaken for an API token (`deplo_`).
export const MOVE_CODE_PREFIX = "dmove_";

// How long a fresh code waits for the new Deplo to connect. Once bound it lives until the move ends.
export const MOVE_CODE_TTL_MS = 60 * 60_000;

// Sent by the new Deplo on every call, so the old one binds the code to the first instance that uses it.
export const MOVE_PEER_HEADER = "x-deplo-move-peer";
export const MOVE_PEER_URL_HEADER = "x-deplo-move-peer-url";

export const MOVE_STEPS = [
  "hello",
  "freeze",
  "dump",
  "csr",
  "install",
  "finish",
  "thaw",
] as const;
export type MoveStep = (typeof MOVE_STEPS)[number];

export function isMoveStep(s: string): s is MoveStep {
  return (MOVE_STEPS as readonly string[]).includes(s);
}

export type SourceMoveState =
  // A code exists and nothing has connected with it yet.
  | "armed"
  // The new Deplo connected (code bound to it); nothing is paused yet.
  | "bound"
  // Changes are paused; the copy and the server handover run from here.
  | "frozen"
  // Every server answers to the new Deplo. Permanent.
  | "moved";

export type TargetMoveState =
  "connected" | "copying" | "handing_over" | "done" | "failed" | "cancelled";

export type MoveServerState = "waiting" | "handed_over" | "failed";

export interface MoveServerSummary {
  id: string;
  name: string;
  // The address the agent is dialed at, and its port.
  address: string;
  port: number | null;
  role: "workloads" | "storage" | "build" | "import";
  // True when the server holds the old panel itself.
  isPanelHost: boolean;
  // An agent has enrolled. A row that never got one has nothing to hand over and comes across as is.
  enrolled: boolean;
  // The old Deplo reached its agent just now.
  reachable: boolean;
  // Its agent can take a new certificate authority (Hello capability `cert-renewal`).
  canHandOver: boolean;
  agentVersion: string | null;
  apps: number;
  databases: number;
}

export interface MoveHello {
  protocol: number;
  version: string;
  // The last migration tag of the source's schema: a row copy needs both sides on the same one.
  schema: string;
  instance: string;
  panelUrl: string | null;
  state: SourceMoveState;
  counts: {
    teams: number;
    users: number;
    apps: number;
    databases: number;
    servers: number;
  };
  servers: MoveServerSummary[];
}

// POST /api/deplo-move/csr  {serverId}
export interface MoveCsrRequest {
  serverId: string;
}
export interface MoveCsrResponse {
  csrPem: string;
}

// POST /api/deplo-move/install  {serverId, certPem, caPem}
export interface MoveInstallRequest {
  serverId: string;
  certPem: string;
  caPem: string;
}

// POST /api/deplo-move/finish  {movedTo}
export interface MoveFinishRequest {
  movedTo: string;
  // Servers the new Deplo confirmed answer to it: an install whose answer was lost is recorded here.
  handedOver?: string[];
}

// The dump is NDJSON, one frame per line, tables in copy order.
export type DumpFrame =
  | { kind: "begin"; protocol: number; schema: string; tables: string[] }
  | {
      kind: "rows";
      table: string;
      rows: Record<string, unknown>[];
      // [row index in this frame, column] for a re-keyed value the source could not open: kept as ciphertext.
      unreadable: [number, string][];
    }
  | { kind: "end"; rows: number; unreadable: number };
