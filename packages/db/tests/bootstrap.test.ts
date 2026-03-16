import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { initialMigration } from "../src/index.ts";
import { bootstrapControlPlaneDatabase } from "../src/runtime.ts";

test("database bootstrap applies the initial schema and enables foreign keys", () => {
  const databasePath = join(mkdtempSync(join(tmpdir(), "pi-remote-control-db-")), "app.sqlite");
  const database = bootstrapControlPlaneDatabase({ databasePath });

  const foreignKeys = database.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
  const tables = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('repositories', 'repository_policies') ORDER BY name ASC",
    )
    .all() as Array<{ name: string }>;

  expect(initialMigration.id).toBe("0001_initial_schema");
  expect(foreignKeys.foreign_keys).toBe(1);
  expect(tables.map((table) => table.name)).toEqual(["repositories", "repository_policies"]);

  database.close();
});
