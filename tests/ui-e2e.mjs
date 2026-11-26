// 通过 WebView2 CDP 驱动界面，做一次从「新建隧道」到拿到公网地址的端到端验证。
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  const list = await (await fetch('http://127.0.0.1:9333/json/list')).json()
  const page = list.find((item) => item.type === 'page')
  if (!page) throw new Error('没有找到页面')
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

  const step1 = await evaluate(`(() => {
    const buttons = [...document.querySelectorAll('button')].map((b) => b.textContent.trim())
    return JSON.stringify({ nav: [...document.querySelectorAll('.nav-item')].map((n) => n.textContent.trim()), buttons })
  })()`)
  console.log('STEP1', step1.result?.value)

  const step2 = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const byText = (text) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim().includes(text))
    const setValue = (el, value) => {
      const slot = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')
      slot.set.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }
    byText('新建隧道')?.click()
    await sleep(600)
    const modal = document.querySelector('.n-modal')
    const inputs = [...modal.querySelectorAll('input')]
    setValue(inputs[0], 'E2E 测试')
    setValue(inputs[1], '8080')
    await sleep(300)
    byText('建立隧道')?.click()
    await sleep(4000)
    return JSON.stringify({
      inputs: inputs.length,
      body: document.body.innerText.replace(/\\n+/g, ' | ').slice(0, 900),
    })
  })()`)
  console.log('STEP2', step2.result?.value ?? JSON.stringify(step2))
  ws.close()
}

main().catch((err) => {
  console.error('E2E_FAIL', err.message)
  process.exit(1)
})
