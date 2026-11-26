// 观察 X Tunnel 的「禅模式」界面：点击入口 → 截图 + 打印文本与结构
import { writeFileSync } from 'node:fs'

const list = await (await fetch('http://127.0.0.1:9444/json/list')).json()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const waiting = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
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
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  return r.result?.value
}

console.log('=== 当前页面文本 ===')
console.log(await ev('document.body.innerText'))

// 找出所有含「禅」的元素
console.log(
  '=== 含禅字的元素 ===',
  JSON.stringify(
    await ev(`[...document.querySelectorAll('*')].filter(n => n.childElementCount===0 && n.innerText && n.innerText.includes('禅')).map(n => ({tag:n.tagName, cls:n.className, txt:n.innerText.trim().slice(0,40)}))`),
    null,
    1,
  ),
)

const clicked = await ev(`(() => {
  const el = [...document.querySelectorAll('*')].find(n => (n.innerText||'').trim() === '禅模式' || (n.getAttribute && (n.getAttribute('aria-label')||'').includes('禅')))
  if (!el) return false
  el.click()
  return el.tagName + '.' + el.className
})()`)
console.log('=== 点击结果 ===', clicked)
await sleep(1500)

console.log('=== 点击后文本 ===')
console.log(await ev('document.body.innerText'))
console.log('=== 结构 ===')
console.log(await ev(`(() => {
  const walk = (n, d) => d > 6 ? '' : [...n.children].map(c => {
    const s = getComputedStyle(c)
    return '  '.repeat(d) + '<' + c.tagName.toLowerCase() + '> ' + (typeof c.className === 'string' ? c.className : '') +
      ' [' + Math.round(c.getBoundingClientRect().width) + 'x' + Math.round(c.getBoundingClientRect().height) + ']' +
      ' bg=' + s.backgroundColor + ' r=' + s.borderRadius + ' fs=' + s.fontSize + (c.childElementCount ? '\\n' + walk(c, d+1) : '')
  }).join('\\n')
  return walk(document.getElementById('app') || document.body, 0)
})()`))

const { data } = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync('_recv/xt-zen.png', Buffer.from(data, 'base64'))
console.log('已保存 _recv/xt-zen.png')
ws.close()
process.exit(0)
