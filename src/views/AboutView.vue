<script setup>
import { NTag } from 'naive-ui'

const version = __APP_VERSION__
</script>

<template>
  <div>
    <h2 class="page-title">关于</h2>
    <p class="page-desc">一个把本机服务快速发布到公网的桌面客户端</p>

    <div class="tunnel-card settings-card">
      <div class="setting-row">
        <div class="setting-label">版本</div>
        <div>{{ version }}</div>
      </div>
      <div class="setting-row">
        <div class="setting-label">界面</div>
        <div>Tauri 2 · Vue 3 · Naive UI</div>
      </div>
      <div class="setting-row">
        <div class="setting-label">隧道内核</div>
        <div>cloudflared（Cloudflare 官方，Apache-2.0）</div>
      </div>
      <div class="setting-row">
        <div class="setting-label">原理</div>
        <div style="max-width: 380px; line-height: 1.7">
          启动 cloudflared 子进程建立 QUIC 隧道，把本地端口映射成
          <code>*.trycloudflare.com</code> 的 https 公网地址，无需账号和服务器。
        </div>
      </div>
      <div class="setting-row">
        <div class="setting-label">许可</div>
        <n-tag type="success" round>Apache-2.0</n-tag>
      </div>
    </div>
  </div>
</template>
