import { reactive, watch } from 'vue'
import { listTunnels, restoreTunnels } from './api'

const SETTINGS_KEY = 'lin-tunnel.settings.v2'

const defaults = {
  theme: 'light',
  zenPort: 8080,
  defaultPort: 8080,
  pollInterval: 1500,
  keepLogs: true,
  protocol: 'auto',
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    return raw ? { ...defaults, ...JSON.parse(raw) } : { ...defaults }
  } catch {
    return { ...defaults }
  }
}

export const settings = reactive(loadSettings())

watch(
  settings,
  (value) => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(value))
    } catch {
      /* 忽略持久化失败 */
    }
  },
  { deep: true },
)

export const state = reactive({
  tunnels: [],
  loading: false,
  error: '',
  ready: false,
})

export async function refreshTunnels() {
  try {
    state.tunnels = await listTunnels()
    state.error = ''
    state.ready = true
  } catch (err) {
    state.error = err?.message || String(err)
  }
}

export function startPolling() {
  restoreTunnels()
    .then((list) => {
      state.tunnels = list
      state.ready = true
      state.error = ''
    })
    .catch((err) => {
      state.error = err?.message || String(err)
    })
  refreshTunnels()
  const timer = setInterval(refreshTunnels, settings.pollInterval)
  return () => clearInterval(timer)
}

export const statusMeta = {
  starting: { text: '建立中', type: 'warning' },
  running: { text: '运行中', type: 'success' },
  stopped: { text: '已停止', type: 'default' },
  error: { text: '失败', type: 'error' },
}
