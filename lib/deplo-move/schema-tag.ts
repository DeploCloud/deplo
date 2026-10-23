import journal from "../db/migrations/meta/_journal.json";

// The last migration this build ships: a row copy needs both Deplos on the same one.
export function schemaTag(): string {
  return journal.entries.at(-1)?.tag ?? "";
}
