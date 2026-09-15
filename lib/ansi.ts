export interface AnsiSegment {
  text: string;
  className: string;
}

const FG: Record<number, string> = {
  30: "text-zinc-500",
  31: "text-red-400",
  32: "text-green-400",
  33: "text-yellow-400",
  34: "text-blue-400",
  35: "text-fuchsia-400",
  36: "text-cyan-400",
  37: "text-zinc-300",
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
  fg: string;
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

function applySgr(state: SgrState, params: number[]): void {
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
      if (params[i + 1] === 5) {
        i += 2;
        state.fg = "text-zinc-200";
      } else if (params[i + 1] === 2) {
        i += 4;
        state.fg = "text-zinc-200";
      }
    }
  }
}

const CSI_OR_OSC = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const SGR = /^\x1b\[([0-9;]*)m$/;
const STRAY = /[\x00-\x08\x0b-\x1f\x7f]/g;

export function stripAnsi(input: string): string {
  return input.replace(CSI_OR_OSC, "").replace(STRAY, "");
}

export function parseAnsi(input: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  const state = emptyState();
  let last = 0;
  let cls = classOf(state);

  const push = (text: string) => {
    if (!text) return;
    const clean = text.replace(STRAY, "");
    if (!clean) return;
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
  }
  push(input.slice(last));
  return segments;
}
