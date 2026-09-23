export interface LineEditorHost {
  write(data: string): void;
  cols(): number;
  reset(): void;
}

function prevWord(line: string, caret: number): number {
  let i = caret;
  while (i > 0 && line[i - 1] === " ") i--;
  while (i > 0 && line[i - 1] !== " ") i--;
  return i;
}
function nextWord(line: string, caret: number): number {
  let i = caret;
  while (i < line.length && line[i] === " ") i++;
  while (i < line.length && line[i] !== " ") i++;
  return i;
}

export const MAX_HISTORY = 500;

export class LineEditor {
  private line = "";
  private caret = 0;
  private history: string[] = [];
  private histIdx = -1;
  private draft = "";

  constructor(
    private host: LineEditorHost,
    private promptStr: string,
    private promptLen: number,
    private onSubmit: (command: string) => void,
  ) {}

  private repaint(next: string, caret: number, fromScratch = false): void {
    const w = Math.max(1, this.host.cols());
    let seq = "";
    if (!fromScratch) {
      const fromRow = Math.floor((this.promptLen + this.caret) / w);
      if (fromRow > 0) seq += `\x1b[${fromRow}A`;
      seq += "\r\x1b[J";
    }
    seq += this.promptStr + next;
    const end = this.promptLen + next.length;
    if (end > 0 && end % w === 0) seq += " \r";
    const up = Math.floor(end / w) - Math.floor((this.promptLen + caret) / w);
    if (up > 0) seq += `\x1b[${up}A`;
    const col = (this.promptLen + caret) % w;
    seq += "\r" + (col > 0 ? `\x1b[${col}C` : "");
    this.line = next;
    this.caret = caret;
    this.host.write(seq);
  }

  freshPrompt(): void {
    this.repaint("", 0, true);
  }

  insertAbove(text: string): void {
    const w = Math.max(1, this.host.cols());
    const fromRow = Math.floor((this.promptLen + this.caret) / w);
    this.host.write(
      (fromRow > 0 ? `\x1b[${fromRow}A` : "") + "\r\x1b[J" + text + "\r\n",
    );
    this.repaint(this.line, this.caret, true);
  }

  resetSession(): void {
    this.line = "";
    this.caret = 0;
    this.history = [];
    this.histIdx = -1;
    this.draft = "";
  }

  data(d: string): void {
    const l = this.line;
    const c = this.caret;

    switch (d) {
      case "\r": {
        const cmd = l;
        this.repaint(cmd, cmd.length);
        this.host.write("\r\n");
        this.line = "";
        this.caret = 0;
        this.histIdx = -1;
        this.draft = "";
        if (!cmd.trim()) {
          this.freshPrompt();
          return;
        }
        this.history.unshift(cmd);
        if (this.history.length > MAX_HISTORY)
          this.history.length = MAX_HISTORY;
        this.onSubmit(cmd);
        return;
      }

      case "\x7f":
        if (c > 0) this.repaint(l.slice(0, c - 1) + l.slice(c), c - 1);
        return;
      case "\x1b[3~":
        if (c < l.length) this.repaint(l.slice(0, c) + l.slice(c + 1), c);
        return;

      case "\x1b[D":
      case "\x1bOD":
        if (c > 0) this.repaint(l, c - 1);
        return;
      case "\x1b[C":
      case "\x1bOC":
        if (c < l.length) this.repaint(l, c + 1);
        return;
      case "\x1b[H":
      case "\x1bOH":
      case "\x1b[1~":
      case "\x01":
        if (c > 0) this.repaint(l, 0);
        return;
      case "\x1b[F":
      case "\x1bOF":
      case "\x1b[4~":
      case "\x05":
        if (c < l.length) this.repaint(l, l.length);
        return;
      case "\x1b[1;5D":
      case "\x1bb":
        if (c > 0) this.repaint(l, prevWord(l, c));
        return;
      case "\x1b[1;5C":
      case "\x1bf":
        if (c < l.length) this.repaint(l, nextWord(l, c));
        return;

      case "\x15":
        if (c > 0) this.repaint(l.slice(c), 0);
        return;
      case "\x0b":
        if (c < l.length) this.repaint(l.slice(0, c), c);
        return;
      case "\x17": {
        if (c === 0) return;
        const start = prevWord(l, c);
        this.repaint(l.slice(0, start) + l.slice(c), start);
        return;
      }

      case "\x03":
        this.repaint(l, l.length);
        this.host.write("^C\r\n");
        this.histIdx = -1;
        this.draft = "";
        this.freshPrompt();
        return;
      case "\x0c":
        this.host.reset();
        this.repaint(l, c, true);
        return;

      case "\x1b[A": {
        const next = Math.min(this.histIdx + 1, this.history.length - 1);
        if (next < 0 || next === this.histIdx) return;
        if (this.histIdx === -1) this.draft = l;
        this.histIdx = next;
        this.repaint(this.history[next], this.history[next].length);
        return;
      }
      case "\x1b[B": {
        if (this.histIdx < 0) return;
        this.histIdx -= 1;
        const value =
          this.histIdx === -1 ? this.draft : this.history[this.histIdx];
        this.repaint(value, value.length);
        return;
      }
    }

    if (d.charCodeAt(0) === 0x1b) return;

    const printable = [...d]
      .filter((ch) => ch >= " " && ch !== "\x7f")
      .join("");
    if (!printable) return;
    this.repaint(l.slice(0, c) + printable + l.slice(c), c + printable.length);
  }
}
