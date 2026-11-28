#!/usr/bin/env node

import { serve } from '@hono/node-server';

import app from './index';
import { streamSSE } from 'hono/streaming';
import { Context } from 'hono';
import { createNodeWebSocket } from '@hono/node-ws';
import { realTimeHandlerNode } from './handlers/realtimeHandlerNode';
import { requestValidator } from './middlewares/requestValidator';
import { addLogClient, removeLogClient, getCurrentTotals } from './middlewares/log/index';
import {
  setConfigPath,
  ensureConfigLoaded,
  closeConfigStore,
} from './configShared';
import { safeEqual, tryParseBearerToken } from './utils/auth';
import { isDemoMode } from './demo';
import { initUsageStore, closeUsageStore } from './storage/usageStore';

// Extract command line arguments
const args = process.argv.slice(2);

// Config path: --config wins, then CONFIG_PATH, then ./conf.json. Web
// deployments normally use PostgreSQL, where this path is only a seed source.
const configArg = args.find((arg) => arg.startsWith('--config='));
const configPath =
  configArg?.split('=')[1] || process.env.CONFIG_PATH || './conf.json';
setConfigPath(configPath);

// Port and headless mode
const defaultPort = 8700;
const portArg = args.find((arg) => arg.startsWith('--port='));
const isHeadless = args.includes('--headless');

// Effective port: --port wins, then PORT (Render/Railway/Fly inject this),
// then the config file, then 8700.
let effectivePort = defaultPort;
if (portArg) {
  effectivePort = parseInt(portArg.split('=')[1], 10);
} else if (process.env.PORT) {
  effectivePort = parseInt(process.env.PORT, 10);
} else {
  try {
    const { readFileSync } = await import('fs');
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed?.server?.port) {
      effectivePort = parsed.server.port;
    }
  } catch {}
}
if (!Number.isFinite(effectivePort) || effectivePort <= 0) {
  effectivePort = defaultPort;
}

const isQuiet =
  process.env.NODE_ENV === 'production' ||
  process.env.QUIET_LOG === 'true' ||
  args.includes('--quiet-log');

// Load config into cache. In PostgreSQL mode this also creates the schema.
try {
  await ensureConfigLoaded();
} catch (e: any) {
  console.error(
    '[config] Failed to load configuration at startup:',
    e?.message || e
  );
  // Keep listening: /admin/health stays up, /admin/ready reports the failure,
  // and the platform can surface the error instead of crash-looping.
}

try {
  await initUsageStore();
} catch (e: any) {
  console.error('[usage] Failed to initialise usage store:', e?.message || e);
}

// Detect if running as compiled bun binary (production) or in dev mode
const isBunBinary =
  import.meta.url.startsWith('file:///$bunfs/') ||
  (process.platform === 'win32' && process.execPath.endsWith('.exe'));

// When launched by the desktop app, watch the parent process and exit when it dies
const ppidArg = args.find((arg) => arg.startsWith('--ppid='));
const ppid = ppidArg ? parseInt(ppidArg.split('=')[1]) : 0;

