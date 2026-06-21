/**
 * Minimal ANSI → styled-segment parser for rendering raw terminal output
 * (e.g. a container's stdout/stderr from `docker attach`) in the browser.
 *
 * Handles SGR (Select Graphic Rendition, `ESC[…m`) color/style codes and
 * strips every other CSI/OSC/control sequence so cursor moves, clears and
 * title-sets don't render as literal `[2K`-style garbage. It is intentionally
 * NOT a terminal emulator — there is no grid, no cursor addressing, no
 * scrollback rewrite. Output is append-only text, which is what a log/attach
 * pane wants.
 */

export interface AnsiSegment {
  text: string;
  /** Tailwind/utility classes for this run, or "" for default styling. */
  className: string;
}

// Standard 16-color palette mapped to Tailwind text utilities. We map both the
// normal (30–37) and bright (90–97) ranges; bright maps to the lighter shade.
const FG: Record<number, string> = {
  30: "text-zinc-500", // black → readable on a dark bg
  31: "text-red-400",
  32: "text-green-400",
  33: "text-yellow-400",
  34: "text-blue-400",
  35: "text-fuchsia-400",
  36: "text-cyan-400",
  37: "text-zinc-300", // white/default-ish
  90: "text-zinc-500",
  91: "text-red-300",
  92: "text-green-300",
  93: "text-yellow-300",
  94: "text-blue-300",
  95: "text-fuchsia-300",
  96: "text-cyan-300",
  97: "text-zinc-100",
};

interface SgrState {
  fg: string; // class or ""
  bold: boolean;
  dim: boolean;
  underline: boolean;
}

function emptyState(): SgrState {
  return { fg: "", bold: false, dim: false, underline: false };
}

function classOf(s: SgrState): string {
  const parts: string[] = [];
  if (s.fg) parts.push(s.fg);
  if (s.bold) parts.push("font-semibold");
  if (s.dim) parts.push("opacity-60");
  if (s.underline) parts.push("underline");
  return parts.join(" ");
}

/** Apply one SGR escape's numeric params to the running style state. */
function applySgr(state: SgrState, params: number[]): void {
  // A bare `ESC[m` is treated as reset (params = [0]).
  if (params.length === 0) params = [0];
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p === 0) {
      Object.assign(state, emptyState());
    } else if (p === 1) {
      state.bold = true;
    } else if (p === 2) {
      state.dim = true;
    } else if (p === 4) {
      state.underline = true;
    } else if (p === 22) {
      state.bold = false;
      state.dim = false;
    } else if (p === 24) {
      state.underline = false;
    } else if (p === 39) {
      state.fg = "";
    } else if (FG[p]) {
      state.fg = FG[p];
    } else if (p === 38) {
      // 256-color (38;5;n) or truecolor (38;2;r;g;b): consume the params and
      // fall back to a neutral bright color rather than rendering nothing.
      if (params[i + 1] === 5) {
        i += 2;
        state.fg = "text-zinc-200";
      } else if (params[i + 1] === 2) {
        i += 4;
        state.fg = "text-zinc-200";
      }
    }
    // Background colors (40–47/100–107/48) are intentionally ignored: full-width
    // backgrounds look wrong in a reflowing, non-grid pane.
  }
}

const CSI_OR_OSC = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const SGR = /^\x1b\[([0-9;]*)m$/;
// Stray single control chars to drop (keep \n and \t). Includes \r (\x0d):
// terminal apps emit it for in-place line rewrites we can't honor in an
// append-only pane, so dropping it avoids the cursor "snapping back" and
// overprinting that would look like a phantom blank gap.
const STRAY = /[\x00-\x08\x0b-\x1f\x7f]/g;

/**
 * Strip every ANSI/CSI/OSC escape and stray control char, returning the plain
 * visible text. Used where we need the *content* of a line (e.g. to classify a
 * container log line by keyword) rather than its styling. `\n`/`\t` are kept.
 */
export function stripAnsi(input: string): string {
  return input.replace(CSI_OR_OSC, "").replace(STRAY, "");
}

/**
 * Parse a raw terminal string into styled segments. Stateless across calls:
 * pass the full accumulated buffer (styles don't carry between invocations),
 * which is how the attach pane uses it.
 */
export function parseAnsi(input: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  const state = emptyState();
  let last = 0;
  let cls = classOf(state);

  const push = (text: string) => {
    if (!text) return;
    const clean = text.replace(STRAY, "");
    if (!clean) return;
    // Coalesce adjacent runs that share a class to keep the DOM small.
    const prev = segments[segments.length - 1];
    if (prev && prev.className === cls) prev.text += clean;
    else segments.push({ text: clean, className: cls });
  };

  CSI_OR_OSC.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CSI_OR_OSC.exec(input)) !== null) {
    push(input.slice(last, m.index));
    last = m.index + m[0].length;
    const sgr = SGR.exec(m[0]);
    if (sgr) {
      const params = sgr[1]
        ? sgr[1].split(";").map((n) => (n === "" ? 0 : Number(n)))
        : [];
      applySgr(state, params);
      cls = classOf(state);
    }
    // Non-SGR CSI/OSC (cursor, clear, title): swallowed — no output.
  }
  push(input.slice(last));
  return segments;
}
