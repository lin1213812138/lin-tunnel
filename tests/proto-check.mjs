// 验证「传输协议」设置真的传给了 cloudflared：建一条 http2 隧道后打印进程命令行
const list = await (await fetch('http://127.0.0.1:9333/json/list')).json()
const page = list.find((x) => x.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => {
  ws.addEventListener('open', r)
  ws.addEventListener('error', j)
})
let id = 0
function call(method, params = {}, timeout = 120000) {
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

const res = await evaluate(
  `window.__TAURI_INTERNALS__.invoke('start_tunnel', { name: 'http2 验证', port: 8080, protocol: 'http2' })`,
)
console.log('started', JSON.stringify({ id: res.id, status: res.status, target: res.target }))
await new Promise((r) => setTimeout(r, 9000))
ws.close()
