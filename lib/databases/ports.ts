// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The host-port rules, shared by the data layer and the exposure UI. Client-safe
 * on purpose: the Save button must enable on exactly the ports the server accepts.
 */

// A user-supplied port must be a real, unprivileged TCP port. Privileged ports
// (<1024) are rejected: the DB container runs unprivileged and binding them on
// the host is both a footgun and a collision magnet.
export const MIN_USER_PORT = 1024;
export const MAX_PORT = 65535;

/** Whether a host port is a valid, unprivileged TCP port a user may request. */
export function isValidExposePort(port: number): boolean {
  return Number.isInteger(port) && port >= MIN_USER_PORT && port <= MAX_PORT;
}
