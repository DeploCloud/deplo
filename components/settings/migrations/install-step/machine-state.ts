// Unreachable is what the probe said about a machine that answered badly or not at all.
export interface Unreachable {
  // `offline` (nothing answered) or `error` (answered, but not as itself).
  status: string;
  message: string;
}

// PendingMachine is a machine Deplo has registered and is now waiting to hear from.
export interface PendingMachine {
  serverId: string;
  name: string;
  installCommand: string;
  // Where it was registered - the typed IP, not the panel's name.
  address: string;
}

// Never "installed": the agent may also have been taken off since the last walk.
export const AGENT_UNREACHABLE =
  "Deplo cannot reach the agent on this machine.";

export const PANEL_ADDRESS_NOTICE =
  "A proxy in front of the panel answers here, not the machine.";

export const CLOUDFLARE_ADDRESS_NOTICE =
  "This address is Cloudflare's, not the machine's.";
