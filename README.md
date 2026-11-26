# Lin Tunnel

把本机端口一键发布到公网的 Windows 桌面客户端。界面用 Tauri 2 + Vue 3 + Naive UI，隧道内核是 Cloudflare 官方的
`cloudflared`（quick tunnel，无需账号）。

## 功能

- 多隧道并存，一隧道一进程，互不影响
- 自动分配 `https://xxx.trycloudflare.com` 公网地址，展示 / 复制 / 浏览器打开 / 生成二维码
- 完整生命周期：启动、暂停（挂起进程，省流量但公网会超时）、继续、重启（换新地址）、停止、重新启动、删除
- 修改隧道名称 / 端口，可选择保存后立即重启
- 实时日志（stdout + stderr，保留最近 500 行），30 秒未拿到地址自动标红；失败时带出 cloudflared 的最后一条错误（含 429 频控原因）
- 访客 IP 归属地查询（ip-api.com）
- 线路测速：对任意运行中的隧道实测 4 次 HTTP 首字节耗时（TTFB），给出中位数 / 最快 / 最慢，用来判断"慢"是本机、跨境还是 Cloudflare 边缘造成的
- 传输协议可选（自动 / quic / http2），可用来规避国内 UDP 干扰，改完重启隧道生效
- 禅模式：只填一个端口，点「一键穿透」直接建隧道，不用起名选域名
- 自带域名（Named Tunnel）：填 Cloudflare 的 Tunnel Token + 自己的域名，公网地址就是你的域名（回源地址在 Cloudflare 后台配）
- 隧道清单自动落盘（`%APPDATA%\com.lin.tunnel\tunnels.json`），重开应用后列表、端口、协议、自带域名配置都还在，点「启动」即可重连
- 深色 / 浅色主题、默认端口、开机自启（当前用户注册表 Run 键，不需要管理员）
- 退出应用时自动清理所有 cloudflared 子进程

## 安装与使用

1. 运行 `Lin Tunnel_1.3.0_x64-setup.exe`（当前用户安装，无需管理员），装完从开始菜单启动。
2. 「新建隧道」填一个本机端口 → 几秒后出现 `https://xxx.trycloudflare.com`。
3. 卡片上可复制地址、在浏览器打开、生成二维码、看实时日志，并按需暂停 / 继续 / 重启 / 修改 / 停止 / 删除。
4. 浏览器里打开地址就是本机服务；公网地址由 Cloudflare 临时分配，重启或停止后旧地址失效。

## 开发

```powershell
npm install
npm run app:dev      # 开发模式，带热更新
npm run build        # 只构建前端
npm run app:build    # 打 NSIS 安装包
```

首次 `app:dev` / `app:build` 需要 Rust 工具链（stable-msvc）和 WebView2（Win10/11 自带）。

## 自检与回归

```powershell
# 先起一个本地服务
node tests\smoke-server.js 8080

# 后端链路（spawn cloudflared → 拿地址 → 退出）
src-tauri\target\debug\lin-tunnel.exe --smoke 8080

# 界面链路（需要 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 启动应用）
node tests\ui-tunnel-url.mjs 8080

# 完整控制回归：新建 → 暂停 → 继续 → 重启 → 改端口 → 停止 → 启动
node tests\ui-controls2.mjs
```

Cloudflare quick tunnel 有频控：短时间反复新建会返回 `429 Tunnelstore request failed`，cloudflared 随即退出。
界面会把这条原因显示在卡片上，隔几分钟点「重试」即可；回归脚本遇到 429 会自动等待重试。

## 目录

```
src/                  Vue 前端
  api.js              invoke 封装
  store.js            全局状态 + 轮询
  views/              隧道 / 日志 / 设置 / 关于
src-tauri/            Rust 后端
  src/lib.rs          隧道管理、日志采集、IP 查询、开机自启
  tauri.conf.json     窗口 / 打包配置
bin/cloudflared.exe   隧道内核（打包时随应用分发）
```

## 服务端探测

`cloudflared` 只认 TCP。本机服务若只监听 IPv6（如 Vite 默认的 `::1`），后端会自动探测
`127.0.0.1` → `[::1]`，命中 IPv6 时改用 `http://localhost:PORT`，否则公网访问会 502。

## 许可

Apache-2.0。`cloudflared` 版权归 Cloudflare，Apache-2.0。
