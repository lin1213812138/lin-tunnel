<script setup>
import { nextTick, onUnmounted, ref } from 'vue'
import {
  NButton,
  NCheckbox,
  NDropdown,
  NInput,
  NInputNumber,
  NModal,
  NTag,
  NSpace,
  NEmpty,
  NDrawer,
  NDrawerContent,
  NSpin,
  useMessage,
} from 'naive-ui'
import QRCode from 'qrcode'
import { state, settings, refreshTunnels, statusMeta } from '../store'
import {
  startTunnel,
  stopTunnel,
  restartTunnel,
  pauseTunnel,
  resumeTunnel,
  updateTunnel,
  removeTunnel,
  tunnelLogs,
  measureTunnel,
  openUrl,
} from '../api'

const message = useMessage()

const showCreate = ref(false)
const creating = ref(false)
const form = ref({ name: '', port: settings.defaultPort || 8080, named: false, token: '', domain: '' })
const zenPort = ref(settings.defaultPort || 8080)
const zenBusy = ref(false)

async function zenStart() {
  const port = Number(zenPort.value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    message.warning('端口需要是 1-65535 的整数')
    return
  }
  zenBusy.value = true
  try {
    await startTunnel({
      name: `禅模式 · ${port}`,
      port,
      protocol: settings.protocol === 'auto' ? null : settings.protocol,
      token: null,
      domain: null,
    })
    message.success('已启动，公网地址马上就好')
    await refreshTunnels()
  } catch (err) {
    message.error(err?.message || String(err))
  } finally {
    zenBusy.value = false
  }
}

const editing = ref(null)
const editForm = ref({ name: '', port: 8080, restart: true })
const saving = ref(false)

const qrUrl = ref('')
const qrVisible = ref(false)
const qrCanvas = ref(null)

const logsVisible = ref(false)
const logsTitle = ref('')
const logsId = ref('')
const logs = ref([])
let logsTimer = null

const busy = ref('')

const benchVisible = ref(false)
const benchLoading = ref(false)
const benchRow = ref(null)
const benchName = ref('')

async function runBench(tunnel) {
  benchName.value = tunnel.name
  benchRow.value = null
  benchVisible.value = true
  benchLoading.value = true
  try {
    benchRow.value = await measureTunnel(tunnel.id, 4)
    if (benchRow.value.error && !benchRow.value.samples.length) {
      message.warning(benchRow.value.error)
    }
  } catch (err) {
    message.error(`测速失败：${err?.message || err}`)
  } finally {
    benchLoading.value = false
  }
}

