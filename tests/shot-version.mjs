// 校验界面版本号显示，并截一张（已运行状态）图到 _recv\v110-final.png
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
function call(method, params = {}, timeout = 60000) {
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

const evaluate = async (expression) => (await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value

await sleep(1500)
console.log('sidebar:', (await evaluate('document.querySelector(".side")?.innerText || ""')).replace(/\n/g, ' | '))
await call('Emulation.setDeviceMetricsOverride', { width: 1180, height: 780, deviceScaleFactor: 1, mobile: false })
const shot = await call('Page.captureScreenshot', { format: 'png' })
mkdirSync('_recv', { recursive: true })
writeFileSync('_recv/v110-final.png', Buffer.from(shot.data, 'base64'))
console.log('saved _recv/v110-final.png')
ws.close()
