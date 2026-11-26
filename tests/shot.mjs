// 截图工具：连接 WebView2 的 CDP，对当前界面截图，可先点击某个菜单。
// 用法：node tests/shot.mjs <输出png> [菜单文字...]
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const out = resolve(process.argv[2] || '_recv/ui.png')
const menus = process.argv.slice(3)

const list = await (await fetch('http://127.0.0.1:9333/json/list')).json()
const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
if (!page) {
  console.error('没找到页面，CDP 列表：', list.map((t) => t.url))
  process.exit(2)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const waiting = new Map()

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  const cb = waiting.get(msg.id)
  if (cb) {
    waiting.delete(msg.id)
    msg.error ? cb.reject(new Error(msg.error.message)) : cb.resolve(msg.result)
  }
})

function send(method, params = {}) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }))
}

await new Promise((r) => ws.addEventListener('open', r, { once: true }))
await send('Runtime.enable')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const evaluate = async (expr) => {
  const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  return res.result?.value
}

for (const label of menus) {
  const ok = await evaluate(`(() => {
    const el = [...document.querySelectorAll('.nav-item')].find((n) => n.innerText.includes(${JSON.stringify(label)}))
    if (!el) return false
    el.click()
    return true
  })()`)
  console.log(ok ? `已切换到「${label}」` : `没找到菜单「${label}」`)
  await sleep(700)
}

await sleep(400)
const { data } = await send('Page.captureScreenshot', { format: 'png' })
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, Buffer.from(data, 'base64'))
console.log('已保存', out)
ws.close()
process.exit(0)
