/** A live stream to a container on its server: logs, a console, an attach. Every one comes from the server agent. */
export interface AttachHandle {
  onData(cb: (chunk: Buffer) => void): () => void;
  onExit(cb: (error?: string) => void): void;
  write(data: string): void;
  resize?(cols: number, rows: number): void;
  close(): void;
}
