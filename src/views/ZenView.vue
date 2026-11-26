<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useMessage } from 'naive-ui'
import { state, settings, refreshTunnels } from '../store'
import { startTunnel, resumeTunnel, restartTunnel, stopTunnel } from '../api'

const emit = defineEmits(['close'])
const message = useMessage()
const busy = ref(false)
const zenId = ref('')
const editing = ref(false)
const tap = ref(0)
const cooldown = ref(0)
const stopping = ref(false)
let cooldownTimer = 0

const port = computed({
  get: () => settings.zenPort || 8080,
  set: (v) => {
    settings.zenPort = Number(v) || 8080
  },
})

const zen = computed(() => state.tunnels.find((t) => t.id === zenId.value) || null)
const status = computed(() => {
  if (!zen.value) return 'idle'
  if (zen.value.paused) return 'paused'
  return zen.value.status
})
const caption = computed(() => {
  if (stopping.value) return '正在断开 · 请稍候'
  if (cooldown.value > 0) return `Cloudflare 限流 · ${cooldown.value}s 后可重试`
  const map = {
    idle: '未连接 · 点一下启动',
    stopped: '已断开 · 点一下启动',
    error: '连接失败 · 点一下重试',
    starting: '正在连接 · 请稍候',
    running: '已连接 · 点一下断开',
    paused: '已暂停 · 点一下恢复',
  }
  return map[status.value] || '未连接 · 点一下启动'
})
const url = computed(() => (status.value === 'running' ? zen.value?.url || '' : ''))
const hint = computed(() => {
  if (cooldown.value > 0) return '免费临时域名申请被 Cloudflare 限流，冷却结束后按钮自动恢复'
  if (url.value) return '点一下公网地址即可复制'
  if (status.value === 'paused') return '隧道已暂停，点圆形按钮恢复'
  if (status.value === 'error') return zen.value?.error || '连接失败，点圆形按钮重试'
  return '点击圆形按钮，系统会自动选择域名并生成子域名，无需手动配置'
})

const pending = computed(() => status.value === 'starting')
const isBusy = computed(() => pending.value || stopping.value)
const orbTitle = computed(() => {
  if (cooldown.value > 0) return `${cooldown.value} 秒后可重试`
  const s = status.value
  if (s === 'starting') return '正在连接'
  if (s === 'running') return '断开连接'
  if (s === 'paused') return '恢复连接'
  return '启动连接'
})

function startCooldown(seconds = 60) {
  cooldown.value = seconds
  clearInterval(cooldownTimer)
  cooldownTimer = setInterval(() => {
    cooldown.value -= 1
    if (cooldown.value <= 0) {
      cooldown.value = 0
      clearInterval(cooldownTimer)
    }
  }, 1000)
}

watch(
  () => zen.value?.error,
  (err) => {
    if (err && /429|too many requests/i.test(String(err))) startCooldown(60)
  },
)

onBeforeUnmount(() => clearInterval(cooldownTimer))

async function copyUrl() {
  if (!url.value) return
  try {
    await navigator.clipboard.writeText(url.value)
    message.success('公网地址已复制')
  } catch {
    message.error('复制失败，请手动选择地址')
  }
}

onMounted(async () => {
  try {
    await refreshTunnels()
  } catch {
    /* 后端未就绪时忽略 */
  }
  const found = state.tunnels.find((t) => (t.name || '').startsWith('禅模式'))
  if (found) {
    zenId.value = found.id
    const p = Number((String(found.name).match(/(\d{2,5})/) || [])[1])
    if (p) port.value = p
  }
})

