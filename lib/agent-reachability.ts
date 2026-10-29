/** What to check when a server is offline, however Deplo reaches it (ADR-0040). */
export const LINK_OFFLINE_MESSAGE =
  "Check that the machine is on and connected to the internet.";

/** A server that can never connect: left behind at an update stop, or its server agent too old to (ADR-0041). */
export const AGENT_REINSTALL_MESSAGE =
  "This server can't be used until its server agent is reinstalled. " +
  "An instance admin can do it from the server's Advanced tab.";