// Setup static file serving only if not in headless mode
// if (!isHeadless) {
const setupStaticServing = async () => {
  const { join, dirname, extname, resolve } = await import('path');
  const { fileURLToPath } = await import('url');
  const { readFileSync, existsSync, statSync, realpathSync } = await import('fs');

  let publicDir: string;
  let scriptDir: string;

  if (isBunBinary) {
    // In compiled bun binary, look for public files alongside the binary
    // or in /usr/local/share/portkey-gateway/public/
    const binaryDir = dirname(process.execPath);
    const installedPublicDir = '/usr/local/share/portkey-gateway/public';
    publicDir = existsSync(join(installedPublicDir, 'index.html'))
      ? installedPublicDir
      : join(binaryDir, 'public');
    scriptDir = binaryDir;
  } else {
    scriptDir = dirname(fileURLToPath(import.meta.url));
    publicDir = join(scriptDir, 'public');
  }

  // Legacy log viewer. It predates the admin token and its EventSource cannot
  // send an Authorization header, so it is opt-in only. Web deployments set
  // ENABLE_LEGACY_LOGS=false and use the React admin instead.
  const legacyLogsEnabled =
    process.env.ENABLE_LEGACY_LOGS !== 'false' && process.env.WEB_UI !== 'true';
  if (!isBunBinary && legacyLogsEnabled) {
    const indexPath = join(publicDir, 'index.html');
    const indexContent = readFileSync(indexPath, 'utf-8');

    const serveIndex = (c: Context) => {
      c.header('Cache-Control', 'no-cache');
      return c.html(indexContent);
    };

    app.get('/public/logs', serveIndex);
    app.get('/public/', serveIndex);
  }

  // Serve admin UI static files (SPA)
  // In production (bundled), public files are alongside the binary at public/admin
  // In dev mode, public files are in scriptDir/public/admin
  const bundledAdminDir = join(scriptDir, 'public', 'admin');
  const devAdminDir = join(scriptDir, '..', 'build', 'public', 'admin');
  const adminDir = existsSync(join(bundledAdminDir, 'index.html'))
    ? bundledAdminDir
    : devAdminDir;
  const adminIndexPath = join(adminDir, 'index.html');

  const contentTypeByExt: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.map': 'application/json; charset=utf-8',
  };

  const serveAdminIndex = (c: Context) => {
    if (!existsSync(adminIndexPath)) {
      return c.text('Not Found', 404);
    }
    const html = readFileSync(adminIndexPath, 'utf-8');
    c.header('Cache-Control', 'no-cache');
    return c.html(html);
  };

  app.get('/public/admin', (c: Context) =>
    c.redirect('/public/admin/')
  );
  app.get('/public/admin/', serveAdminIndex);
  app.get('/public/admin/*', (c: Context) => {
    const url = new URL(c.req.url);
    const prefix = '/public/admin/';
    let rel = url.pathname.startsWith(prefix)
      ? url.pathname.slice(prefix.length)
      : '';

    try {
      rel = decodeURIComponent(rel);
    } catch {
      return c.text('Not Found', 404);
    }
    if (rel.includes('\0') || rel.split('/').includes('..')) {
      return c.text('Not Found', 404);
    }

    const resolvedAdminDir = resolve(adminDir);
    const filePath = resolve(join(adminDir, rel));
    if (
      filePath !== resolvedAdminDir &&
      !filePath.startsWith(resolvedAdminDir + (process.platform === 'win32' ? '\\' : '/'))
    ) {
      return c.text('Not Found', 404);
    }

    if (!existsSync(filePath)) {
      // SPA fallback: extension-less paths render the React shell so deep
      // links keep working. Missing hashed assets should stay 404.
      if (!extname(rel)) {
        return serveAdminIndex(c);
      }
      return c.text('Not Found', 404);
    }

    try {
      const st = statSync(filePath);
      if (!st.isFile()) return c.text('Not Found', 404);

      // Resolve symlinks and ensure the final target stays inside the admin
      // directory (prevents path traversal through a symlinked asset).
      const realFile = realpathSync(filePath);
      const realDir = realpathSync(adminDir);
      if (
        realFile !== realDir &&
        !realFile.startsWith(
          realDir + (process.platform === 'win32' ? '\\' : '/')
        )
      ) {
        return c.text('Not Found', 404);
      }
    } catch {
      return c.text('Not Found', 404);
    }

    const ext = extname(filePath).toLowerCase();
    const contentType = contentTypeByExt[ext] ?? 'application/octet-stream';
    const data = readFileSync(filePath);
    c.header('Content-Type', contentType);
    c.header(
      'Cache-Control',
      rel.startsWith('assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-cache'
    );
    return c.body(data as any);
  });

  // Redirect `/public` to the admin UI in web mode; keep the legacy viewer
  // path for desktop.
  app.get('/public', (c: Context) => {
    return c.redirect(
      process.env.WEB_UI === 'true' ? '/public/admin/' : '/public/'
    );
  });
};