function benchText(ms) {
  if (ms === null || ms === undefined) return '-'
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`
}

function statusOf(tunnel) {
  if (tunnel.paused) return { text: '已暂停', type: 'warning' }
  return statusMeta[tunnel.status] || { text: tunnel.status, type: 'default' }
}

function canRestart(tunnel) {
  return tunnel.status !== 'starting' || tunnel.paused
}

async function act(tunnel, kind) {
  busy.value = `${tunnel.id}:${kind}`
  try {
    if (kind === 'stop') await stopTunnel(tunnel.id)
    if (kind === 'restart') await restartTunnel(tunnel.id)
    if (kind === 'resume') await resumeTunnel(tunnel.id)
    if (kind === 'remove') await removeTunnel(tunnel.id)
    const tips = {
      stop: '已停止，配置保留；点「启动」可重新建立（公网地址会变）',
      restart: '已重启，正在分配新的公网地址…',
      pause: '已暂停，公网访问暂时不可用',
      resume: '已继续运行',
      remove: '已删除',
    }
    message.info(tips[kind])
    await refreshTunnels()
  } catch (err) {
    message.error(err?.message || String(err))
  } finally {
    busy.value = ''
  }
}

function openEdit(tunnel) {
  editing.value = tunnel
  editForm.value = {
    name: tunnel.name,
    port: tunnel.port,
    restart: tunnel.status === 'running' || tunnel.status === 'starting' || tunnel.paused,
  }
}

async function submitEdit() {
  const port = Number(editForm.value.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    message.warning('端口需要是 1-65535 的整数')
    return
  }
  saving.value = true
  try {
    await updateTunnel({
      id: editing.value.id,
      name: editForm.value.name?.trim() || null,
      port,
      restart: editForm.value.restart,
    })
    message.success(editForm.value.restart ? '已保存并重新启动' : '已保存')
    editing.value = null
    await refreshTunnels()
  } catch (err) {
    message.error(err?.message || String(err))
  } finally {
    saving.value = false
  }
}

async function submitCreate() {
  const port = Number(form.value.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    message.warning('端口需要是 1-65535 的整数')
    return
  }
  const named = form.value.named
  const token = named ? (form.value.token || '').trim() : ''
  const domain = named ? (form.value.domain || '').trim() : ''
  if (named && (!token || !domain)) {
    message.warning('自带域名需要同时填写 Tunnel Token 和域名')
    return
  }
  creating.value = true
  try {
    await startTunnel({
      name: form.value.name?.trim() || `端口 ${port}`,
      port,
      protocol: settings.protocol === 'auto' ? null : settings.protocol,
      token: named ? token : null,
      domain: named ? domain : null,
    })
    message.success(named ? '已用你的域名启动隧道' : '隧道已创建，正在分配公网地址…')
    showCreate.value = false
    form.value = { name: '', port: settings.defaultPort || 8080, named: false, token: '', domain: '' }
    await refreshTunnels()
  } catch (err) {
    message.error(err?.message || String(err))
  } finally {
    creating.value = false
  }
}

async function copyUrl(url) {
  try {
    await navigator.clipboard.writeText(url)
    message.success('已复制公网地址')
  } catch {
    message.warning('复制失败，请手动选中地址')
  }
}

async function onOpen(url) {
  try {
    await openUrl(url)
  } catch (err) {
    message.error(`打开失败：${err?.message || err}`)
  }
}

async function showQr(tunnel) {
  qrUrl.value = tunnel.url
  qrVisible.value = true
  await nextTick()
  if (qrCanvas.value) {
    await QRCode.toCanvas(qrCanvas.value, tunnel.url, {
      width: 240,
      margin: 1,
      color: { dark: '#101014', light: '#ffffff' },
    })
  }
}

async function openLogs(tunnel) {
  logsId.value = tunnel.id
  logsTitle.value = `${tunnel.name} 的日志`
  logsVisible.value = true
  await loadLogs()
  clearInterval(logsTimer)
  logsTimer = setInterval(loadLogs, 1500)
}

async function loadLogs() {
  if (!logsId.value) return
  try {
    logs.value = await tunnelLogs(logsId.value)
  } catch {
    /* 隧道可能已被删除 */
  }
}

function closeLogs() {
  clearInterval(logsTimer)
  logsTimer = null
  logsId.value = ''
}

onUnmounted(() => clearInterval(logsTimer))

function goZen() {
  window.dispatchEvent(new Event('lin-zen'))
}

function moreOptions(tunnel) {
  return [
    { label: '复制地址', key: 'copy', disabled: !tunnel.url },
    { label: '二维码', key: 'qr', disabled: !tunnel.url || tunnel.paused },
    { label: '运行日志', key: 'logs' },
    { label: '线路测速', key: 'bench', disabled: tunnel.status !== 'running' || tunnel.paused },
    { label: '修改', key: 'edit' },
    { type: 'divider', key: 'd1' },
    { label: '删除', key: 'remove' },
  ]
}

function onMore(tunnel, key) {
  if (key === 'copy') copyUrl(tunnel.url)
  else if (key === 'qr') showQr(tunnel)
  else if (key === 'logs') openLogs(tunnel)
  else if (key === 'bench') runBench(tunnel)
  else if (key === 'edit') openEdit(tunnel)
  else if (key === 'remove') act(tunnel, 'remove')
}

function timeText(iso) {
  try {
    return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false })
  } catch {
    return ''
  }
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <div class="zen-title-row">
          <h2 class="page-title">隧道管理</h2>
          <button class="zen-switch" data-tip="切换至禅模式" aria-label="切换至禅模式" @click="goZen">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" stroke="none">
              <path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5Z" />
            </svg>
          </button>
        </div>
        <p class="page-desc">把本机服务映射到公网，支持暂停、继续、重启与自带域名</p>
      </div>
      <div class="page-actions">
        <n-button type="primary" @click="refreshTunnels">刷新</n-button>
        <n-button type="primary" @click="showCreate = true">＋ 新建隧道</n-button>
      </div>
    </div>

    <div v-if="state.error" class="log-box" style="margin-bottom: 16px">连接后端失败：{{ state.error }}</div>

    <div v-if="state.tunnels.length" class="table-card">
      <table class="app-table">
        <thead>
          <tr>
            <th style="width: 18%">名称</th>
            <th style="width: 9%">本地端口</th>
            <th style="width: 33%">公网地址</th>
            <th style="width: 9%">状态</th>
            <th style="width: 11%">创建时间</th>
            <th style="width: 20%">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="tunnel in state.tunnels" :key="tunnel.id">
            <td>
              <div class="cell-name">{{ tunnel.name }}</div>
              <div class="cell-sub">
                {{ tunnel.mode === 'named' ? '自带域名' : '临时域名' }} · PID {{ tunnel.pid ?? '-' }}
              </div>
            </td>
            <td><span class="port-chip">:{{ tunnel.port }}</span></td>
            <td>
              <a
                v-if="tunnel.url"
                class="cell-url"
                :class="{ dim: tunnel.paused }"
                :title="tunnel.paused ? '已暂停，公网不可访问' : '点击复制'"
                @click="copyUrl(tunnel.url)"
              >{{ tunnel.url }}</a>
              <span v-else-if="tunnel.status === 'starting'" class="cell-sub">正在申请地址…</span>
              <span v-else-if="tunnel.error" class="cell-err" :title="tunnel.error">{{ tunnel.error }}</span>
              <span v-else class="cell-sub">—</span>
              <div v-if="tunnel.paused" class="cell-sub">已暂停：进程挂起，公网会超时</div>
            </td>
            <td>
              <span class="pill" :class="`pill-${tunnel.paused ? 'paused' : tunnel.status}`">
                {{ statusOf(tunnel).text }}
              </span>
            </td>
            <td class="cell-sub">{{ timeText(tunnel.createdAt) }}</td>
            <td>
              <div class="row-actions">
                <n-button
                  v-if="tunnel.paused"
                  size="tiny"
                  quaternary
                  type="primary"
                  :loading="busy === `${tunnel.id}:resume`"
                  @click="act(tunnel, 'resume')"
                >继续</n-button>
                <n-button
                  size="tiny"
                  quaternary
                  type="primary"
                  :disabled="tunnel.status !== 'stopped' && tunnel.status !== 'error'"
                  :loading="busy === `${tunnel.id}:restart`"
                  @click="act(tunnel, 'restart')"
                >{{ tunnel.error ? '重试' : '启动' }}</n-button>

                <n-button
                  size="tiny"
                  quaternary
                  :disabled="!(tunnel.paused || tunnel.status === 'running' || tunnel.status === 'starting')"
                  :loading="busy === `${tunnel.id}:stop`"
                  @click="act(tunnel, 'stop')"
                >停止</n-button>



                <n-dropdown
                  trigger="click"
                  placement="bottom-end"
                  to="body"
                  :options="moreOptions(tunnel)"
                  @select="(key) => onMore(tunnel, key)"
                >
                  <n-button size="tiny" quaternary>更多</n-button>
                </n-dropdown>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <div class="table-foot">共 {{ state.tunnels.length }} 条</div>
    </div>

    <div v-else class="empty-wrap">
      <n-empty description="还没有隧道">
        <template #extra>
          <n-button size="small" @click="showCreate = true">建立第一条隧道</n-button>
        </template>
      </n-empty>
    </div>

    <n-modal v-model:show="showCreate" preset="card" title="新建隧道" style="width: 460px">
      <div style="display: flex; flex-direction: column; gap: 16px">
        <div>
          <div class="setting-label">名称（可选）</div>
          <n-input v-model:value="form.name" placeholder="例如：本地前端" maxlength="40" />
        </div>
        <div>
          <div class="setting-label">本机端口</div>
          <n-input-number
            v-model:value="form.port"
            :min="1"
            :max="65535"
            placeholder="8080"
            style="width: 100%"
          />
          <div class="setting-hint">服务实际监听的端口，例如 Vite 的 5173、后端 8080</div>
        </div>
        <div>
          <n-checkbox v-model:checked="form.named">使用我自己的域名（Named Tunnel）</n-checkbox>
          <div class="setting-hint">先在 Cloudflare 后台建好隧道、把它指向本机端口，再填 Token 与域名</div>
        </div>
        <div v-if="form.named">
          <div class="setting-label">Tunnel Token</div>
          <n-input
            v-model:value="form.token"
            type="password"
            show-password-on="click"
            placeholder="eyJhIjoi..."
          />
        </div>
        <div v-if="form.named">
          <div class="setting-label">域名</div>
          <n-input v-model:value="form.domain" placeholder="tunnel.example.com" />
        </div>
      </div>
      <template #footer>
        <n-space justify="end">
          <n-button @click="showCreate = false">取消</n-button>
          <n-button type="primary" :loading="creating" @click="submitCreate">建立隧道</n-button>
        </n-space>
      </template>
    </n-modal>

    <n-modal
      :show="!!editing"
      preset="card"
      title="修改隧道"
      style="width: 460px"
      @update:show="(v) => { if (!v) editing = null }"
    >
      <div style="display: flex; flex-direction: column; gap: 16px">
        <div>
          <div class="setting-label">名称</div>
          <n-input v-model:value="editForm.name" placeholder="隧道名称" maxlength="40" />
        </div>
        <div>
          <div class="setting-label">本机端口</div>
          <n-input-number
            v-model:value="editForm.port"
            :min="1"
            :max="65535"
            style="width: 100%"
          />
        </div>
        <n-checkbox v-model:checked="editForm.restart">
          保存后立即重启（公网地址会重新分配）
        </n-checkbox>
      </div>
      <template #footer>
        <n-space justify="end">
          <n-button @click="editing = null">取消</n-button>
          <n-button type="primary" :loading="saving" @click="submitEdit">保存</n-button>
        </n-space>
      </template>
    </n-modal>

    <n-modal v-model:show="qrVisible" preset="card" title="扫码访问" style="width: 340px">
      <div style="display: flex; flex-direction: column; align-items: center; gap: 12px">
        <canvas ref="qrCanvas" style="border-radius: 8px; background: #fff; padding: 8px"></canvas>
        <div class="tunnel-meta" style="word-break: break-all; text-align: center">{{ qrUrl }}</div>
      </div>
    </n-modal>

    <n-modal v-model:show="benchVisible" preset="card" :title="`线路测速 · ${benchName}`" style="width: 580px">
      <div v-if="benchLoading" class="bench-loading">
        <n-spin size="small" />
        <span>正在对这条隧道测 4 次首字节耗时…</span>
      </div>
      <div v-else-if="benchRow">
        <div class="bench-grid">
          <div class="bench-stat">
            <div class="bench-num">{{ benchText(benchRow.medianMs) }}</div>
            <div class="bench-cap">中位数</div>
          </div>
          <div class="bench-stat">
            <div class="bench-num">{{ benchText(benchRow.bestMs) }}</div>
            <div class="bench-cap">最快</div>
          </div>
          <div class="bench-stat">
            <div class="bench-num">{{ benchText(benchRow.worstMs) }}</div>
            <div class="bench-cap">最慢</div>
          </div>
        </div>
        <div class="tunnel-meta" style="margin-top: 10px; word-break: break-all">{{ benchRow.url }}</div>
        <div v-if="benchRow.error" class="tunnel-meta" style="color: #e88080; margin-top: 8px">
          {{ benchRow.error }}
        </div>
        <div class="setting-hint" style="margin-top: 14px">
          数字是 HTTP 首字节耗时（TTFB）：本机直连通常 10–20 ms，走 Cloudflare quick tunnel 会先到海外边缘
          （这一台常落到洛杉矶 LAX），所以 1–3 s 属正常，跨境回程越远越慢。
        </div>
        <div class="setting-hint">
          想让隧道更稳或更快：到「设置 → 传输协议」切换 quic / http2，再回这里点「重启」+「测速」对比；
          国内 UDP 被限速时 http2 往往更快。
        </div>
      </div>
    </n-modal>

    <n-drawer v-model:show="logsVisible" :width="620" placement="right" @after-leave="closeLogs">
      <n-drawer-content :title="logsTitle" closable>
        <div class="log-box" style="min-height: 240px">{{ logs.length ? logs.join('\n') : '暂无日志' }}</div>
      </n-drawer-content>
    </n-drawer>
  </div>
</template>
