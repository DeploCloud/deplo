// What a rendered stack may say to a holder of only `view`, which is where "View full compose" is served.

export const MASKED = "••••••••";

// maskBasicAuthLabel - hide the htpasswd inside a Traefik `basicauth.users` label.
export function maskBasicAuthLabel(line: string): string | null {
  const KEY = "basicauth.users";
  const at = line.indexOf(KEY);
  if (at < 0) return null;
  const sep = /^\s*[=:]\s*/.exec(line.slice(at + KEY.length));
  if (!sep) return null;
  return `${line.slice(0, at)}${KEY}${sep[0]}${MASKED}`;
}

// redactComposeForDisplay - mask every `environment:` value plus the basic-auth label.
export function redactComposeForDisplay(yaml: string): string {
  let envIndent: number | null = null;
  let blockIndent: number | null = null;
  const out: string[] = [];
  for (const line of yaml.split("\n")) {
    // Asked FIRST and outside the environment tracking: the label lives under `labels:`, which the block walk below never enters.
    const basicAuth = maskBasicAuthLabel(line);
    if (basicAuth !== null) {
      out.push(basicAuth);
      continue;
    }
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;

    if (blockIndent !== null) {
      if (trimmed === "" || indent > blockIndent) continue;
      blockIndent = null;
    }

    if (envIndent !== null) {
      if (trimmed !== "" && indent <= envIndent) {
        envIndent = null;
      } else if (trimmed !== "") {
        // Masking only this header left the BODY in the clear - a PEM key, a `smtp_password`
        // inside GITLAB_OMNIBUS_CONFIG - so the masked key stands in and the body lines are dropped.
        const block = /^(\s+[^\s:]+:)\s*[|>][+-]?\d*\s*$/.exec(line);
        if (block) {
          blockIndent = indent;
          out.push(`${block[1]} ${JSON.stringify(MASKED)}`);
          continue;
        }
        const map = /^(\s+[^\s:]+:)\s+\S.*$/.exec(line);
        if (map) {
          out.push(`${map[1]} ${JSON.stringify(MASKED)}`);
          continue;
        }
        const list = /^(\s+-\s+)(["']?)([^=\s"']+)=.*$/.exec(line);
        if (list) {
          out.push(`${list[1]}${list[3]}=${MASKED}`);
          continue;
        }
        out.push(line);
        continue;
      }
    }
    if (envIndent === null && trimmed === "environment:") envIndent = indent;
    out.push(line);
  }
  return out.join("\n");
}
