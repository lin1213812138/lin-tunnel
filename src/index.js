'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { TunnelManager } = require('./manager');
const { createServer } = require('./server');

const ROOT = path.join(__dirname, '..');

function resolveCloudflared(explicit) {
  const candidates = [
    explicit,
    process.env.CLOUDFLARED_PATH,
    path.join(ROOT, 'bin', 'cloudflared.exe'),
    path.join(ROOT, 'bin', 'cloudflared'),
    'cloudflared',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === 'cloudflared') return candidate;
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('没有找到 cloudflared，请把它放到 bin\\cloudflared.exe 或设置 CLOUDFLARED_PATH');
}

function parseArgs(argv) {
  const options = { uiPort: 7788, open: true, cloudflared: null, command: 'serve', tunnelPort: null };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port' || arg === '-p') options.uiPort = Number(argv[++i]);
    else if (arg === '--no-open') options.open = false;
    else if (arg === '--cloudflared') options.cloudflared = argv[++i];
    else if (arg === 'tunnel') options.command = 'tunnel';
    else rest.push(arg);
  }
  if (options.command === 'tunnel') {
    const port = Number(rest[0] ?? options.uiPort);
    options.tunnelPort = port;
  }
  return options;
}

function openBrowser(url) {
  execFile('cmd', ['/c', 'start', '', url], { windowsHide: true }, () => {});
}

async function runHeadless(manager, port) {
  const tunnel = await manager.start({ port, name: `端口 ${port}` });
  console.log(`正在为 http://127.0.0.1:${port} 建立公网隧道…`);
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('30 秒内没有拿到公网地址')), 30000);
    const check = () => {
      const current = manager.state().find((item) => item.id === tunnel.id);
      if (current?.url) {
        clearTimeout(timer);
        resolve(current.url);
      } else if (current?.status === 'error') {
        clearTimeout(timer);
        reject(new Error(current.error));
      }
    };
    manager.on('update', check);
    check();
  });
  console.log(`\n公网地址：${url}\n按 Ctrl+C 结束隧道`);
  process.on('SIGINT', () => {
    manager.stopAll();
    process.exit(0);
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manager = new TunnelManager({ cloudflaredPath: resolveCloudflared(options.cloudflared) });

  if (options.command === 'tunnel') {
    await runHeadless(manager, options.tunnelPort);
    return;
  }

  const server = createServer(manager);
  server.listen(options.uiPort, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${options.uiPort}`;
    console.log(`lin-tunnel 控制台：${url}`);
    if (options.open) openBrowser(url);
  });
  server.on('error', (err) => {
    console.error(`控制台端口 ${options.uiPort} 启动失败：${err.message}`);
    process.exit(1);
  });

  const shutdown = () => {
    manager.stopAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(`启动失败：${err.message}`);
  process.exit(1);
});
