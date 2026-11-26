// 完整回归：新建 → 公网可达 → 暂停 → 继续 → 重启 → 修改 → 停止 → 启动
// 页面侧只装一组小工具函数，其余流程由 Node 逐步驱动，避免长表达式。
// Cloudflare quick tunnel 有频控（429 Tunnelstore request failed），
// 所以所有"需要新地址"的步骤都走 ensureRunning：遇到 429 就等一会点重试，直到拿到地址。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []

function record(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`)
}

async function publicGet(url, timeoutMs = 10000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' })
    const body = await res.text()
    return { ok: true, status: res.status, body: body.slice(0, 80) }
  } catch (err) {
    return { ok: false, error: err?.message || String(err) }
  }
}

// 地址刚分配时 DNS/边缘还没接好，轮询等待真正可访问。
async function waitPublic(url, timeoutMs = 90000) {
  const started = Date.now()
  let last = null
  while (Date.now() - started < timeoutMs) {
    last = await publicGet(url, 8000)
    if (last.ok && last.status === 200) return last
    await sleep(3000)
  }
  return last
}

const list = await (await fetch('http://127.0.0.1:9333/json/list')).json()
const page = list.find((x) => x.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => {
  ws.addEventListener('open', r)
  ws.addEventListener('error', j)
})

let msgId = 0
function evaluate(expression) {
  return new Promise((resolve, reject) => {
    const cid = ++msgId
    const timer = setTimeout(() => reject(new Error('CDP 超时')), 60000)
    ws.addEventListener('message', function handler(e) {
      const m = JSON.parse(e.data)
      if (m.id !== cid) return
      clearTimeout(timer)
      ws.removeEventListener('message', handler)
      if (m.result?.exceptionDetails) {
        reject(new Error(m.result.exceptionDetails.exception?.description || 'eval 异常'))
      } else {
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
}

const HELPERS = `
window.__h = {
  card: function () { return document.querySelector('.tunnel-card') },
  text: function () { const c = window.__h.card(); return c ? c.innerText : '' },
  click: function (label) {
    const list = Array.prototype.slice.call(document.querySelectorAll('.tunnel-card button'))
    const b = list.find(function (x) { return x.textContent.trim() === label })
      || list.find(function (x) { return x.textContent.trim().indexOf(label) >= 0 })
    if (!b) return 'NO_BUTTON:' + label
    b.click()
    return 'ok'
  },
  set: function (el, v) {
    const slot = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')
    slot.set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  },
  pageButton: function (text) {
    return Array.prototype.slice.call(document.querySelectorAll('button'))
      .find(function (b) { return b.textContent.indexOf(text) >= 0 })
  },
  openCreate: function () {
    const b = window.__h.pageButton('新建隧道')
    if (!b) return 'NO_CREATE'
    b.click()
    return 'ok'
  },
  fillCreate: function (name, port) {
    const m = document.querySelector('.n-modal')
    if (!m) return 'NO_MODAL'
    const inputs = Array.prototype.slice.call(m.querySelectorAll('input'))
    window.__h.set(inputs[0], name)
    window.__h.set(inputs[1], String(port))
    const submit = Array.prototype.slice.call(m.querySelectorAll('button'))
      .find(function (b) { return b.textContent.indexOf('建立隧道') >= 0 })
    if (!submit) return 'NO_SUBMIT'
    submit.click()
    return 'ok'
  },
  fillEdit: function (name, keepRunning) {
    const modals = Array.prototype.slice.call(document.querySelectorAll('.n-modal'))
    const m = modals.find(function (x) { return x.innerText.indexOf('修改隧道') >= 0 })
    if (!m) return 'NO_EDIT_MODAL'
    const inputs = Array.prototype.slice.call(m.querySelectorAll('input'))
    window.__h.set(inputs[0], name)
    const box = m.querySelector('.n-checkbox')
    if (box) {
      const checked = box.className.indexOf('n-checkbox--checked') >= 0
      if (checked !== keepRunning) box.click()
    }
    const save = Array.prototype.slice.call(m.querySelectorAll('button'))
      .find(function (b) { return b.textContent.indexOf('保存') >= 0 })
    if (!save) return 'NO_SAVE'
    save.click()
    return 'ok'
  },
}; 'helpers-ok'`

console.log('helpers', await evaluate(HELPERS))

await evaluate(`(() => {
  const nav = Array.prototype.slice.call(document.querySelectorAll('.nav-item'))
    .find(function (n) { return n.textContent.indexOf('隧道') >= 0 })
  if (nav) nav.click()
  return 'nav'
})()`)
await sleep(600)

const getUrl = (text) => (text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/) || [])[0] || ''

// 等到"运行中 + 有地址"；遇到 429/退出就点重试，直到预算耗尽。
async function ensureRunning(maxMs = 1200000) {
  const started = Date.now()
  while (Date.now() - started < maxMs) {
    const text = await evaluate('window.__h.text()')
    const url = getUrl(text)
    if (url && text.indexOf('运行中') >= 0) return url
    const failed = text.indexOf('429') >= 0 || text.indexOf('已退出') >= 0
    if (failed) {
      const label = text.indexOf('重试') >= 0 ? '重试' : '启动'
      console.log(`  429/退出，点「${label}」重试 at ${new Date().toISOString()}`)
      await evaluate(`window.__h.click('${label}')`)
      await sleep(90000)
      continue
    }
    await sleep(2000)
  }
  return ''
}

let existing = await evaluate('window.__h.text()')
let url = getUrl(existing)

if (!url) {
  console.log('create', await evaluate('window.__h.openCreate()'))
  await sleep(700)
  console.log('fill', await evaluate(`window.__h.fillCreate('回归验证', 8080)`))
  url = await ensureRunning()
}
record('新建隧道并拿到公网地址', Boolean(url), url)
if (!url) {
  console.log('DEBUG', JSON.stringify(await evaluate('window.__h.text()')))
  ws.close()
  process.exit(1)
}

let pub = await waitPublic(url)
record('公网可访问', pub.ok && pub.status === 200, JSON.stringify(pub))

console.log('pause', await evaluate(`window.__h.click('暂停')`))
await sleep(1500)
record('暂停后状态已暂停', (await evaluate('window.__h.text()')).indexOf('已暂停') >= 0)
pub = await publicGet(url, 8000)
record('暂停后公网不可达', !(pub.ok && pub.status === 200), JSON.stringify(pub))

console.log('resume', await evaluate(`window.__h.click('继续')`))
await sleep(2000)
record('继续后状态运行中', (await evaluate('window.__h.text()')).indexOf('运行中') >= 0)
pub = await waitPublic(url, 120000)
record('继续后公网恢复', pub.ok && pub.status === 200, JSON.stringify(pub))

console.log('restart', await evaluate(`window.__h.click('重启')`))
await sleep(1000)
const newUrl = await ensureRunning()
record('重启后分配新地址', Boolean(newUrl) && newUrl !== url, newUrl)
if (newUrl) {
  pub = await waitPublic(newUrl)
  record('重启后公网可访问', pub.ok && pub.status === 200, JSON.stringify(pub))
  url = newUrl
}

console.log('edit-open', await evaluate(`window.__h.click('修改')`))
await sleep(800)
console.log('edit-save', await evaluate(`window.__h.fillEdit('改名验证', false)`))
await sleep(1500)
record('修改名称生效', (await evaluate('window.__h.text()')).indexOf('改名验证') >= 0)

console.log('stop', await evaluate(`window.__h.click('停止')`))
await sleep(1500)
record('停止后状态已停止', (await evaluate('window.__h.text()')).indexOf('已停止') >= 0)

console.log('start', await evaluate(`window.__h.click('启动')`))
await sleep(1000)
const started = await ensureRunning()
record('停止后可重新启动', Boolean(started), started || (await evaluate('window.__h.text()')).replace(/\n/g, ' | ').slice(0, 200))
if (started) {
  pub = await waitPublic(started)
  record('重新启动后公网可访问', pub.ok && pub.status === 200, JSON.stringify(pub))
}

ws.close()
const failed = results.filter((r) => !r.ok)
console.log(failed.map((r) => 'FAILED: ' + r.name).join('\n'))
console.log(failed.length ? `RESULT_FAIL ${failed.length}/${results.length}` : 'RESULT_OK')
process.exit(failed.length ? 1 : 0)
