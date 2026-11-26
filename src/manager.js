'use strict';

const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');

const URL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i;
const MAX_LOG_LINES = 400;
const START_TIMEOUT_MS = 30000;

function probe(host, port, timeout = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

// Vite 等开发服务器常常只监听 IPv6 的 ::1，cloudflared 固定连 127.0.0.1 会 502。
// 先探测实际可连的地址，再交给 cloudflared。
async function resolveOrigin(port) {
  if (await probe('127.0.0.1', port)) return `http://127.0.0.1:${port}`;
  if (await probe('::1', port)) return `http://localhost:${port}`;
  return `http://127.0.0.1:${port}`;
}

class TunnelManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.cloudflaredPath = options.cloudflaredPath;
    this.tunnels = new Map();
    if (!this.cloudflaredPath || !fs.existsSync(this.cloudflaredPath)) {
      throw new Error(`找不到 cloudflared：${this.cloudflaredPath || '(未配置)'}`);
    }
  }

  async start({ name, port, host }) {
    const id = randomUUID();
    const target = host ? `${host}:${port}` : await resolveOrigin(port);
    const tunnel = {
      id,
      name: name?.trim() || `端口 ${port}`,
      port: Number(port),
      target,
      status: 'starting',
      url: null,
      error: null,
      pid: null,
      createdAt: new Date().toISOString(),
      logs: [],
      proc: null,
      timer: null,
    };

    const args = ['tunnel', '--no-autoupdate', '--url', target];
    let proc;
    try {
      proc = spawn(this.cloudflaredPath, args, { windowsHide: true });
    } catch (err) {
      tunnel.status = 'error';
      tunnel.error = err.message;
      this.tunnels.set(id, tunnel);
      return this.view(tunnel);
    }

    tunnel.proc = proc;
    tunnel.pid = proc.pid ?? null;
    this.tunnels.set(id, tunnel);
    this.emit('update');

    const append = (line) => {
      const text = String(line).replace(/\r/g, '').trim();
      if (!text) return;
      tunnel.logs.push(text);
      if (tunnel.logs.length > MAX_LOG_LINES) tunnel.logs.shift();
      if (!tunnel.url) {
        const match = text.match(URL_RE);
        if (match) {
          tunnel.url = match[0];
          tunnel.status = 'running';
          clearTimeout(tunnel.timer);
          this.emit('update');
        }
      }
      this.emit('log', id, text);
    };

    for (const stream of [proc.stdout, proc.stderr]) {
      if (!stream) continue;
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        for (const line of chunk.split('\n')) append(line);
      });
    }

    proc.on('error', (err) => {
      tunnel.status = 'error';
      tunnel.error = err.message;
      clearTimeout(tunnel.timer);
      this.emit('update');
    });

    proc.on('exit', (code) => {
      clearTimeout(tunnel.timer);
      if (tunnel.status !== 'error') {
        tunnel.status = 'stopped';
        tunnel.exitCode = code;
      }
      tunnel.pid = null;
      this.emit('update');
    });

    tunnel.timer = setTimeout(() => {
      if (tunnel.status === 'starting') {
        tunnel.status = 'error';
        tunnel.error = '30 秒内没有拿到公网地址，检查网络或 cloudflared 日志';
        this.emit('update');
      }
    }, START_TIMEOUT_MS);
    tunnel.timer.unref?.();

    return this.view(tunnel);
  }

  stop(id) {
    const tunnel = this.tunnels.get(id);
    if (!tunnel) return false;
    clearTimeout(tunnel.timer);
    if (tunnel.proc && tunnel.pid) {
      try {
        tunnel.proc.kill();
      } catch {
        /* 进程可能已经退出 */
      }
      tunnel.status = 'stopped';
    }
    this.emit('update');
    return true;
  }

  remove(id) {
    const tunnel = this.tunnels.get(id);
    if (tunnel) {
      clearTimeout(tunnel.timer);
      try {
        tunnel.proc?.kill();
      } catch {
        /* ignore */
      }
      this.tunnels.delete(id);
      this.emit('update');
    }
    return Boolean(tunnel);
  }

  stopAll() {
    for (const tunnel of this.tunnels.values()) {
      clearTimeout(tunnel.timer);
      try {
        tunnel.proc?.kill();
      } catch {
        /* ignore */
      }
      tunnel.status = 'stopped';
    }
    this.emit('update');
  }

  logs(id) {
    return this.tunnels.get(id)?.logs ?? null;
  }

  view(tunnel) {
    return {
      id: tunnel.id,
      name: tunnel.name,
      port: tunnel.port,
      target: tunnel.target,
      status: tunnel.status,
      url: tunnel.url,
      error: tunnel.error,
      pid: tunnel.pid,
      createdAt: tunnel.createdAt,
      logTail: tunnel.logs.slice(-12),
    };
  }

  state() {
    return [...this.tunnels.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((tunnel) => this.view(tunnel));
  }
}

module.exports = { TunnelManager };
