import { invoke } from '@tauri-apps/api/core'

export const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

function guard(promise) {
  if (!isDesktop) {
    return Promise.reject(new Error('当前是浏览器预览模式，请用 npm run app:dev 启动桌面客户端'))
  }
  return promise
}

export const listTunnels = () => guard(invoke('list_tunnels'))
export const restoreTunnels = () => guard(invoke('restore_tunnels'))
export const startTunnel = (payload) => guard(invoke('start_tunnel', payload))
export const stopTunnel = (id) => guard(invoke('stop_tunnel', { id }))
export const restartTunnel = (id) => guard(invoke('restart_tunnel', { id }))
export const pauseTunnel = (id) => guard(invoke('pause_tunnel', { id }))
export const resumeTunnel = (id) => guard(invoke('resume_tunnel', { id }))
export const updateTunnel = (payload) => guard(invoke('update_tunnel', payload))
export const removeTunnel = (id) => guard(invoke('remove_tunnel', { id }))
export const tunnelLogs = (id) => guard(invoke('tunnel_logs', { id }))
export const cloudflaredInfo = () => guard(invoke('cloudflared_info'))
export const lookupIp = (ip) => guard(invoke('lookup_ip', { ip }))
export const measureTunnel = (id, rounds = 3) => guard(invoke('measure_tunnel', { id, rounds }))
export const openUrl = async (url) => {
  const mod = await import('@tauri-apps/plugin-opener')
  return mod.openUrl(url)
}
