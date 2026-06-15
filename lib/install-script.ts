/**
 * The Deplo installer is a static, version-controlled shell script at the repo
 * root (`install.sh`), served straight from GitHub so users can run:
 *
 *   curl -fsSL https://raw.githubusercontent.com/IdraDev/deplo/main/install.sh | bash
 *
 * Edit `install.sh` directly to change install behaviour — it is the single
 * source of truth. The `/install` route is a short alias that redirects here.
 */

/** Canonical location of the installer on GitHub (raw, default branch). */
export const RAW_INSTALL_URL =
  "https://raw.githubusercontent.com/IdraDev/deplo/main/install.sh";

/** Copy-paste one-liner shown in the dashboard. */
export function installOneLiner(): string {
  return `curl -fsSL ${RAW_INSTALL_URL} | bash`;
}
