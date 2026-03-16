import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, resolve as resolvePath, sep } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { ServerConfig } from "./config.ts";
import { defaultServerConfig } from "./config.ts";
import { createServerApp } from "./app.ts";

export interface RunningHttpServer {
  origin: string;
  config: ServerConfig;
  close(): Promise<void>;
}

export async function startHttpServer(
  overrides: Partial<ServerConfig> = {},
): Promise<RunningHttpServer> {
  const config: ServerConfig = {
    ...defaultServerConfig,
    ...overrides,
  };
  const app = createServerApp(config);
  const server = createServer(async (incoming, outgoing) => {
    try {
      const request = toWebRequest(incoming, config);
      const response =
        (request.method === "GET" || request.method === "HEAD") &&
        !new URL(request.url).pathname.startsWith("/api")
          ? createStaticResponse(request, config)
          : null;

      await writeNodeResponse(outgoing, response ?? (await app.handleRequest(request)));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected server error.";
      await writeNodeResponse(
        outgoing,
        new Response(JSON.stringify({ error: message }, null, 2), {
          status: 500,
          headers: { "content-type": "application/json; charset=utf-8" },
        }),
      );
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.http_port, config.http_host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Server failed to bind a TCP address.");
  }

  const hostname = address.address.includes(":") ? `[${address.address}]` : address.address;

  return {
    origin: `http://${hostname}:${address.port}`,
    config: {
      ...config,
      http_host: address.address,
      http_port: address.port,
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
      app.close();
    },
  };
}

function toWebRequest(incoming: IncomingMessage, config: ServerConfig) {
  const host = incoming.headers.host ?? `${config.http_host}:${config.http_port}`;
  const url = new URL(incoming.url ?? "/", `http://${host}`);

  return new Request(url, {
    method: incoming.method ?? "GET",
    headers: normalizeHeaders(incoming.headers),
    body: hasRequestBody(incoming.method)
      ? (Readable.toWeb(incoming) as unknown as RequestInit["body"])
      : undefined,
    duplex: "half",
  });
}

function createStaticResponse(request: Request, config: ServerConfig) {
  const webRoot = resolveConfiguredWebRoot(config.web_dist_dir);
  const assetPath = resolveStaticAssetPath(webRoot, new URL(request.url).pathname);

  if (!assetPath) {
    return new Response("Not found.", { status: 404 });
  }

  return new Response(readFileSync(assetPath), {
    status: 200,
    headers: {
      "content-type": contentTypeFor(assetPath),
      "cache-control": assetPath.endsWith("index.html") ? "no-cache" : "public, max-age=300",
    },
  });
}

function resolveStaticAssetPath(webRoot: string, pathname: string) {
  const indexPath = resolvePath(webRoot, "index.html");

  if (!existsSync(indexPath)) {
    return null;
  }

  let decodedPath: string;

  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.slice(1);
  const candidatePath = resolvePath(webRoot, relativePath);

  if (
    isPathInsideRoot(webRoot, candidatePath) &&
    existsSync(candidatePath) &&
    statSync(candidatePath).isFile()
  ) {
    return candidatePath;
  }

  return extname(decodedPath) ? null : indexPath;
}

function resolveConfiguredWebRoot(configuredPath: string) {
  if (isAbsolute(configuredPath)) {
    return configuredPath;
  }

  const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));

  return resolvePath(workspaceRoot, configuredPath);
}

async function writeNodeResponse(outgoing: ServerResponse, response: Response) {
  outgoing.statusCode = response.status;

  for (const [name, value] of response.headers) {
    outgoing.setHeader(name, value);
  }

  if (!response.body) {
    outgoing.end();
    return;
  }

  const body = Buffer.from(await response.arrayBuffer());
  outgoing.end(body);
}

function normalizeHeaders(headers: IncomingMessage["headers"]) {
  const normalized: Record<string, string> = {};

  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      normalized[name] = value.join(", ");
      continue;
    }

    if (typeof value === "string") {
      normalized[name] = value;
    }
  }

  return normalized;
}

function hasRequestBody(method: string | undefined) {
  return method !== undefined && method !== "GET" && method !== "HEAD";
}

function isPathInsideRoot(rootPath: string, candidatePath: string) {
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}${sep}`);
}

function contentTypeFor(filePath: string) {
  switch (extname(filePath)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    default:
      return "text/plain; charset=utf-8";
  }
}
