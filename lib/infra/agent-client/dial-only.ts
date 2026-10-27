import "server-only";

import type { AgentConnection } from "./connection";
import { AgentNotLinkedError } from "./errors";

// A dial to a server that has never linked carries only what brings it onto its link (ADR-0041).
type BringsItOver =
  | "hello"
  | "selfUpdate"
  | "renewalCsr"
  | "installRenewedCert"
  | "setLinkAddresses"
  | "stopListening"
  // ADR-0037's way out for the host running Deplo: the Update button.
  | "updateControlPlane"
  | "close";

type Refused = Exclude<keyof AgentConnection, BringsItOver>;

type Answer<K extends Refused> =
  ReturnType<AgentConnection[K]> extends AsyncGenerator<unknown, void, unknown>
    ? "stream"
    : ReturnType<AgentConnection[K]> extends Promise<unknown>
      ? "call"
      : "handle";

// How each refused call answers, checked against its signature: a new call fails to compile until listed.
const REFUSED: { [K in Refused]: Answer<K> } = {
  metrics: "call",
  containerStats: "call",
  streamMetrics: "stream",
  deploy: "stream",
  deployStream: "stream",
  reattach: "stream",
  stopStack: "call",
  startStack: "call",
  destroyStack: "call",
  reroute: "call",
  exportVolume: "stream",
  volumeUsage: "call",
  importVolume: "call",
  exportHostPath: "stream",
  importHostPath: "call",
  exportFiles: "stream",
  importFiles: "call",
  exportImage: "stream",
  importImage: "call",
  readStack: "call",
  checkPort: "call",
  probeHttp: "call",
  selfUninstall: "call",
  dockerCleanup: "call",
  listWorkloadImages: "call",
  inventoryImage: "call",
  inventoryCandidate: "call",
  preparePackageUpdate: "call",
  captureScreenshot: "call",
  hostInfo: "call",
  setTimezone: "call",
  traefikConfig: "call",
  restartControlPlane: "call",
  backup: "stream",
  restore: "stream",
  s3Check: "call",
  s3Delete: "call",
  storeCheck: "call",
  storeDelete: "call",
  readStoreFile: "stream",
  writeStoreFile: "call",
  restoreFrom: "stream",
  inspect: "call",
  followLogs: "handle",
  attach: "handle",
  listInstances: "call",
  exec: "call",
  shellLabel: "call",
  startJob: "call",
  pollJob: "call",
  killJob: "call",
  listFiles: "call",
  readFile: "call",
  writeFile: "call",
  filesExist: "call",
  deleteFile: "call",
};

/** The connection a dial gives: every other call fails as the curated "can't connect to Deplo". */
export function dialOnly(conn: AgentConnection): AgentConnection {
  const refusals = Object.fromEntries(
    Object.entries(REFUSED).map(([name, answer]) => [
      name,
      refusal(answer, conn),
    ]),
  );
  return { ...conn, ...refusals };
}

function refusal(
  answer: "call" | "stream" | "handle",
  conn: AgentConnection,
): () => unknown {
  if (answer === "call") return () => Promise.reject(new AgentNotLinkedError());
  if (answer === "stream") return refusedStream;
  // A handle cannot fail later without a caller missing it; the throw lets go of the connection first.
  return () => {
    conn.close();
    throw new AgentNotLinkedError();
  };
}

async function* refusedStream(): AsyncGenerator<never, void, unknown> {
  throw new AgentNotLinkedError();
}
