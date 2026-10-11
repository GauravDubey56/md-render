#!/usr/bin/env node
// Zero-dependency server: scans a root folder recursively for .md files on
// start and serves a browser viewer for them.
//
//   npx md-render [rootDir] [--port 4321] [--host 127.0.0.1] [--no-open]
//   PORT=4321 MD_ROOT=/some/dir md-render

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');

const HELP = `Usage: md-render [rootDir] [options]

Serves every .md / .markdown / .mdx file under rootDir (default: current
directory) in a browser viewer with live reload.

Options:
  -p, --port <n>    Port to listen on (default 4321, or $PORT; next free port if taken)
  -H, --host <h>    Interface to bind (default 127.0.0.1; use 0.0.0.0 to share on your network)
      --no-open     Don't open the browser
  -v, --version     Print version
  -h, --help        Show this help
`;

function parseArgs(argv) {
  const opts = { root: null, port: null, host: null, open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.startsWith('--') && a.includes('=') ? a.split(/=(.*)/s) : [a, undefined];
    const value = () => (inline !== undefined ? inline : argv[++i]);
    switch (flag) {
      case '-h': case '--help': process.stdout.write(HELP); process.exit(0);
      case '-v': case '--version': console.log(require('./package.json').version); process.exit(0);
      case '-p': case '--port': opts.port = value(); break;
      case '-H': case '--host': opts.host = value(); break;
      case '--no-open': opts.open = false; break;
      default:
        if (flag.startsWith('-')) { console.error(`Unknown option: ${flag}\n\n${HELP}`); process.exit(1); }
        opts.root = flag;
    }
  }
  return opts;
}

const args = parseArgs(process.argv.slice(2));
const ROOT = path.resolve(args.root || process.env.MD_ROOT || process.cwd());
const PORT = Number(args.port || process.env.PORT) || 4321;
const PORT_EXPLICIT = Boolean(args.port || process.env.PORT);
const HOST = args.host || process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!fs.existsSync(ROOT) || !fs.statSync(ROOT).isDirectory()) {
  console.error(`Not a directory: ${ROOT}`);
  process.exit(1);
}

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.turbo', '.cache', '.parcel-cache', 'vendor', '.venv',
  'venv', '__pycache__', '.terraform', '.idea', '.vscode',
]);
const MD_EXT = /\.(md|markdown|mdx)$/i;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.mdx': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
};

let files = [];
let lastScan = null;

async function scan() {
  const started = Date.now();
  const found = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir
    }
    await Promise.all(entries.map(async (e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) await walk(full);
      } else if (e.isFile() && MD_EXT.test(e.name)) {
        try {
          const st = await fsp.stat(full);
          found.push({ p: toRel(full), size: st.size, mtime: st.mtimeMs });
        } catch { /* vanished mid-scan */ }
      }
    }));
  }
  await walk(ROOT);
  found.sort((a, b) => a.p.localeCompare(b.p));
  files = found;
  lastScan = Date.now();
  console.log(`Scanned ${ROOT}: ${files.length} markdown files in ${Date.now() - started}ms`);
}

const toRel = (full) => path.relative(ROOT, full).split(path.sep).join('/');

// Resolve a root-relative path, refusing anything that escapes ROOT.
function safeResolve(rel) {
  const full = path.resolve(ROOT, decodeURIComponent(rel).replace(/^\/+/, ''));
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) return null;
  return full;
}

function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}

function sendFile(res, full) {
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(full).pipe(res);
  });
}

// --- live reload via Server-Sent Events -----------------------------------
const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

function startWatcher() {
  let rescanTimer = null;
  try {
    fs.watch(ROOT, { recursive: true }, (_type, filename) => {
      if (!filename || !MD_EXT.test(filename)) return;
      const parts = filename.split(path.sep);
      if (parts.some((p) => IGNORED_DIRS.has(p))) return;
      const rel = parts.join('/');
      broadcast('changed', { p: rel });
      clearTimeout(rescanTimer);
      rescanTimer = setTimeout(async () => {
        const before = files.length;
        await scan();
        if (files.length !== before) broadcast('tree', { count: files.length });
      }, 800);
    });
  } catch (e) {
    console.warn('File watching unavailable, live reload disabled:', e.message);
  }
}

// --- routes ---------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  if (pathname === '/api/files') {
    return send(res, 200, JSON.stringify({ root: ROOT, rootName: path.basename(ROOT), lastScan, files }),
      MIME['.json']);
  }

  if (pathname === '/api/rescan' && req.method === 'POST') {
    await scan();
    return send(res, 200, JSON.stringify({ count: files.length }), MIME['.json']);
  }

  if (pathname === '/api/file') {
    const full = safeResolve(url.searchParams.get('p') || '');
    if (!full || !MD_EXT.test(full)) return send(res, 400, 'Bad path');
    return sendFile(res, full);
  }

  if (pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // Files referenced from markdown (images, PDFs, ...), relative to ROOT.
  if (pathname.startsWith('/raw/')) {
    const full = safeResolve(pathname.slice('/raw/'.length));
    if (!full) return send(res, 400, 'Bad path');
    return sendFile(res, full);
  }

  // Static assets; everything else (including /view/...) gets the SPA shell.
  if (pathname !== '/' && !pathname.startsWith('/view/')) {
    const full = path.join(PUBLIC_DIR, path.normalize(pathname));
    if (full.startsWith(PUBLIC_DIR + path.sep) && fs.existsSync(full)) return sendFile(res, full);
  }
  return sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
});

function openBrowser(url) {
  const [cmd, cmdArgs] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  execFile(cmd, cmdArgs, () => { /* best effort */ });
}

// Probe the wildcard address too: on macOS a specific-host bind succeeds even
// when another process already holds the port on all interfaces.
function portFree(port) {
  return new Promise((resolve) => {
    const probe = http.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, () => probe.close(() => resolve(true)));
  });
}

// Listen on PORT; if it's taken and wasn't asked for explicitly, try the next few.
async function listen(port, attemptsLeft = 20) {
  if (!(await portFree(port))) {
    if (!PORT_EXPLICIT && attemptsLeft > 0) return listen(port + 1, attemptsLeft - 1);
    console.error(`Port ${port} is already in use. Try --port <n>.`);
    process.exit(1);
  }
  server.once('error', (err) => {
    console.error(err.code === 'EADDRINUSE' ? `Port ${port} is already in use. Try --port <n>.` : err.message);
    process.exit(1);
  });
  server.listen(port, HOST, () => {
    const shownHost = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST;
    const url = `http://${shownHost}:${port}`;
    console.log(`Markdown viewer running at ${url}  (Ctrl+C to stop)`);
    if (args.open) openBrowser(url);
  });
}

scan().then(() => {
  startWatcher();
  listen(PORT);
});
