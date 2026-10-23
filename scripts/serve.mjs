#!/usr/bin/env node
// Serves the dashboard locally: `npm run serve`, then open http://localhost:8080
// Set HOST=0.0.0.0 to reach it from other devices on your network.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'site');
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const file = path.join(SITE, path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '') || 'index.html');
  const target = fs.existsSync(file) && fs.statSync(file).isDirectory() ? path.join(file, 'index.html') : file;
  if (!target.startsWith(SITE) || !fs.existsSync(target)) {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': `${TYPES[path.extname(target)] || 'application/octet-stream'}; charset=utf-8`, 'Cache-Control': 'no-cache' });
  fs.createReadStream(target).pipe(res);
}).listen(PORT, HOST, () => {
  console.log(`Port Tracker running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});
