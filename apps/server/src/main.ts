import { readServerConfigFromEnv } from "./config.ts";
import { startHttpServer } from "./http.ts";

async function main() {
  const server = await startHttpServer(readServerConfigFromEnv());
  let closing = false;

  const shutdown = async () => {
    if (closing) {
      return;
    }

    closing = true;
    await server.close();
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void shutdown().finally(() => {
        process.exit(0);
      });
    });
  }

  console.log(`Pi remote control server listening on ${server.origin}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(message);
  process.exit(1);
});
