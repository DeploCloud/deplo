// https://deplo.build/docs/operations/upgrade

// RAW_INSTALL_URL - canonical location of the installer on GitHub (raw, default branch).
export const RAW_INSTALL_URL =
  "https://raw.githubusercontent.com/DeploCloud/deplo/main/install.sh";

// INSTALL_URL - the short address the manual gives out, and the one the panel shows.
export const INSTALL_URL = "https://deplo.build/install.sh";

// installOneLiner - copy-paste one-liner shown in the dashboard, install and update alike.
export function installOneLiner(): string {
  return `curl -fsSL ${INSTALL_URL} | bash`;
}
