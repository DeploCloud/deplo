// The agent link's door (ADR-0038). The agent's side is deplo-agent internal/link.

/** The link listener's port inside the panel container; Traefik's `deplo-link` service targets it. */
export const LINK_PORT = 3001;
export const LINK_PATH = "/api/agent/link";
export const LINK_SUBPROTOCOL = "deplo-agent-link.v1";
/** sha256 of the agent's own leaf certificate, lowercase hex: the value the handshake pins. */
export const LINK_CERT_HEADER = "deplo-agent-cert";

/** The agent pings every 20 s; a link nothing was heard from for this long is cut. */
export const LINK_WATCHDOG_MS = 45_000;
/** How long a call waits for a server's missing link before it fails as offline. */
export const LINK_WAIT_MS = 10_000;
/** After the door opens, servers still on their way back are waited for: the agent backs off up to 30 s. */
export const LINK_SETTLE_MS = 45_000;
export const LINK_MAX_PAYLOAD = 4 * 1024 * 1024;
/** Per client address, sized for an office whose servers all relink after a panel restart. */
export const LINK_RATE_LIMIT = { limit: 120, windowMs: 60_000 };

/** Close codes after the upgrade; before it the door answers plain HTTP (400, 404, 429). */
export const LINK_CLOSE = {
  /** A newer verified link for the same server took over. */
  replaced: 4000,
  /** The inner handshake or the verifying Hello failed: not the server it claimed to be. */
  refused: 4001,
  /** The server was removed or its certificate replaced (ADR-0011). */
  revoked: 4002,
  stopping: 1001,
} as const;
