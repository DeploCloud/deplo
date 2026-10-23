// The wire between two Deplos during a Deplo move (ADR-0035). Both sides run this file; a change bumps MOVE_PROTOCOL.
export const MOVE_PROTOCOL = 2;

// A move code names itself, so it is never mistaken for an API token (`deplo_`).
export const MOVE_CODE_PREFIX = "dmove_";

// How long a fresh code waits for the new Deplo to connect. Once bound it lives until the move ends.
export const MOVE_CODE_TTL_MS = 60 * 60_000;

// A workload paused for its copy starts again on its own once this lapses without a renewal.
export const PAUSE_LEASE_MS = 2 * 60_000;

// Sent by the new Deplo on every call, so the old one binds the code to the first instance that uses it.
export const MOVE_PEER_HEADER = "x-deplo-move-peer";
export const MOVE_PEER_URL_HEADER = "x-deplo-move-peer-url";
// The filename of an uploaded archive, on the `upload` step's response.
export const MOVE_FILENAME_HEADER = "x-deplo-move-filename";

export const MOVE_STEPS = [
  "hello",
  "dump",
  "workload",
  "pause",
  "resume",
  "volume",
  "hostpath",
  "files",
  "image",
  "upload",
  "finish",
  "cancel",
] as const;
export type MoveStep = (typeof MOVE_STEPS)[number];

export function isMoveStep(s: string): s is MoveStep {
  return (MOVE_STEPS as readonly string[]).includes(s);
}

// The old Deplo is never paused as a whole: it keeps running, and only lends each workload for its copy.
export type SourceMoveState =
  // A code exists and nothing has connected with it yet.
  | "armed"
  // The new Deplo connected (code bound to it).
  | "bound"
  // The new Deplo is copying: the snapshot was taken, workloads are copied one by one.
  | "copying"
  // The new Deplo finished. The code no longer works.
  | "done";

export type TargetMoveState =
  | "connected"
  // The database copy: this Deplo is frozen until it commits.
  | "copying"
  // Every workload is deployed here and its data copied in, one at a time.
  | "deploying"
  | "done"
  | "failed"
  | "cancelled";

export type MoveWorkloadState =
  | "waiting"
  | "copying"
  | "done"
  | "failed"
  // Left out: finished without the old Deplo before its data came across.
  | "skipped";

export interface MoveServerSummary {
  id: string;
  name: string;
  // The address the agent is dialed at, and its port.
  address: string;
  port: number | null;
  role: "workloads" | "storage" | "build" | "import";
  // True when the server holds the old panel itself.
  isPanelHost: boolean;
  // An agent has enrolled.
  enrolled: boolean;
  // The old Deplo reached its agent just now.
  reachable: boolean;
  agentVersion: string | null;
  apps: number;
  databases: number;
  // Each database's container name here: unique per server only, so two can collide on one new server.
  databaseHosts?: { id: string; name: string; host: string }[];
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

export type WorkloadKind = "app" | "database";

export interface WorkloadRef {
  kind: WorkloadKind;
  id: string;
}

// POST /api/deplo-move/workload  WorkloadRef -> what a copy of it needs, read live from its server.
export interface MoveWorkloadInfo extends WorkloadRef {
  name: string;
  slug: string;
  serverId: string;
  running: boolean;
  volumes: string[];
  // The app's own files directory (an app only).
  files: boolean;
  hostPaths: { path: string; allowFile: boolean }[];
  // Mounted, but the server's own (system paths, sockets, read-only binds): never copied, and `hostpath` refuses them.
  skippedHostPaths?: string[];
  // The image the app runs right now, with the deployment that built it (an app only).
  image: { ref: string; deploymentId: string } | null;
  // The archive an upload-sourced app builds from (an app only).
  upload: { filename: string } | null;
}

// POST pause/resume  WorkloadRef. A pause is a lease (PAUSE_LEASE_MS) every data step renews.
export interface MovePauseResponse {
  leaseUntil: string;
  wasRunning: boolean;
}

// POST volume {kind,id,volume} | hostpath {kind,id,path,allowFile} | files {kind:"app",id}
// | image {kind:"app",id,imageRef} | upload {kind:"app",id}: each answers with the raw stream.
export interface MoveVolumeRequest extends WorkloadRef {
  volume: string;
}
export interface MoveHostPathRequest extends WorkloadRef {
  path: string;
  allowFile: boolean;
}
export interface MoveImageRequest extends WorkloadRef {
  imageRef: string;
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
