/**
 * The one sentence about the direction nobody thinks about.
 *
 * Installing the agent is OUTBOUND work: the host fetches a script and the agent
 * calls the control plane home, both over 443, both fine behind any firewall.
 * Everything Deplo does with that host afterwards is the opposite direction - the
 * control plane dialing the agent's own port - and a stock cloud image with a
 * firewall enabled has that port shut. Nothing in the install output used to say
 * so, and the server still went green, because going green is what the call-home
 * does.
 *
 * The installer deliberately does not open the port itself: rewriting somebody's
 * firewall without being asked is not ours to do. So it is asked for instead, in
 * the two places the command is copied - here and the migration wizard - from one
 * constant, because the same sentence in two files is the same sentence until the
 * day it is not.
 *
 * It names no source address on purpose. The panel's hostname is not it (a panel
 * behind a CDN resolves to the CDN), and a WRONG source is worse than none: an
 * operator who opens the port to a CDN's ranges has locked themselves out with a
 * rule that looks right.
 *
 * ponytail: no source address, narrow the rule to one once the control plane can
 * report its own egress address.
 */
export const AGENT_PORT_NOTICE =
  "Deplo also has to reach the agent: if this machine has a firewall, open TCP 9443 on it.";
