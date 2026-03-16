import { readFileSync } from "node:fs";
import { expect, test } from "vite-plus/test";
import { initialMigration, schemaTables } from "../src/index.ts";

test("initial migration creates each planned control-plane table", () => {
  const sql = readFileSync(
    new URL("../migrations/0001_initial_schema.sql", import.meta.url),
    "utf8",
  );

  expect(initialMigration.table_count).toBe(schemaTables.length);

  for (const table of schemaTables) {
    expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table.name}`);
  }
});
