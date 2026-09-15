export const RAW_INSTALL_URL =
  "https://raw.githubusercontent.com/DeploCloud/deplo/main/install.sh";

export const INSTALL_URL = "https://deplo.build/install.sh";

export function installOneLiner(): string {
  return `curl -fsSL ${INSTALL_URL} | bash`;
}
