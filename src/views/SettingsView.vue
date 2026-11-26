<script setup>
import { onMounted, ref } from 'vue'
import { NSelect, NInputNumber, NSwitch, NButton, useMessage } from 'naive-ui'
import { settings, refreshTunnels } from '../store'
import { invoke } from '@tauri-apps/api/core'
import { isDesktop } from '../api'

const message = useMessage()
const info = ref(null)
const autostart = ref(false)
const autostartBusy = ref(false)

const themeOptions = [
  { label: '深色', value: 'dark' },
  { label: '浅色', value: 'light' },
]

const protocolOptions = [
  { label: '自动（默认 quic）', value: 'auto' },
  { label: 'quic（UDP，低延迟）', value: 'quic' },
  { label: 'http2（TCP，抗干扰）', value: 'http2' },
]

onMounted(async () => {
  if (!isDesktop) return
  try {
    info.value = await invoke('cloudflared_info')
  } catch {
    info.value = null
  }
  try {
    autostart.value = await invoke('get_autostart')
  } catch {
    autostart.value = false
  }
})

async function toggleAutostart(value) {
  autostartBusy.value = true
  try {
    autostart.value = await invoke('set_autostart', { enabled: value })
    message.success(value ? '已开启开机自启' : '已关闭开机自启')
  } catch (err) {
    autostart.value = !value
    message.error(`设置失败：${err?.message || err}`)
  } finally {
    autostartBusy.value = false
  }
}

async function applyPort(value) {
  settings.defaultPort = value || 8080
  message.success('默认端口已保存')
}
</script>

<template>
  <div>
    <h2 class="page-title">设置</h2>
    <p class="page-desc">偏好会保存在本机，重启后保留</p>

    <div class="tunnel-card settings-card">
      <div class="setting-row">
        <div>
          <div class="setting-label">外观主题</div>
          <div class="setting-hint">深色更适合长时间盯日志</div>
        </div>
        <n-select v-model:value="settings.theme" :options="themeOptions" style="width: 140px" />
      </div>

      <div class="setting-row">
        <div>
          <div class="setting-label">新建隧道的默认端口</div>
          <div class="setting-hint">只是表单预填值，不影响已有隧道</div>
        </div>
        <n-input-number
          :value="settings.defaultPort"
          :min="1"
          :max="65535"
          style="width: 140px"
          @update:value="applyPort"
        />
      </div>

      <div class="setting-row">
        <div>
          <div class="setting-label">传输协议</div>
          <div class="setting-hint">
            只影响之后新建或重启的隧道。国内网络 UDP 常被干扰，http2 走 TCP 可能更稳；改完点隧道的「重启」生效。
          </div>
        </div>
        <n-select v-model:value="settings.protocol" :options="protocolOptions" style="width: 160px" />
      </div>

      <div class="setting-row">
        <div>
          <div class="setting-label">开机自动启动</div>
          <div class="setting-hint">写入当前用户登录启动项，不申请管理员权限</div>
        </div>
        <n-switch
          :value="autostart"
          :loading="autostartBusy"
          :disabled="!isDesktop"
          @update:value="toggleAutostart"
        />
      </div>

      <div class="setting-row">
        <div>
          <div class="setting-label">隧道内核</div>
          <div class="setting-hint">
            {{ info ? info.version : '检测中…' }}
            <br />
            {{ info ? info.path : '' }}
          </div>
        </div>
        <n-button size="small" secondary @click="refreshTunnels">刷新状态</n-button>
      </div>
    </div>

    <p class="page-desc" style="margin-top: 18px">
      提示：浏览器预览模式下部分功能不可用，桌面功能请用 <code>npm run app:dev</code> 启动。
    </p>
  </div>
</template>
