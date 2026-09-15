export const MIN_USER_PORT = 1024;
export const MAX_PORT = 65535;

export function isValidExposePort(port: number): boolean {
  return Number.isInteger(port) && port >= MIN_USER_PORT && port <= MAX_PORT;
}
