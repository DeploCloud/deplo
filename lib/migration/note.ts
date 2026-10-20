// A report line is information unless wrapped in blocker(): the app will not run until
// somebody does what it says. Information stays a plain string, so most call sites never change.
export interface Blocker {
  message: string;
  blocking: true;
}

export type Note = string | Blocker;

export function blocker(message: string): Blocker {
  return { message, blocking: true };
}

export function noteText(note: Note): string {
  return typeof note === "string" ? note : note.message;
}

export function isBlocking(note: Note): boolean {
  return typeof note !== "string" && note.blocking;
}