async function onOrb() {
  if (busy.value) return
  tap.value += 1
  busy.value = true
  try {
    if (status.value === 'running') {
      if (!zen.value?.id) return
      stopping.value = true
      const startedAt = Date.now()
      try {
        await stopTunnel(zen.value.id)
        // 让断开的溶血动效至少完整播一轮，避免一闪而过
        const rest = 1100 - (Date.now() - startedAt)
        if (rest > 0) await new Promise((resolve) => setTimeout(resolve, rest))
      } finally {
        stopping.value = false
      }
      message.success('已断开连接')
      return
    }
    if (zen.value?.paused) {
      await resumeTunnel(zen.value.id)
      message.success('已恢复')
      return
    }
    if (zen.value && (zen.value.status === 'stopped' || zen.value.status === 'error')) {
      await restartTunnel(zen.value.id)
      return
    }
    const created = await startTunnel({
      name: `禅模式 · ${port.value}`,
      port: port.value,
      protocol: settings.protocol === 'auto' ? null : settings.protocol,
      token: null,
      domain: null,
    })
    if (created?.id) zenId.value = created.id
  } catch (e) {
    const text = String(e?.message || e)
    if (/429|too many requests/i.test(text)) {
      startCooldown(60)
      message.error('Cloudflare 限流：临时域名申请太频繁，冷却结束后可重试')
    } else {
      message.error(text)
    }
  } finally {
    busy.value = false
    try {
      await refreshTunnels()
    } catch {
      /* 忽略 */
    }
  }
}
</script>

<template>
  <div class="zen-page">
    <div class="zen-header">
      <div class="zen-header-text">
        <div class="zen-title-row">
          <h2 class="page-title">禅模式</h2>
          <button class="zen-switch" title="返回隧道管理" @click="emit('close')">
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 10h12M4 10l3-3M4 10l3 3M16 4v12M13 16l3-3M13 16l3 3" />
            </svg>
          </button>
          <span class="zen-tag">极简</span>
        </div>
        <p class="zen-sub">一键穿透，系统自动分配公网域名</p>
      </div>
    </div>
    <div class="zen-stage">
      <div class="zen-power" :class="`zen-power--${status}`">
        <div class="zen-lightning" :class="{ 'zen-lightning--active': isBusy || status === 'running' }" aria-hidden="true">
          <svg class="zen-lightning-svg" viewBox="0 0 260 260" fill="none">
            <path
              class="zen-lightning-arc"
              d="M130 18C96 66 168 96 128 144C100 178 132 200 130 242"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-dasharray="9 13"
            />
            <path
              class="zen-lightning-arc zen-lightning-arc--right"
              d="M130 18C164 66 92 96 132 144C160 178 128 200 130 242"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-dasharray="9 13"
            />
          </svg>
        </div>
        <div class="zen-power-shell">
          <div class="zen-power-ring"></div>
          <div class="zen-power-outer" :class="{ 'is-busy': isBusy }">
            <button class="zen-orb" :disabled="busy || pending || cooldown > 0" :title="orbTitle" @click="onOrb">
              <span class="zen-face" :class="{ 'is-busy': isBusy }">
                <span class="zen-blob zen-blob--a"></span>
                <span class="zen-blob zen-blob--b"></span>
                <span class="zen-blob zen-blob--c"></span>
                <svg class="zen-bolt" width="64" height="64" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5Z" />
                </svg>
              </span>
            </button>
          </div>
        </div>
        <span v-if="tap" :key="tap" class="zen-ripple" aria-hidden="true"></span>
      </div>
      <p class="zen-caption">{{ caption }}</p>
      <div class="zen-url" :class="{ 'zen-url--empty': !url }" :title="url ? '点击复制' : ''" @click="copyUrl">{{ url }}</div>

      <button class="zen-chip" title="修改本地端口" @click="editing = !editing">
        <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
          <path d="M3 10h14M10 3v14" />
        </svg>
        <template v-if="!editing">本地端口 {{ port }}</template>
        <input
          v-else
          v-model.number="port"
          class="zen-port-input"
          type="number"
          min="1"
          max="65535"
          @blur="editing = false"
          @keyup.enter="editing = false"
        />
      </button>
      <p class="zen-hint">{{ hint }}</p>
    </div>
  </div>
</template>