// Initialize static file serving
await setupStaticServing();

/**
 * A helper function to enforce a timeout on SSE sends.
 * @param fn A function that returns a Promise (e.g. stream.writeSSE())
 * @param timeoutMs The timeout in milliseconds (default: 2000)
 */
async function sendWithTimeout(fn: () => Promise<void>, timeoutMs = 200) {
  const timeoutPromise = new Promise<void>((_, reject) => {
    const id = setTimeout(() => {
      clearTimeout(id);
      reject(new Error('Write timeout'));
    }, timeoutMs);
  });

  return Promise.race([fn(), timeoutPromise]);
}

app.get('/log/stream', async (c: Context) => {
  const clientId = Date.now().toString();
  const mode = c.req.query('type') === 'counts' ? 'counts' : 'log';

  // This stream can include full request/response logs, so it needs the same
  // protection as the admin API. The React UI uses fetch() so it can attach
  // the Authorization header (EventSource cannot).
  // Demo sessions share one process with every other visitor, so the global
  // log/usage stream must not be readable from a sandbox: it would leak other
  // visitors' prompts. Answer 403 and let the UI fall back to its empty state.
  if (isDemoMode()) {
    return c.json(
      {
        ok: false,
        code: 'demo_log_stream_disabled',
        message: '演示环境不提供全局日志流',
      },
      403
    );
  }

  const expectedToken = String(process.env.ADMIN_TOKEN || '').trim();
  if (expectedToken) {
    const provided =
      tryParseBearerToken(c.req.header('authorization')) ||
      c.req.header('x-admin-token') ||
      '';
    if (!(await safeEqual(provided, expectedToken))) {
      return c.json({ ok: false, message: 'Unauthorized' }, 401);
    }
  }

  const origin = c.req.header('origin');
  if (
    origin &&
    (origin.startsWith('http://localhost') ||
      origin.startsWith('http://127.0.0.1'))
  ) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Access-Control-Allow-Credentials', 'true');
  }

  // Set headers to prevent caching
  c.header('Cache-Control', 'no-cache');
  c.header('X-Accel-Buffering', 'no');

  return streamSSE(c, async (stream) => {
    const client = {
      mode: mode as 'log' | 'counts',
      sendLog: (message: any) =>
        sendWithTimeout(() => stream.writeSSE(message)),
    };
    // Add this client to the set of log clients
    addLogClient(clientId, client);

    // If the client disconnects (closes the tab, etc.), this signal will be aborted
    const onAbort = () => {
      removeLogClient(clientId);
    };
    c.req.raw.signal.addEventListener('abort', onAbort);

    try {
      // Send an initial connection event
      await sendWithTimeout(() =>
        stream.writeSSE({ event: 'connected', data: clientId })
      );

      // For counts-mode clients, push an initial snapshot so the UI
      // can display numbers immediately, without waiting for the next
      // /v1/* request to fire broadcastCounts().
      if (mode === 'counts') {
        const totals = getCurrentTotals();
        await sendWithTimeout(() =>
          stream.writeSSE({
            event: 'counts',
            data: JSON.stringify(totals),
          })
        );
      }

      // Use an interval instead of a while loop
      const heartbeatInterval = setInterval(async () => {
        if (c.req.raw.signal.aborted) {
          clearInterval(heartbeatInterval);
          return;
        }

        try {
          await sendWithTimeout(() =>
            stream.writeSSE({ event: 'heartbeat', data: 'pulse' })
          );
        } catch (error) {
          // console.error(`Heartbeat failed for client ${clientId}:`, error);
          clearInterval(heartbeatInterval);
          removeLogClient(clientId);
        }
      }, 10000);

      // Wait for abort signal
      await new Promise((resolve) => {
        c.req.raw.signal.addEventListener('abort', () => {
          clearInterval(heartbeatInterval);
          resolve(undefined);
        });
      });
    } catch (error) {
      // console.error(`Error in log stream for client ${clientId}:`, error);
    } finally {
      // Remove this client when the connection is closed
      removeLogClient(clientId);
      c.req.raw.signal.removeEventListener('abort', onAbort);
    }
  });
});
// }

