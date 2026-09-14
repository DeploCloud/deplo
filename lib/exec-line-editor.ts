// LineEditorHost - the terminal surface the editor draws through.
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

export class LineEditor {
  private line = "";
  private caret = 0;
  private history: string[] = [];
  // -1 = editing the live draft; 0.. = browsing history entries.
  private histIdx = -1;
  // The in-progress line, parked while history is browsed.
  private draft = "";

  constructor(
    private host: LineEditorHost,
    private promptStr: string,
    // VISIBLE prompt width - SGR sequences are zero-width.
    private promptLen: number,
    // Fired with the raw line on Enter (non-blank lines only).
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
    // Writing up to an exact row boundary leaves xterm in "pending wrap" (cursor past the last column).
    if (end > 0 && end % w === 0) seq += " \r";
    const up = Math.floor(end / w) - Math.floor((this.promptLen + caret) / w);
    if (up > 0) seq += `\x1b[${up}A`;
    const col = (this.promptLen + caret) % w;
    seq += "\r" + (col > 0 ? `\x1b[${col}C` : "");
    this.line = next;
    this.caret = caret;
    this.host.write(seq);
  }

  // freshPrompt - the cursor must be at column 0 of a clean line.
  freshPrompt(): void {
    this.repaint("", 0, true);
  }

  // insertAbove - slot a system line above the live prompt, then repaint with the caret where it was.
  insertAbove(text: string): void {
    const w = Math.max(1, this.host.cols());
    const fromRow = Math.floor((this.promptLen + this.caret) / w);
    this.host.write(
      (fromRow > 0 ? `\x1b[${fromRow}A` : "") + "\r\x1b[J" + text + "\r\n",
    );
    this.repaint(this.line, this.caret, true);
  }

  // resetSession - forget line, caret and history (the "New session" button).
  resetSession(): void {
    this.line = "";
    this.caret = 0;
    this.history = [];
    this.histIdx = -1;
    this.draft = "";
  }

  // data - feed one xterm `onData` chunk (a keystroke or a paste) into the editor.
  data(d: string): void {
    const l = this.line;
    const c = this.caret;

    switch (d) {
      case "\r": {
        const cmd = l;
        // Land on a fresh row below the (possibly wrapped) input, so output never overprints the edit region.
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
        this.onSubmit(cmd);
        return;
      }

      case "\x7f": // Backspace - delete left of the caret
        if (c > 0) this.repaint(l.slice(0, c - 1) + l.slice(c), c - 1);
        return;
      case "\x1b[3~": // Delete - delete under the caret
        if (c < l.length) this.repaint(l.slice(0, c) + l.slice(c + 1), c);
        return;

      case "\x1b[D": // ←
      case "\x1bOD":
        if (c > 0) this.repaint(l, c - 1);
        return;
      case "\x1b[C": // →
      case "\x1bOC":
        if (c < l.length) this.repaint(l, c + 1);
        return;
      case "\x1b[H": // Home (+ Ctrl-A)
      case "\x1bOH":
      case "\x1b[1~":
      case "\x01":
        if (c > 0) this.repaint(l, 0);
        return;
      case "\x1b[F": // End (+ Ctrl-E)
      case "\x1bOF":
      case "\x1b[4~":
      case "\x05":
        if (c < l.length) this.repaint(l, l.length);
        return;
      case "\x1b[1;5D": // Ctrl-← / Alt-b - previous word
      case "\x1bb":
        if (c > 0) this.repaint(l, prevWord(l, c));
        return;
      case "\x1b[1;5C": // Ctrl-→ / Alt-f - next word
      case "\x1bf":
        if (c < l.length) this.repaint(l, nextWord(l, c));
        return;

      case "\x15": // Ctrl-U - kill to start of line
        if (c > 0) this.repaint(l.slice(c), 0);
        return;
      case "\x0b": // Ctrl-K - kill to end of line
        if (c < l.length) this.repaint(l.slice(0, c), c);
        return;
      case "\x17": {
        // Ctrl-W - kill the word left of the caret
        if (c === 0) return;
        const start = prevWord(l, c);
        this.repaint(l.slice(0, start) + l.slice(c), start);
        return;
      }

      case "\x03": // Ctrl-C - abandon the current line
        this.repaint(l, l.length);
        this.host.write("^C\r\n");
        this.histIdx = -1;
        this.draft = "";
        this.freshPrompt();
        return;
      case "\x0c": // Ctrl-L - clear the screen, keep line + caret
        this.host.reset();
        this.repaint(l, c, true);
        return;

      case "\x1b[A": {
        // ↑ older - park the draft on first entry into history
        const next = Math.min(this.histIdx + 1, this.history.length - 1);
        if (next < 0 || next === this.histIdx) return;
        if (this.histIdx === -1) this.draft = l;
        this.histIdx = next;
        this.repaint(this.history[next], this.history[next].length);
        return;
      }
      case "\x1b[B": {
        // ↓ newer - past the newest returns to the parked draft
        if (this.histIdx < 0) return;
        this.histIdx -= 1;
        const value =
          this.histIdx === -1 ? this.draft : this.history[this.histIdx];
        this.repaint(value, value.length);
        return;
      }
    }

    // Escape sequences with no meaning in a one-line editor are swallowed so they cannot desync it.
    if (d.charCodeAt(0) === 0x1b) return;

    const printable = [...d]
      .filter((ch) => ch >= " " && ch !== "\x7f")
      .join("");
    if (!printable) return;
    this.repaint(l.slice(0, c) + printable + l.slice(c), c + printable.length);
  }
}
