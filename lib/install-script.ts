// https://deplo.build/docs/operations/upgrade

/**
 * The installer is a static shell script at the repo root (`install.sh`), and
 * re-running it on a machine that already has Deplo IS the update: it keeps the
 * secrets, dumps the database first, and rolls the image back if the new one fails.
 */

/** Canonical location of the installer on GitHub (raw, default branch). */
export const RAW_INSTALL_URL =
  "https://raw.githubusercontent.com/DeploCloud/deplo/main/install.sh";

/** The short address the manual gives out, and the one the panel shows. Same file. */
export const INSTALL_URL = "https://deplo.build/install.sh";

/** Copy-paste one-liner shown in the dashboard - install and update alike. */
export function installOneLiner(): string {
  return `curl -fsSL ${INSTALL_URL} | bash`;
}
