/**
 * The Deplo installer is a static, version-controlled shell script at the repo
 * root (`install.sh`), served straight from GitHub so users can run: curl -fsSL
 * https://raw.githubusercontent.com/DeploCloud/deplo/main/install.sh | bash Edit
 */

/** Canonical location of the installer on GitHub (raw, default branch). */
export const RAW_INSTALL_URL =
  "https://raw.githubusercontent.com/DeploCloud/deplo/main/install.sh";

/** Copy-paste one-liner shown in the dashboard. */
export function installOneLiner(): string {
  return `curl -fsSL ${RAW_INSTALL_URL} | bash`;
}
