// 展开侧栏 → 点「禅模式」→ 截图 + 打印禅模式主区结构
import { writeFileSync } from 'node:fs'

const list = await (await fetch('http://127.0.0.1:9444/json/list')).json()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const waiting = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  const cb = waiting.get(m.id)
  if (cb) {
    waiting.delete(m.id)
    m.error ? cb.reject(new Error(m.error.message)) : cb.resolve(m.result)
  }
})
const send = (method, params = {}) => {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((res, rej) => waiting.set(id, { resolve: res, reject: rej }))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
await send('Runtime.enable')
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })).result?.value

await ev(`document.querySelector('.n-layout-toggle-button')?.click()`)
await sleep(700)
console.log('侧栏宽度', await ev(`document.querySelector('.n-layout-sider')?.getBoundingClientRect().width`))
console.log('菜单文本', await ev(`[...document.querySelectorAll('.n-menu-item, .nav-item, [class*=menu-item]')].map(n=>n.innerText.replace(/\\n/g,' ')).join(' | ')`))

const clicked = await ev(`(() => {
  const nodes = [...document.querySelectorAll('*')].filter(n => n.childElementCount === 0 && (n.innerText||'').trim() === '禅模式')
  const el = nodes[nodes.length-1]
  if (!el) return false
  el.click(); return el.tagName + '.' + el.className
})()`)
console.log('点击', clicked)
await sleep(1500)

console.log('=== 主区文本 ===')
console.log(await ev(`document.querySelector('.main-content')?.innerText`))
console.log('=== 主区结构 ===')
console.log(await ev(`(() => {
  const walk = (n, d) => d > 7 ? '' : [...n.children].map(c => {
    const r = c.getBoundingClientRect(), s = getComputedStyle(c)
    return '  '.repeat(d) + '<' + c.tagName.toLowerCase() + '> ' + (typeof c.className === 'string' ? c.className : '') +
      ' [' + Math.round(r.width) + 'x' + Math.round(r.height) + ']' +
      ' bg=' + s.backgroundColor + ' r=' + s.borderRadius + ' fs=' + s.fontSize + ' fw=' + s.fontWeight + ' c=' + s.color +
      (c.childElementCount ? '\\n' + walk(c, d+1) : ' txt=' + (c.innerText||'').trim().slice(0,40))
  }).join('\\n')
  return walk(document.querySelector('.main-content'), 0)
})()`))

const { data } = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync('_recv/xt-zen2.png', Buffer.from(data, 'base64'))
console.log('已保存 _recv/xt-zen2.png')
ws.close()
process.exit(0)
