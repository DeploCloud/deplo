import type { CoolifyApplication } from "../client";

export const APP: CoolifyApplication = {
  uuid: "app-1",
  name: "web",
  build_pack: "nixpacks",
  git_repository: "https://github.com/acme/web",
  git_branch: "main",
  ports_exposes: "3000,3001",
  fqdn: "https://web.acme.com",
  limits_memory: "512M",
  limits_cpus: "0.5",
  watch_paths: "apps/web\n\npackages/ui",
  start_command: "node server.js",
};