const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

app.get(
  '/v1/realtime',
  requestValidator,
  upgradeWebSocket(realTimeHandlerNode)
);

const server = serve({
  fetch: app.fetch,
  port: effectivePort,
  hostname: '0.0.0.0',
});

// LLM streams can legitimately run for minutes. Node's default 5-minute
// request timeout would cut them off; platform proxies still apply their own
// limits, which are documented.
(server as any).requestTimeout = 0;

const url = `http://localhost:${effectivePort}`;

injectWebSocket(server);

// Shutdown endpoint for desktop app — kills the Neutralino parent process and exits
if (ppid > 0) {
  app.post('/shutdown', async (c) => {
    // Respond first, then kill — don't await the kill
    c.json({ ok: true });
    setTimeout(() => {
      try {
        process.kill(ppid, 'SIGTERM');
      } catch {}
      server.close();
      process.exit(0);
    }, 100);
  });
}

// When launched by the desktop app, watch the parent process and exit when it dies
if (ppid > 0) {
  setInterval(() => {
    try {
      process.kill(ppid, 0);
    } catch {
      server.close();
      process.exit(0);
    }
  }, 2000);
}

// Loading animation function
async function showLoadingAnimation() {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;

  return new Promise((resolve) => {
    const interval = setInterval(() => {
      process.stdout.write(`\r${frames[i]} Starting AI Gateway...`);
      i = (i + 1) % frames.length;
    }, 80);

    // Stop after 1 second
    setTimeout(() => {
      clearInterval(interval);
      process.stdout.write('\r');
      resolve(undefined);
    }, 1000);
  });
}

// Clear the console and show animation before main output (interactive dev
// only). Production logs stay append-only so Render/Fly can capture startup.
if (!isBunBinary && !isQuiet) {
  console.clear();
  await showLoadingAnimation();

  // Main server information with minimal spacing
  console.log('\x1b[1m%s\x1b[0m', '🚀 Your AI Gateway is running at:');
  console.log('   ' + '\x1b[1;4;32m%s\x1b[0m', `${url}`);

  // Secondary information on single lines
  if (!isHeadless) {
    console.log('\n\x1b[90m📱 UI:\x1b[0m \x1b[36m%s\x1b[0m', `${url}/public/admin/`);

    // Open browser to UI (cross-platform)
    if (process.platform === 'win32') {
      import('child_process').then(({ exec }) => {
        exec(`start ${url}/public/admin/`);
      });
    } else {
      import('child_process').then(({ exec }) => {
        exec(`open ${url}/public/admin/`);
      });
    }
  }

  // Single-line ready message
  console.log('\n\x1b[32m✨ Ready for connections!\x1b[0m');
} else {
  console.log(
    `[startup] gateway listening on 0.0.0.0:${effectivePort} (storage=${process.env.CONFIG_STORE || 'auto'})`
  );
}

process.on('uncaughtException', (err) => {
  console.error('Unhandled exception', err);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection', err);
});

// Graceful shutdown: stop accepting connections, close the database pool,
// then exit. A hard timeout prevents a stuck connection from blocking a
// platform redeploy forever.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] received ${signal}`);
  const hardStop = setTimeout(() => process.exit(1), 10_000);
  try {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeUsageStore();
    await closeConfigStore();
    clearTimeout(hardStop);
    process.exit(0);
  } catch (e) {
    clearTimeout(hardStop);
    console.error('[shutdown] error while closing:', e);
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
