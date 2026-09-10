'use strict';
/**
 * Static file server for web/, so the app can be opened the way a browser
 * expects rather than over file://.
 *
 *   node src/serve.js            → http://localhost:8099/           (the map)
 *   node src/serve.js --about    → http://localhost:8099/about.html
 *   node src/serve.js --public   → http://localhost:8099/ (the public/ deploy bundle)
 *   node src/serve.js --port 9000
 *
 * The one-liner this replaces sent every asset as application/octet-stream,
 * which meant stylesheets, scripts and photographs all silently failed to
 * apply once the page had local assets to load.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = process.argv.includes('--public')
  ? path.join(__dirname, '..', 'public')
  : path.join(__dirname, '..', 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.geojson': 'application/geo+json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

const argv = process.argv.slice(2);
const portFlag = argv.indexOf('--port');
const port = portFlag >= 0 ? Number(argv[portFlag + 1]) : 8099;
const landing = argv.includes('--about') ? '/about.html' : '/index.html';

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (rel === '/') rel = landing;

  // Refuse to serve anything outside the served directory.
  const full = path.normalize(path.join(ROOT_DIR, rel));
  if (!full.startsWith(ROOT_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('forbidden');
  }

  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(`not found: ${rel}`);
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

server.listen(port, () => {
  console.log(`serving ${path.relative(process.cwd(), ROOT_DIR)} at http://localhost:${port}${landing}`);
  if (ROOT_DIR.endsWith(`${path.sep}public`)) {
    console.log('This is the public/ deploy bundle — what Cloudflare Pages would serve.');
  }
});

module.exports = { MIME };
