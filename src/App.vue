<script setup>
import { computed, onMounted, ref } from 'vue'
import {
  NConfigProvider,
  NDialogProvider,
  NMessageProvider,
  darkTheme,
  lightTheme,
} from 'naive-ui'
import { settings, startPolling } from './store'
import ZenView from './views/ZenView.vue'
import TunnelsView from './views/TunnelsView.vue'
import LogsView from './views/LogsView.vue'
import SettingsView from './views/SettingsView.vue'
import AboutView from './views/AboutView.vue'

const version = __APP_VERSION__

const pages = [
  { key: 'zen', label: '禅模式', hidden: true, comp: ZenView, icon: 'M11 2 5 12h5l-1 6 6-10h-5l1-6' },
  { key: 'tunnels', label: '隧道管理', comp: TunnelsView, icon: 'M4 8h12l-3-3M16 12H4l3 3' },
  { key: 'logs', label: '运行日志', comp: LogsView, icon: 'M4 5h12M4 9h12M4 13h8M4 17h10' },
  { key: 'settings', label: '设置', comp: SettingsView, icon: 'M10 7.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6M10 2v2M10 16v2M2 10h2M16 10h2' },
  { key: 'about', label: '关于', comp: AboutView, icon: 'M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16M10 9v5M10 6.2v.2' },
]

const page = ref('tunnels')
const navPages = computed(() => pages.filter((p) => !p.hidden))
const current = computed(() => pages.find((p) => p.key === page.value) || pages[0])
const theme = computed(() => (settings.theme === 'light' ? lightTheme : darkTheme))

const themeOverrides = {
  common: {
    primaryColor: '#6366f1',
    primaryColorHover: '#818cf8',
    primaryColorPressed: '#4f46e5',
    primaryColorSuppl: '#818cf8',
    borderRadius: '8px',
    borderRadiusSmall: '6px',
    fontFamily: "'Segoe UI', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif",
    fontSize: '14px',
  },
  Button: { fontWeight: '500' },
  Card: { borderRadius: '14px' },
}

function select(key) {
  page.value = key
  if (window.location.hash !== `#${key}`) window.location.hash = key
}

onMounted(() => {
  const key = (window.location.hash || '').replace('#', '')
  if (pages.some((p) => p.key === key)) page.value = key
  window.addEventListener('lin-zen', () => select('zen'))
  window.__stopPolling = startPolling()
})
</script>

<template>
  <n-config-provider :theme="theme" :theme-overrides="themeOverrides">
    <n-dialog-provider>
      <n-message-provider>
        <div class="shell">
          <aside class="side">
            <div class="brand">
              <div class="brand-tile">L</div>
              <div class="brand-name">Lin Tunnel</div>
            </div>
            <div
              v-for="item in navPages"
              :key="item.key"
              class="nav-item"
              :class="{ active: page === item.key }"
              @click="select(item.key)"
            >
              <span class="nav-icon">
                <svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                  <path :d="item.icon" />
                </svg>
              </span>
              <span>{{ item.label }}</span>
            </div>
            <div class="side-footer">
              内核 cloudflared<br />
              v{{ version }}
            </div>
          </aside>

          <main class="main" :class="{ 'main-flush': page === 'zen' }">
            <component :is="current.comp" @close="select('tunnels')" />
          </main>
        </div>
      </n-message-provider>
    </n-dialog-provider>
  </n-config-provider>
</template>
