import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { startHttpServer } from "../src/http.ts";

const servers: Array<Awaited<ReturnType<typeof startHttpServer>>> = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
});

test("http server serves static assets and the api over a real socket", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-remote-control-http-"));
  const webDistDir = join(workspaceRoot, "web-dist");

  mkdirSync(webDistDir, { recursive: true });
  writeFileSync(join(webDistDir, "index.html"), "<!doctype html><html><body>ok</body></html>");

  const server = await startHttpServer({
    workspace_parent_dir: workspaceRoot,
    database_path: join(workspaceRoot, ".data", "control-plane.sqlite"),
    web_dist_dir: webDistDir,
    http_host: "127.0.0.1",
    http_port: 0,
  });

  servers.push(server);

  const indexResponse = await fetch(`${server.origin}/`);
  const apiResponse = await fetch(`${server.origin}/api/repos`);
  const apiPayload = (await apiResponse.json()) as { repositories: unknown[] };

  expect(indexResponse.status).toBe(200);
  expect(await indexResponse.text()).toContain("<body>ok</body>");
  expect(apiResponse.status).toBe(200);
  expect(apiPayload.repositories).toEqual([]);
});

test("http server treats malformed encoded asset paths as missing instead of 500", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-remote-control-http-"));
  const webDistDir = join(workspaceRoot, "web-dist");

  mkdirSync(webDistDir, { recursive: true });
  writeFileSync(join(webDistDir, "index.html"), "<!doctype html><html><body>ok</body></html>");

  const server = await startHttpServer({
    workspace_parent_dir: workspaceRoot,
    database_path: join(workspaceRoot, ".data", "control-plane.sqlite"),
    web_dist_dir: webDistDir,
    http_host: "127.0.0.1",
    http_port: 0,
  });

  servers.push(server);

  const response = await fetch(`${server.origin}/%E0%A4%A`);

  expect(response.status).toBe(404);
});
