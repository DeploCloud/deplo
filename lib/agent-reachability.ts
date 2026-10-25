// ponytail: no source address, narrow the rule to one once the control plane can report its own egress address.
export const AGENT_PORT_NOTICE =
  "If this machine has a firewall, open TCP 9443 on it.";

/** Why a server whose agent links in is offline: its link stayed away (ADR-0038). */
export const LINK_OFFLINE_MESSAGE =
  "Check that the machine is on and connected to the internet.";
