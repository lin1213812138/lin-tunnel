<script setup>
import { computed, onUnmounted, ref, watch } from 'vue'
import { NButton, NSelect, NEmpty, NTag, NInput, useMessage } from 'naive-ui'
import { state, statusMeta } from '../store'
import { tunnelLogs, lookupIp } from '../api'

const message = useMessage()
const ipInput = ref('')
const ipResult = ref(null)
const looking = ref(false)

async function queryIp() {
  if (!ipInput.value.trim()) {
    message.warning('先填入一个 IP')
    return
  }
  looking.value = true
  try {
    const result = await lookupIp(ipInput.value.trim())
    if (result.status !== 'success') {
      message.warning(result.message || '查询失败')
      ipResult.value = null
    } else {
      ipResult.value = result
    }
  } catch (err) {
    message.error(err?.message || String(err))
    ipResult.value = null
  } finally {
    looking.value = false
  }
}

const selected = ref(null)
const logs = ref([])
const autoRefresh = ref(true)
let timer = null

const options = computed(() =>
  state.tunnels.map((tunnel) => ({
    label: `${tunnel.name}（${tunnel.port}）`,
    value: tunnel.id,
  })),
)

watch(
  options,
  (list) => {
    if (!selected.value && list.length) selected.value = list[0].value
    if (selected.value && !list.some((item) => item.value === selected.value)) {
      selected.value = list[0]?.value ?? null
    }
  },
  { immediate: true },
)

async function load() {
  if (!selected.value) {
    logs.value = []
    return
  }
  try {
    logs.value = await tunnelLogs(selected.value)
  } catch {
    logs.value = []
  }
}

watch(selected, load, { immediate: true })

function startTimer() {
  clearInterval(timer)
  timer = setInterval(() => {
    if (autoRefresh.value) load()
  }, 1500)
}
startTimer()
onUnmounted(() => clearInterval(timer))

const currentTunnel = computed(() => state.tunnels.find((tunnel) => tunnel.id === selected.value))
</script>

<template>
  <div>
    <h2 class="page-title">运行日志</h2>
    <p class="page-desc">cloudflared 的实时输出，排查 502 / 连接中断时最有用</p>

    <div v-if="!state.tunnels.length">
      <n-empty description="还没有隧道，先去「隧道」页建一条" />
    </div>

    <template v-else>
      <div style="display: flex; gap: 12px; align-items: center; margin-bottom: 14px; max-width: 560px">
        <n-select v-model:value="selected" :options="options" style="flex: 1" />
        <n-tag v-if="currentTunnel" :type="statusMeta[currentTunnel.status]?.type || 'default'" round>
          {{ statusMeta[currentTunnel.status]?.text || currentTunnel.status }}
        </n-tag>
        <n-button size="small" secondary @click="load">刷新</n-button>
      </div>
      <div class="log-box" style="min-height: 420px">{{ logs.length ? logs.join('\n') : '暂无日志' }}</div>

      <div class="tunnel-card" style="margin-top: 18px">
        <div class="setting-label" style="margin-bottom: 8px">访客 IP 归属地</div>
        <div style="display: flex; gap: 10px; max-width: 460px">
          <n-input v-model:value="ipInput" placeholder="例如 1.1.1.1" @keyup.enter="queryIp" />
          <n-button :loading="looking" @click="queryIp">查询</n-button>
        </div>
        <div v-if="ipResult" class="setting-hint" style="margin-top: 10px; line-height: 1.9">
          {{ ipResult.query }} · {{ ipResult.country }} {{ ipResult.regionName }} {{ ipResult.city }}<br />
          运营商：{{ ipResult.isp }} · 时区：{{ ipResult.timezone }}
        </div>
      </div>
    </template>
  </div>
</template>
