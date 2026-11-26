// 验证暂停/继续/重启/修改/停止/启动 六个操作（WebView2 CDP 驱动真实界面）。
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function connect() {
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
  return { ws, evaluate }
}

const HELPERS = `window.__ui = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  card: () => document.querySelector('.tunnel-card'),
  buttons: () => [...document.querySelectorAll('.tunnel-card button')],
  click: (text) => {
    const b = window.__ui.buttons().find((x) => x.textContent.trim() === text)
      || window.__ui.buttons().find((x) => x.textContent.trim().includes(text))
    if (!b) return 'NO_BUTTON:' + text
    b.click()
    return 'clicked:' + text
  },
  setValue: (el, value) => {
    const slot = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')
    slot.set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  },
  text: () => window.__ui.card()?.innerText || '',
}; 'ok'`

async function waitFor(evaluate, predicate, label, timeoutMs = 45000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const res = await evaluate('window.__ui.text()')
    const text = res.result?.value || ''
    if (predicate(text)) return text
    await sleep(1000)
  }
  const dump = await evaluate('window.__ui.text()')
  throw new Error(`${label} 超时：${(dump.result?.value || '').replace(/\n+/g, ' | ').slice(0, 400)}`)
}

async function main() {
  const { ws, evaluate } = await connect()
  await evaluate(HELPERS)

  // 切到隧道页，没有隧道就建一条。
  await evaluate(`(async () => {
    [...document.querySelectorAll('.nav-item')].find((n) => n.textContent.includes('隧道'))?.click()
    await window.__ui.sleep(600)
    if (!window.__ui.card()) {
      [...document.querySelectorAll('button')].find((b) => b.textContent.includes('新建隧道'))?.click()
      await window.__ui.sleep(700)
      const modal = document.querySelector('.n-modal')
      const inputs = [...modal.querySelectorAll('input')]
      window.__ui.setValue(inputs[0], '操作验证')
      window.__ui.setValue(inputs[1], '8080')
      await window.__ui.sleep(300)
      ;[...modal.querySelectorAll('button')].find((b) => b.textContent.includes('建立隧道'))?.click()
    }
    return 'ready'
  })()`)

  await waitFor(evaluate, (t) => /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.test(t), '初始公网地址', 90000)
  const first = (await evaluate(`window.__ui.text().match(/https:\\/\\/[a-z0-9-]+\\.trycloudflare\\.com/)?.[0] || ''`)).result?.value
  console.log('STEP 1 ready', first)

  // 暂停
  console.log('click', (await evaluate(`window.__ui.click('暂停')`)).result?.value)
  await waitFor(evaluate, (t) => t.includes('已暂停'), '暂停')
  console.log('STEP 2 paused ok')

  // 继续
  console.log('click', (await evaluate(`window.__ui.click('继续')`)).result?.value)
  await waitFor(evaluate, (t) => t.includes('运行中'), '继续')
  console.log('STEP 3 resumed ok')

  // 重启（应重新分配地址）
  console.log('click', (await evaluate(`window.__ui.click('重启')`)).result?.value)
  await waitFor(evaluate, (t) => /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.test(t) && !t.includes('已暂停'), '重启后地址', 90000)
  console.log('STEP 4 restarted ok')

  // 修改名称
  console.log('click', (await evaluate(`window.__ui.click('修改')`)).result?.value)
  await sleep(700)
  console.log(
    'edit',
    (await evaluate(`(() => {
      const modal = [...document.querySelectorAll('.n-modal')].find((m) => m.innerText.includes('修改隧道'))
      if (!modal) return 'NO_EDIT_MODAL'
      const inputs = [...modal.querySelectorAll('input')]
      window.__ui.setValue(inputs[0], '改名验证')
      const restart = modal.querySelector('.n-checkbox')
      if (restart && !restart.classList.contains('n-checkbox--checked')) restart.click()
      ;[...modal.querySelectorAll('button')].find((b) => b.textContent.includes('保存'))?.click()
      return 'saved'
    })()`)).result?.value,
  )
  await waitFor(evaluate, (t) => t.includes('改名验证'), '改名', 90000)
  console.log('STEP 5 edited ok')

  // 停止 → 启动
  console.log('click', (await evaluate(`window.__ui.click('停止')`)).result?.value)
  await waitFor(evaluate, (t) => t.includes('已停止'), '停止')
  console.log('STEP 6 stopped ok')
  console.log('click', (await evaluate(`window.__ui.click('启动')`)).result?.value)
  await waitFor(evaluate, (t) => /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.test(t) && t.includes('运行中'), '重新启动', 90000)
  console.log('STEP 7 started again ok')

  const final = (await evaluate('window.__ui.text()')).result?.value || ''
  console.log('FINAL_URL', final.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0] || 'none')
  console.log('CONTROLS_OK')
  ws.close()
}

main().catch((err) => {
  console.error('CONTROLS_FAIL', err.message)
  process.exit(1)
})
