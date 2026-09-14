// Client-safe on purpose: the exposure UI must enable Save on exactly the ports the server accepts.
// Privileged ports (<1024) are rejected: the DB container runs unprivileged and cannot bind them on the host.
export const MIN_USER_PORT = 1024;
export const MAX_PORT = 65535;

// isValidExposePort - whether a host port is a valid, unprivileged TCP port a user may request.
export function isValidExposePort(port: number): boolean {
  return Number.isInteger(port) && port >= MIN_USER_PORT && port <= MAX_PORT;
}
