import "server-only";

import { read } from "../store";
import { assertUser } from "../auth";
import { decryptSecret } from "../crypto";
import type { Project } from "../types";

/**
 * Container console ("docker attach"). In a real deployment this would proxy an
 * exec session to the project's running container over the Docker socket. Here it
 * resolves the container metadata and answers a useful subset of shell commands
 * so the experience is faithful without a live daemon. Secret env values are
 * never revealed, mirroring how a hardened attach session should behave.
 */

export interface AttachInfo {
  containerName: string;
  image: string;
  running: boolean;
  cwd: string;
  user: string;
  shell: string;
}

function isRunning(p: Project): boolean {
  return p.status === "active";
}

export function containerName(p: Project): string {
  return `deplo-${p.slug}`;
}

function imageRef(p: Project): string {
  if (p.dockerImage) return p.dockerImage;
  if (p.source === "docker-image") return `${p.slug}:latest`;
  return `deplo/${p.slug}:latest`;
}

export async function getAttachInfo(projectId: string): Promise<AttachInfo | null> {
  await assertUser();
  const p = read().projects.find((x) => x.id === projectId);
  if (!p) return null;
  return {
    containerName: containerName(p),
    image: imageRef(p),
    running: isRunning(p),
    cwd: p.build.rootDirectory?.replace(/^\.\/?/, "/app/") || "/app",
    user: "deplo",
    shell: "/bin/sh",
  };
}

const HELP = [
  "Available commands (simulated container shell):",
  "  ls, pwd, whoami, id, env, ps, uptime, date",
  "  cat <file>, echo <text>, node -v, uname -a, df -h, free -m",
  "  clear        clear the screen",
  "  exit         detach from the container",
].join("\n");

export async function execInContainer(
  projectId: string,
  rawCommand: string
): Promise<{ output: string; detach?: boolean }> {
  await assertUser();
  const p = read().projects.find((x) => x.id === projectId);
  if (!p) return { output: "Error: project not found" };
  if (!isRunning(p))
    return { output: "Error: container is not running. Deploy the project first." };

  const command = rawCommand.trim();
  if (!command) return { output: "" };

  const [cmd, ...args] = command.split(/\s+/);
  const arg = args.join(" ");

  switch (cmd) {
    case "help":
    case "--help":
      return { output: HELP };
    case "exit":
    case "logout":
      return { output: "detached from container", detach: true };
    case "clear":
      return { output: "\f" }; // form-feed sentinel: client clears the screen
    case "pwd":
      return { output: "/app" };
    case "whoami":
      return { output: "deplo" };
    case "id":
      return { output: "uid=1001(deplo) gid=1001(nodejs) groups=1001(nodejs)" };
    case "hostname":
      return { output: containerName(p) };
    case "date":
      return { output: new Date().toUTCString() };
    case "uptime":
      return { output: " 14:22:31 up 3 days,  2:11,  0 users,  load average: 0.08, 0.03, 0.01" };
    case "uname":
      return { output: "Linux " + containerName(p) + " 6.1.0 #1 SMP x86_64 GNU/Linux" };
    case "node":
      return { output: args[0] === "-v" ? "v22.13.0" : "Usage: node [options] [script.js]" };
    case "bun":
      return { output: args[0] === "-v" ? "1.3.13" : "bun <command>" };
    case "df":
      return {
        output:
          "Filesystem      Size  Used Avail Use% Mounted on\noverlay         512G  198G  314G  39% /\ntmpfs            64M     0   64M   0% /dev",
      };
    case "free":
      return {
        output:
          "              total        used        free      shared  buff/cache   available\nMem:          16384        6720        4096         128        5568        9344\nSwap:          2048           0        2048",
      };
    case "ps": {
      return {
        output:
          "  PID  PPID  USER     COMMAND\n    1     0  deplo    " +
          (p.build.startCommand || "node server.js") +
          "\n   28     1  deplo    /bin/sh\n   34    28  deplo    ps " +
          arg,
      };
    }
    case "env":
    case "printenv": {
      const vars = read().envVars.filter((e) => e.projectId === p.id);
      const base = [
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "NODE_ENV=production",
        `PORT=${p.build.port}`,
        `HOSTNAME=${containerName(p)}`,
      ];
      const projectVars = vars.map((e) =>
        e.type === "secret"
          ? `${e.key}=********`
          : `${e.key}=${decryptSecret(e.valueEnc)}`
      );
      return { output: [...base, ...projectVars].join("\n") };
    }
    case "echo":
      return { output: arg };
    case "ls": {
      const files = lsFor(p);
      const long = args.some((a) => a.startsWith("-") && a.includes("l"));
      if (long) {
        return {
          output: files
            .map(
              (f) =>
                `${f.dir ? "drwxr-xr-x" : "-rw-r--r--"} 1 deplo nodejs ${String(
                  f.size
                ).padStart(6)} Jun 15 14:02 ${f.name}`
            )
            .join("\n"),
        };
      }
      return { output: files.map((f) => f.name).join("  ") };
    }
    case "cat": {
      if (!arg) return { output: "cat: missing operand" };
      return { output: catFile(p, arg) };
    }
    default:
      return { output: `${cmd}: command not found` };
  }
}

function lsFor(p: Project): { name: string; dir: boolean; size: number }[] {
  const common = [
    { name: "node_modules", dir: true, size: 4096 },
    { name: "package.json", dir: false, size: 842 },
    { name: "Dockerfile", dir: false, size: 410 },
  ];
  if (p.framework === "nextjs")
    return [
      { name: ".next", dir: true, size: 4096 },
      { name: "app", dir: true, size: 4096 },
      { name: "public", dir: true, size: 4096 },
      { name: "next.config.ts", dir: false, size: 318 },
      ...common,
    ];
  if (p.framework === "python")
    return [
      { name: "app", dir: true, size: 4096 },
      { name: "requirements.txt", dir: false, size: 196 },
      { name: "main.py", dir: false, size: 512 },
      { name: "Dockerfile", dir: false, size: 410 },
    ];
  return [
    { name: "dist", dir: true, size: 4096 },
    { name: "src", dir: true, size: 4096 },
    ...common,
  ];
}

function catFile(p: Project, file: string): string {
  const name = file.replace(/^\.\//, "");
  if (name === "package.json")
    return JSON.stringify(
      {
        name: p.slug,
        private: true,
        scripts: {
          build: p.build.buildCommand,
          start: p.build.startCommand || "node server.js",
        },
      },
      null,
      2
    );
  return `cat: ${file}: No such file or directory`;
}
