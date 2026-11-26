// 走界面路径验证测速：建一条隧道（429 自动重试）→ 点「测速」→ 等结果 → 截图
import { writeFileSync, mkdirSync } from 'node:fs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const list = await (await fetch('http://127.0.0.1:9333/json/list')).json()
const page = list.find((x) => x.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => {
  ws.addEventListener('open', r)
  ws.addEventListener('error', j)
})

let id = 0
function call(method, params = {}, timeout = 600000) {
  return new Promise((resolve, reject) => {
    const cid = ++id
    const timer = setTimeout(() => reject(new Error(method + ' 超时')), timeout)
    ws.addEventListener('message', function handler(e) {
      const m = JSON.parse(e.data)
      if (m.id !== cid) return
      clearTimeout(timer)
      ws.removeEventListener('message', handler)
      if (m.result?.exceptionDetails) reject(new Error(m.result.exceptionDetails.exception?.description || '异常'))
      else resolve(m.result)
    })
    ws.send(JSON.stringify({ id: cid, method, params }))
  })
}

const evaluate = async (expression) => {
  const res = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  return res.result?.value
}

const invoke = (cmd, args) => evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`)
const cardText = () => evaluate("document.querySelector('.tunnel-card')?.innerText || ''")

await sleep(1000)
const rows = await invoke('list_tunnels', {})
if (!rows.length) {
  console.log('start:', await invoke('start_tunnel', { name: '测速演示', port: 8080 }))
}

let body = ''
for (let i = 0; i < 90; i += 1) {
  await sleep(2000)
  body = await cardText()
  if (/https:\/\/[a-z0-9-]+\.trycloudflare\.com/.test(body) && body.includes('运行中')) break
  if (body.includes('429') || body.includes('已退出')) {
    console.log('429，重试', new Date().toISOString())
    await evaluate(`(() => {
      const b = Array.prototype.slice.call(document.querySelectorAll('.tunnel-card button'))
        .find(x => x.textContent.trim() === '重试' || x.textContent.trim() === '启动')
      if (b) b.click()
    })()`)
    await sleep(60000)
  }
}
console.log('card:', body.replace(/\n/g, ' | ').slice(0, 160))

const clicked = await evaluate(`(() => {
  const b = Array.prototype.slice.call(document.querySelectorAll('.tunnel-card button'))
    .find(x => x.textContent.trim() === '测速')
  if (!b) return 'NO_BENCH_BUTTON'
  b.click()
  return 'ok'
})()`)
console.log('click 测速:', clicked)

for (let i = 0; i < 180; i += 1) {
  await sleep(2000)
  const modal = await evaluate("document.querySelector('.n-modal')?.innerText || ''")
  if (modal.includes('中位数') && !modal.includes('打点')) {
    console.log('modal:', modal.replace(/\n/g, ' | ').slice(0, 300))
    break
  }
}

await call('Emulation.setDeviceMetricsOverride', { width: 1180, height: 780, deviceScaleFactor: 1, mobile: false })
const shot = await call('Page.captureScreenshot', { format: 'png' })
mkdirSync('_recv', { recursive: true })
writeFileSync('_recv/v111-bench.png', Buffer.from(shot.data, 'base64'))
console.log('saved _recv/v111-bench.png')
ws.close()
