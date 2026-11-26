// 只读观察 X Tunnel 的界面：文本、脚本资源、localStorage 键名、网络请求列表
const list = await (await fetch('http://127.0.0.1:9444/json/list')).json()
const page = list.find((x) => x.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => {
  ws.addEventListener('open', r)
  ws.addEventListener('error', j)
})
let id = 0
function call(method, params = {}, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const cid = ++id
    const timer = setTimeout(() => reject(new Error(method + ' timeout')), timeout)
    ws.addEventListener('message', function handler(e) {
      const m = JSON.parse(e.data)
      if (m.id !== cid) return
      clearTimeout(timer)
      ws.removeEventListener('message', handler)
      if (m.result?.exceptionDetails) reject(new Error(m.result.exceptionDetails.exception?.description || 'err'))
      else resolve(m.result)
    })
    ws.send(JSON.stringify({ id: cid, method, params }))
  })
}
const ev = async (expr) => (await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.value

console.log('URL:', page.url)
console.log('--- 界面文本 ---')
console.log(await ev('document.body.innerText'))

console.log('--- 脚本资源 ---')
console.log(await ev('performance.getEntriesByType("resource").map(r=>r.name).join("\\n")'))

console.log('--- localStorage ---')
console.log(await ev('Object.keys(localStorage).map(k=>k+" = "+String(localStorage.getItem(k)).slice(0,120)).join("\\n")'))

console.log('--- 元素骨架 ---')
console.log(await ev(`Array.from(document.querySelectorAll('[class]')).slice(0, 40).map(e=>e.tagName+"."+e.className).join("\\n")`))

ws.close()
