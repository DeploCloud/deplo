// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a rendered stack may say to someone who only holds `view`, which is where
 * "View full compose" is served. Masks env values AND the basic-auth htpasswd
 * label, which rides a Traefik label and so escaped an env-only pass.
 */

export const MASKED = "••••••••";

/**
 * Hide the htpasswd line inside a Traefik `basicauth.users` label, wherever in the
 * file it sits.
 */
export function maskBasicAuthLabel(line: string): string | null {
  const KEY = "basicauth.users";
  const at = line.indexOf(KEY);
  if (at < 0) return null;
  // `...users=<htpasswd>` (list form) or `...users: <htpasswd>` (map form).
  const sep = /^\s*[=:]\s*/.exec(line.slice(at + KEY.length));
  if (!sep) return null;
  return `${line.slice(0, at)}${KEY}${sep[0]}${MASKED}`;
}

/**
 * Redact a rendered stack for display: every value under an `environment:` block,
 * plus the basic-auth label ({@link maskBasicAuthLabel}).
 */
export function redactComposeForDisplay(yaml: string): string {
  let envIndent: number | null = null;
  // Inside a BLOCK SCALAR (`KEY: |`), whose body is a value like any other and
  // sits on the lines that follow it. Holds the indent of the key that opened it
  // - every line indented further belongs to that value.
  let blockIndent: number | null = null;
  const out: string[] = [];
  for (const line of yaml.split("\n")) {
    // Asked FIRST and outside the environment tracking: the label lives under
    // `labels:`, which the block walk below never enters.
    const basicAuth = maskBasicAuthLabel(line);
    if (basicAuth !== null) {
      out.push(basicAuth);
      continue;
    }
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;

    // A block scalar's body: drop the line entirely (the masked key already
    // stands in for the whole value). Ends at the first line indented no deeper
    // than the key that opened it; blank lines inside it belong to it.
    if (blockIndent !== null) {
      if (trimmed === "" || indent > blockIndent) continue;
      blockIndent = null;
    }

    if (envIndent !== null) {
      if (trimmed !== "" && indent <= envIndent) {
        envIndent = null; // left the environment: block
      } else if (trimmed !== "") {
        // A multi-line value (`KEY: |`, `|-`, `>`, `>2`, `|+`) hides like any other, but
        // line-by-line masking covered only the header and left the BODY in the clear - a
        // PEM key, a `smtp_password` inside GitLab's `GITLAB_OMNIBUS_CONFIG` - and the
        const block = /^(\s+[^\s:]+:)\s*[|>][+-]?\d*\s*$/.exec(line);
        if (block) {
          blockIndent = indent;
          out.push(`${block[1]} ${JSON.stringify(MASKED)}`);
          continue;
        }
        // Map form (`KEY: value`) and list form (`- KEY=value`) both hide
        // the value; a bare `- KEY` pass-through has none to hide.
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
