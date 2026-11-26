// 点标题旁的「禅模式」切换按钮 → 截图 + 打印圆心按钮结构
import { writeFileSync } from 'node:fs'

const list = await (await fetch('http://127.0.0.1:9444/json/list')).json()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const waiting = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  const cb = waiting.get(m.id)
  if (cb) { waiting.delete(m.id); m.error ? cb.reject(new Error(m.error.message)) : cb.resolve(m.result) }
})
const send = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => waiting.set(id, { resolve: res, reject: rej })) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
await send('Runtime.enable')
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })).result?.value

console.log('点击切换按钮', await ev(`(() => { const b = document.querySelector('.zen-mode-switch-btn'); if (!b) return 'none'; b.click(); return 'ok' })()`))
await sleep(1600)
console.log('=== 可见文本 ===')
console.log(await ev(`document.querySelector('.main-content')?.innerText`))
console.log('=== 圆心/按钮/背景 ===')
console.log(await ev(`(() => {
  const pick = (sel, d) => {
    const n = document.querySelector(sel)
    if (!n) return sel + ' 不存在'
    const s = getComputedStyle(n), r = n.getBoundingClientRect()
    return sel + ' [' + Math.round(r.width) + 'x' + Math.round(r.height) + '] bg=' + s.backgroundColor + ' bgImage=' + (s.backgroundImage||'').slice(0,80) + ' r=' + s.borderRadius + ' shadow=' + s.boxShadow + ' txt=' + (n.innerText||'').replace(/\\n/g,' ').slice(0,40)
  }
  const deep = (sel) => {
    const n = document.querySelector(sel)
    if (!n) return sel + ' 不存在'
    return [...n.querySelectorAll('*')].slice(0, 14).map(c => { const s = getComputedStyle(c), r = c.getBoundingClientRect(); return '  <' + c.tagName.toLowerCase() + '> ' + (typeof c.className === 'string' ? c.className : '') + ' [' + Math.round(r.width) + 'x' + Math.round(r.height) + '] bg=' + s.backgroundColor + ' r=' + s.borderRadius + ' shadow=' + s.boxShadow + ' txt=' + (c.innerText||'').trim().slice(0,20) }).join('\\n')
  }
  return ['.zen-page', '.zen-power-zone-wrap', '.zen-power-zone', '.zen-power-caption', '.zen-info', '.zen-port-chip', '.zen-empty-hint', '.zen-body', '.zen-header-title', '.zen-mode-switch-btn'].map(s => pick(s)).join('\\n') + '\\n-- 圆内结构 --\\n' + deep('.zen-power-zone-wrap')
})()`))

const { data } = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync('_recv/xt-zen3.png', Buffer.from(data, 'base64'))
console.log('已保存 _recv/xt-zen3.png')
ws.close()
process.exit(0)
