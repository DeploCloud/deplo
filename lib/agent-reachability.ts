// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The one sentence about the direction nobody thinks about, said only when it has
 * already gone wrong.
 *
 * Installing the agent is OUTBOUND work: the host fetches a script and the agent
 * calls the control plane home, both over 443, both fine behind any firewall.
 * Everything Deplo does with that host afterwards is the opposite direction - the
 * control plane dialing the agent's own port - and a stock cloud image with a
 * firewall enabled has that port shut. Nothing used to say so, and the server
 * still went green, because going green is what the call-home does.
 *
 * It is NOT shown while a machine is still being waited on. A line every operator
 * reads on the first-run path to help the few whose port is closed is a tax on
 * everyone, and it buys nothing now that the failure is caught in eight seconds
 * and says what to do. So it rides the FAILURE, next to the agent's own message,
 * in both places one can appear: the migration wizard's install step and a
 * server's health chip.
 *
 * Kept conditional ("if this machine has a firewall") on purpose - `offline` is
 * also what a genuinely powered-off host looks like, and a hint that reads as a
 * diagnosis would send someone to edit firewall rules on a box that is simply not
 * running.
 *
 * The installer deliberately does not open the port itself: rewriting somebody's
 * firewall without being asked is not ours to do.
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
  "If this machine has a firewall, open TCP 9443 on it.";
