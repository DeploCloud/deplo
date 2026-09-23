export interface ParseState<L> {
  text: string;
  parsedTo: number;
  lines: L[];
  // Whole lines at the front of `text` that `lines` no longer holds (past `maxLines`).
  skipped: number;
}

export function emptyParse<L>(): ParseState<L> {
  return { text: "", parsedTo: 0, lines: [], skipped: 0 };
}

// Parses only what `text` added since `prev`. `dropped` is how many characters were cut
// off the front; a cut that is not at a line boundary, or any other rewrite, re-parses.
export function advanceParse<L>(
  prev: ParseState<L>,
  text: string,
  dropped: number,
  classify: (raw: string, prevLine: L | undefined) => L,
  maxLines: number,
): ParseState<L> {
  if (!text) return emptyParse();
  let acc: L[];
  let from: number;
  let skipped: number;
  if (
    prev.text !== "" &&
    dropped <= prev.parsedTo &&
    (dropped === 0 || prev.text[dropped - 1] === "\n") &&
    text.startsWith(prev.text.slice(dropped))
  ) {
    let cut = 0;
    for (let i = prev.text.indexOf("\n"); i !== -1 && i < dropped;) {
      cut++;
      i = prev.text.indexOf("\n", i + 1);
    }
    skipped = prev.skipped - cut;
    acc = prev.lines;
    if (skipped < 0) {
      acc.splice(0, -skipped);
      skipped = 0;
    }
    from = prev.parsedTo - dropped;
  } else {
    acc = [];
    from = 0;
    skipped = 0;
  }
  const lastNl = text.lastIndexOf("\n");
  if (lastNl >= from) {
    for (const line of text.slice(from, lastNl).split("\n")) {
      acc.push(classify(line, acc[acc.length - 1]));
    }
    from = lastNl + 1;
  }
  if (acc.length > maxLines) {
    skipped += acc.length - maxLines;
    acc.splice(0, acc.length - maxLines);
  }
  return { text, parsedTo: from, lines: acc, skipped };
}

// Trims the front of `text` to at most `max` characters, at a line boundary.
export function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  const tail = text.slice(-max);
  const nl = tail.indexOf("\n");
  return nl === -1 ? tail : tail.slice(nl + 1);
}
