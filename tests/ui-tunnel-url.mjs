// 在运行中的客户端里创建一条隧道，轮询到公网地址后把 URL 打印出来（供 curl 验证）。
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
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
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', reject)
  })
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

  const created = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const nav = [...document.querySelectorAll('.nav-item')].find((n) => n.textContent.includes('隧道'))
    nav?.click()
    await sleep(500)
    const byText = (text) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim().includes(text))
    const setValue = (el, value) => {
      const slot = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')
      slot.set.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }
    const create = byText('新建隧道')
    if (!create) return 'NO_CREATE_BUTTON'
    create.click()
    await sleep(700)
    const modal = document.querySelector('.n-modal')
    if (!modal) return 'NO_MODAL'
    const inputs = [...modal.querySelectorAll('input')]
    setValue(inputs[0], '公网验证')
    setValue(inputs[1], '8080')
    await sleep(300)
    byText('建立隧道')?.click()
    return 'created'
  })()`)
  const createdValue = created.result?.value
  if (createdValue !== 'created') throw new Error(`创建失败：${createdValue}`)

  for (let i = 0; i < 90; i += 1) {
    await sleep(1000)
    const text = await evaluate("document.querySelector('.tunnel-url')?.textContent || ''")
    const match = (text.result?.value || '').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
    if (match) {
      console.log('URL', match[0])
      ws.close()
      return
    }
  }
  const dump = await evaluate('document.body.innerText')
  console.error('TIMEOUT_STATE', (dump.result?.value || '').replace(/\n+/g, ' | ').slice(0, 600))
  throw new Error('90 秒内没有拿到公网地址')
}

main().catch((err) => {
  console.error('E2E_FAIL', err.message)
  process.exit(1)
})
