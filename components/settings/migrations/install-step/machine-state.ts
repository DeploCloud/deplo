export interface Unreachable {
  status: string;
  message: string;
}

export interface PendingMachine {
  serverId: string;
  name: string;
  installCommand: string;
  address: string;
}

export const AGENT_UNREACHABLE =
  "Deplo cannot reach the agent on this machine.";

export const PANEL_ADDRESS_NOTICE =
  "A proxy in front of the panel answers here, not the machine.";

export const CLOUDFLARE_ADDRESS_NOTICE =
  "This address is Cloudflare's, not the machine's.";
