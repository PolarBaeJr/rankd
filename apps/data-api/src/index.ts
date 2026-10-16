import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { ConfigError, loadConfig, type Config } from './config.js';
import { createHandler } from './server.js';
import { createUpstream } from './upstream.js';

function configOrExit(): Config {
  try {
    return loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(JSON.stringify({ level: 'fatal', msg: err.message }) + '\n');
      process.exit(1);
    }
    throw err;
  }
}

function main(): void {
  const config = configOrExit();

  // package.json sits beside dist/ in the image and beside src/ in the repo.
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  };

  const upstream = createUpstream({
    supabaseUrl: config.supabaseUrl,
    anonKey: config.anonKey,
    dbJwt: config.dbJwt,
    fetch: (input, init) => fetch(input, init),
    concurrency: config.upstreamConcurrency,
  });
  const handler = createHandler({ upstream, version });
  const server = createServer((req, res) => {
    void handler(req, res);
  });

  server.listen(config.port, '0.0.0.0', () => {
    process.stdout.write(JSON.stringify({ level: 'info', msg: 'listening', port: config.port, version }) + '\n');
  });

  const shutdown = (signal: string) => {
    process.stdout.write(JSON.stringify({ level: 'info', msg: 'shutting_down', signal }) + '\n');
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
