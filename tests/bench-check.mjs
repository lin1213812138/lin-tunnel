// 直接调后端测速命令，验证 quic/http2 的 TTFB 采样是否可用。
const list = await (await fetch('http://127.0.0.1:9333/json/list')).json()
const page = list.find((x) => x.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => {
  ws.addEventListener('open', r)
  ws.addEventListener('error', j)
})

let id = 0
function call(method, params = {}, timeout = 240000) {
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

const expression = `window.__TAURI_INTERNALS__.invoke('bench_protocols', { port: 8080, rounds: 2 })`
const started = Date.now()
const res = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
const value = res.result?.value
console.log('elapsed', Math.round((Date.now() - started) / 1000) + 's')
console.log(JSON.stringify(value, null, 2))
ws.close()
