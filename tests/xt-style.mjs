// 抽取 X Tunnel 的视觉参数：颜色、字体、尺寸 + 截图
const list = await (await fetch('http://127.0.0.1:9444/json/list')).json()
const page = list.find((x) => x.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => {
  ws.addEventListener('open', r)
  ws.addEventListener('error', j)
})
let id = 0
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const cid = ++id
    const timer = setTimeout(() => reject(new Error(method + ' timeout')), 30000)
    ws.addEventListener('message', function handler(e) {
      const m = JSON.parse(e.data)
      if (m.id !== cid) return
      clearTimeout(timer)
      ws.removeEventListener('message', handler)
      resolve(m.result)
    })
    ws.send(JSON.stringify({ id: cid, method, params }))
  })
const ev = async (expr) =>
  (await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }))
    .result?.value

const probe = `
(() => {
  const pick = (el, props) => {
    if (!el) return null
    const cs = getComputedStyle(el)
    const out = { tag: el.tagName, cls: (el.className || '').toString().slice(0, 90) }
    for (const p of props) out[p] = cs.getPropertyValue(p)
    const r = el.getBoundingClientRect()
    out.box = [Math.round(r.width), Math.round(r.height)]
    return out
  }
  const body = getComputedStyle(document.body)
  const root = getComputedStyle(document.documentElement)
  const vars = {}
  for (const sheet of document.styleSheets) {
    let rules
    try { rules = sheet.cssRules } catch { continue }
    for (const rule of rules) {
      if (rule.style && rule.selectorText && /:root|n-config-provider|body/.test(rule.selectorText)) {
        for (const name of rule.style) {
          if (/color|font|radius|shadow/i.test(name) && rule.style.getPropertyValue(name).trim()) {
            vars[name] = rule.style.getPropertyValue(name).trim()
          }
        }
      }
    }
  }
  return {
    body: { bg: body.backgroundColor, color: body.color, font: body.fontFamily, size: body.fontSize, line: body.lineHeight },
    appShell: pick(document.querySelector('.app-shell'), ['background','background-color','display','grid-template-columns']),
    sider: pick(document.querySelector('.sidebar, .n-layout-sider'), ['background-color','border-right','width','box-shadow']),
    brand: pick(document.querySelector('.brand'), ['height','padding','border-bottom']),
    menuItem: pick(document.querySelector('.n-menu-item'), ['height','font-size','color','border-radius','margin']),
    menuItemSelected: pick(document.querySelector('.n-menu-item-content--selected'), ['background-color','color','border-radius']),
    title: pick(document.querySelector('h1, h2, .page-title'), ['font-size','font-weight','color','margin']),
    card: pick(document.querySelector('.n-card'), ['background-color','border-radius','box-shadow','border']),
    table: pick(document.querySelector('.n-data-table'), ['background-color','border-radius','font-size']),
    th: pick(document.querySelector('th'), ['background-color','color','font-weight','padding','font-size']),
    td: pick(document.querySelector('td'), ['color','padding','font-size','border-bottom']),
    button: pick(document.querySelector('.n-button--primary-type'), ['background-color','color','border-radius','height','font-size']),
    cssVars: vars
  }
})()
`
console.log(JSON.stringify(await ev(probe), null, 1))

const shot = await call('Page.captureScreenshot', { format: 'png' })
const { writeFileSync } = await import('node:fs')
writeFileSync('_recv/xt-design.png', Buffer.from(shot.data, 'base64'))
console.log('截图: _recv/xt-design.png')
ws.close()
