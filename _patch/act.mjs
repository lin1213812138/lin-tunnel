// 单步操作：node _patch/act.mjs <start|pause|resume|wait-url|text>
const cmd = process.argv[2]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const list = await (await fetch('http://127.0.0.1:9333/json/list')).json()
const page = list.find((x) => x.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))
let id = 0
const send = (expression) =>
  new Promise((resolve) => {
    const cid = ++id
    ws.addEventListener('message', function handler(e) {
      const m = JSON.parse(e.data)
      if (m.id === cid) {
        ws.removeEventListener('message', handler)
        resolve(m.result?.result?.value)
      }
    })
    ws.send(
      JSON.stringify({
        id: cid,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }),
    )
  })

const click = `(label) => {
  const buttons = [...document.querySelectorAll('.tunnel-card button')]
  const b = buttons.find((x) => x.textContent.trim() === label)
    || buttons.find((x) => x.textContent.trim().includes(label))
  if (!b) return 'NO_BUTTON:' + label
  b.click()
  return 'ok'
}`

if (cmd === 'text') {
  console.log(await send(`document.querySelector('.tunnel-card')?.innerText || ''`))
} else if (cmd === 'wait-url') {
  for (let i = 0; i < 90; i += 1) {
    const text = await send(`document.querySelector('.tunnel-card')?.innerText || ''`)
    const m = (text || '').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
    if (m) {
      console.log('URL', m[0])
      break
    }
    await sleep(1000)
  }
} else {
  const label = { start: '启动', pause: '暂停', resume: '继续', restart: '重启', stop: '停止' }[cmd]
  console.log(cmd, await send(`(${click})(${JSON.stringify(label)})`))
}
ws.close()
