// ConsoleControls - the mounted terminal's handles; text() is read at CLICK time, a snapshot prop would lag one command.
export interface ConsoleControls {
  clear: () => void;
  text: () => string;
}
