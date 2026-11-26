// 界面检查：node tests/zen-check.mjs start   点「一键穿透」并等公网地址
//           node tests/zen-check.mjs restore  重启后看列表是否恢复
const mode = process.argv[2] || 'start'

async function connect() {
  const list = await (await fetch('http://127.0.0.1:9333/json/list')).json()
  const page = list.find((x) => x.type === 'page' && x.url.includes('tauri.localhost'))
  if (!page) throw new Error('找不到应用页面')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => {
    ws.addEventListener('open', r)
    ws.addEventListener('error', j)
  })
  let id = 0
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const cid = ++id
      const timer = setTimeout(() => reject(new Error(method + ' timeout')), 60000)
      ws.addEventListener('message', function handler(e) {
        const m = JSON.parse(e.data)
        if (m.id !== cid) return
        clearTimeout(timer)
        ws.removeEventListener('message', handler)
        if (m.result?.exceptionDetails) reject(new Error(m.result.exceptionDetails.text || 'eval err'))
        else resolve(m.result)
      })
      ws.send(JSON.stringify({ id: cid, method, params }))
    })
  const ev = async (expr) =>
    (await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }))
      .result?.value
  return { ev, call, close: () => ws.close() }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const { ev, call, close } = await connect()

if (mode === 'start') {
  const clicked = await ev(`
    (() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.innerText.includes('一键穿透'))
      if (!btn) return 'NO_BUTTON'
      btn.click()
      return 'CLICKED'
    })()
  `)
  console.log('点击一键穿透:', clicked)
  let url = ''
  for (let i = 0; i < 90; i++) {
    await sleep(1000)
    url = await ev(`(document.querySelector('.tunnel-url')?.innerText || '').trim()`)
    if (/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(url)) break
    const err = await ev(`(document.querySelector('.tunnel-card')?.innerText || '').slice(0, 200)`)
    if (i % 10 === 0) console.log(`  ${i}s 卡片: ${err.replace(/\n/g, ' | ')}`)
  }
  console.log(url ? 'ZEN_OK ' + url : 'ZEN_FAIL 没拿到地址')
} else if (mode === 'modal') {
  await ev(`
    (() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.innerText.includes('新建隧道'))
      if (btn) btn.click()
    })()
  `)
  await sleep(600)
  const rect = await ev(`
    (() => {
      const box = [...document.querySelectorAll('.n-checkbox')].find((c) => c.innerText.includes('自己的域名'))
      if (!box) return null
      const r = box.getBoundingClientRect()
      return { x: r.x + 10, y: r.y + r.height / 2 }
    })()
  `)
  if (rect) {
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  }
  console.log('复选框坐标:', JSON.stringify(rect))
  await sleep(600)
  const fields = await ev(`document.body.innerText.includes('Tunnel Token') ? 'HAS_TOKEN_FIELD' : 'NO_TOKEN_FIELD'`)
  console.log('新建弹窗自带域名字段:', fields)
  const shot = await call('Page.captureScreenshot', { format: 'png' })
  const { writeFileSync } = await import('node:fs')
  writeFileSync('_recv/zen-named.png', Buffer.from(shot.data, 'base64'))
  console.log('截图: _recv/zen-named.png')
} else {
  const text = await ev(`(document.querySelector('.tunnel-grid')?.innerText || '').replace(/\\n+/g, ' | ')`)
  console.log('恢复后的列表:', text || '(空)')
  const named = await ev(`document.body.innerText.includes('自带域名') ? 'HAS_NAMED_TAG' : 'NO_NAMED_TAG'`)
  console.log('自带域名标记:', named)
  const zen = await ev(`document.body.innerText.includes('禅模式') ? 'HAS_ZEN' : 'NO_ZEN'`)
  console.log('禅模式卡片:', zen)
}
close()
