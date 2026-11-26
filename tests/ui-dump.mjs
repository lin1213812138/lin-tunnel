// 打印当前页面文本，便于排查 UI 状态。
const list = await (await fetch('http://127.0.0.1:9333/json/list')).json()
const page = list.find((item) => item.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
})
await new Promise((resolve) => ws.addEventListener('open', resolve))
const evaluate = (expression) =>
  new Promise((resolve) => {
    const callId = ++id
    pending.set(callId, (msg) => resolve(msg.result))
    ws.send(
      JSON.stringify({
        id: callId,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }),
    )
  })
const result = await evaluate('document.body.innerText')
console.log(result?.result?.value || '(empty)')
ws.close()
