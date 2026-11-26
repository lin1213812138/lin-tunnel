(async () => {
  const list = await (await fetch('http://127.0.0.1:9333/json/list')).json()
  const page = list.find((x) => x.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r))
  let id = 0
  const send = (expr) => new Promise((resolve) => {
    const cid = ++id
    ws.addEventListener('message', function h(e) {
      const m = JSON.parse(e.data)
      if (m.id === cid) { ws.removeEventListener('message', h); resolve(m.result) }
    })
    ws.send(JSON.stringify({ id: cid, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }))
  })
  const tunnelId = (await send(`document.querySelector('.tunnel-card') ? 'yes' : 'no'`)).result.value
  const out = await send(`(async () => { const r = await window.__TAURI_INTERNALS__.invoke('list_tunnels'); const t = r[0]; const logs = t ? await window.__TAURI_INTERNALS__.invoke('tunnel_logs', { id: t.id }) : []; return JSON.stringify({ t, tail: logs.slice(-8) }) })()`)
  ws.close()
  console.log(tunnelId, out.result.value)
})()
