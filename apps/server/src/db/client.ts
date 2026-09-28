// Placeholder: Database client (Drizzle + better-sqlite3) is wired up in a
// later task. Defined as a type-only export so other modules compile while we
// scaffold the package.
export type Database = unknown;
export const db: Database = undefined as never;
