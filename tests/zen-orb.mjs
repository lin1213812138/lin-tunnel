// 点禅模式的大圆按钮，等出公网地址，然后截图
import { writeFileSync } from 'node:fs'

const list = await (await fetch('http://127.0.0.1:9333/json/list')).json()
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

await ev(`[...document.querySelectorAll('.nav-item')].find(n => n.innerText.includes('禅模式'))?.click()`)
await sleep(800)
console.log('点圆按钮', await ev(`(() => { const b = document.querySelector('.zen-orb'); if (!b) return 'no-orb'; b.click(); return 'ok' })()`))

let last = ''
for (let i = 0; i < 40; i++) {
  await sleep(2000)
  const state = await ev(`({ caption: document.querySelector('.zen-caption')?.innerText || '', url: document.querySelector('.zen-url')?.innerText || '', hint: document.querySelector('.zen-hint')?.innerText || '' })`)
  const line = `${i * 2}s ${state.caption} ${state.url}`
  if (line.slice(4) !== last) { console.log(line); last = line.slice(4) }
  if (state.url) break
}

const { data } = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync('_recv/zen2.png', Buffer.from(data, 'base64'))
console.log('已保存 _recv/zen2.png')
ws.close()
process.exit(0)
