/**
 * The hint for the direction nobody thinks about: installing the agent is
 * OUTBOUND, while everything after is the control plane DIALING the agent's port,
 * which a stock cloud firewall has shut. Rides the FAILURE only, stays
 * conditional ("if this machine has a firewall") and names no source address -
 * a wrong one locks the operator out with a rule that looks right.
 *
 * ponytail: no source address, narrow the rule to one once the control plane can
 * report its own egress address.
 */
export const AGENT_PORT_NOTICE =
  "If this machine has a firewall, open TCP 9443 on it.";
