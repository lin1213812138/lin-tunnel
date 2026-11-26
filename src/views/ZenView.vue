<script setup>
import { computed, onMounted, ref } from 'vue'
import { useMessage } from 'naive-ui'
import { state, settings, refreshTunnels } from '../store'
import { startTunnel, resumeTunnel, restartTunnel } from '../api'

const emit = defineEmits(['close'])
const message = useMessage()
const busy = ref(false)
const zenId = ref('')
const editing = ref(false)
const tap = ref(0)

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
  const map = {
    idle: '已停止',
    stopped: '已停止',
    error: '连接失败',
    starting: '正在连接',
    running: '运行中',
    paused: '已暂停',
  }
  return `${map[status.value] || '已停止'} · 闪电连接`
})
const url = computed(() => (status.value === 'running' ? zen.value?.url || '' : ''))
const hint = computed(() => {
  if (url.value) return '再点一次圆形按钮即可复制公网地址'
  if (status.value === 'paused') return '隧道已暂停，点圆形按钮恢复'
  if (status.value === 'error') return zen.value?.error || '连接失败，点圆形按钮重试'
  return '点击圆形按钮，系统会自动选择域名并生成子域名，无需手动配置'
})

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
    if (url.value) {
      await navigator.clipboard.writeText(url.value)
      message.success('公网地址已复制')
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
    message.error(String(e?.message || e))
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
        <div class="zen-ring"></div>
        <span v-if="tap" :key="tap" class="zen-ripple" aria-hidden="true"></span>
        <button class="zen-orb" :disabled="busy" @click="onOrb">
          <svg width="72" height="72" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5Z" fill="currentColor" fill-opacity="0.12" />
          </svg>
        </button>
      </div>
      <p class="zen-caption">{{ caption }}</p>
      <div v-if="url" class="zen-url" title="点击复制" @click="onOrb">{{ url }}</div>

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
