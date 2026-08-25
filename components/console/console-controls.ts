/**
 * What the console toolbar can do to whichever terminal is mounted below it.
 *
 * The pane owns Clear / Copy / Download, but only the terminal knows how to
 * clear itself (the exec REPL has a prompt to repaint, an attach stream does
 * not) and what is on screen. So each terminal hands these two up when it
 * mounts. `text()` is read at CLICK time on purpose: a buffer changes on every
 * keystroke, and a snapshot passed as a prop would always be one command behind.
 *
 * Type-only, in its own file, so `exec-terminal` and `container-attach` can name
 * it without importing the pane that renders them.
 */
export interface ConsoleControls {
  clear: () => void;
  text: () => string;
}
