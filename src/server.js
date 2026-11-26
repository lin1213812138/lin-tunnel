'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const WEB_DIR = path.join(__dirname, '..', 'web');
const MAX_BODY = 64 * 1024;

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function createServer(manager) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const { pathname } = url;

    try {
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        const html = fs.readFileSync(path.join(WEB_DIR, 'index.html'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(html);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/state') {
        sendJson(res, 200, { ok: true, tunnels: manager.state(), now: Date.now() });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/tunnels') {
        const body = await readBody(req);
        const port = Number(body.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          sendJson(res, 400, { ok: false, error: '端口必须是 1-65535 的整数' });
          return;
        }
        const tunnel = await manager.start({ name: body.name, port });
        sendJson(res, 200, { ok: true, tunnel });
        return;
      }

      const logsMatch = pathname.match(/^\/api\/tunnels\/([\w-]+)\/logs$/);
      if (req.method === 'GET' && logsMatch) {
        const logs = manager.logs(logsMatch[1]);
        if (!logs) {
          sendJson(res, 404, { ok: false, error: '隧道不存在' });
          return;
        }
        sendJson(res, 200, { ok: true, logs });
        return;
      }

      const tunnelMatch = pathname.match(/^\/api\/tunnels\/([\w-]+)$/);
      if (tunnelMatch && (req.method === 'DELETE' || req.method === 'POST')) {
        const { id } = { id: tunnelMatch[1] };
        const removed = req.method === 'DELETE' ? manager.remove(id) : manager.stop(id);
        sendJson(res, removed ? 200 : 404, { ok: removed });
        return;
      }

      sendJson(res, 404, { ok: false, error: '未找到接口' });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message });
    }
  });
}

module.exports = { createServer };
