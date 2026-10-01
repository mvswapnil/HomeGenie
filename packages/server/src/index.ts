/**
 * Server entry point: the parse worker, the reminder sender and the HTTP API in one process.
 *
 *   DATABASE_URL          Postgres connection (Supabase: the direct connection string, service role)
 *   SUPABASE_JWT_SECRET   or SUPABASE_JWKS_URL, to verify the app's sign-in tokens
 *   ANTHROPIC_API_KEY     for the parser; without it the rule-based parser is used
 *   PORT                  default 8787
 *   WORKER=0              run the API only
 */
import { serve } from "@hono/node-server";
import { AnthropicExtractor, HeuristicExtractor, withFallback, type Extractor } from "@homegenie/parser";
import { createPool } from "./db.js";
import { createApi } from "./api.js";
import { startWorker } from "./worker.js";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

async function main() {
  const connectionString = required("DATABASE_URL");
  const db = createPool(connectionString);

  const extractor: Extractor = process.env.ANTHROPIC_API_KEY
    ? withFallback(new AnthropicExtractor(), new HeuristicExtractor())
    : new HeuristicExtractor();
  console.log(`parser: ${extractor.name}`);

  const worker = process.env.WORKER === "0" ? null : await startWorker({ db, extractor, connectionString });

  const app = createApi(db, { jwtSecret: process.env.SUPABASE_JWT_SECRET, jwksUrl: process.env.SUPABASE_JWKS_URL });
  const port = Number(process.env.PORT ?? 8787);
  const server = serve({ fetch: app.fetch, port });
  console.log(`api: http://localhost:${port}`);

  const shutdown = async () => {
    console.log("shutting down");
    server.close();
    await worker?.stop();
    await db.end();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
