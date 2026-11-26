import http from 'node:http'

const port = Number(process.argv[2] || 8080)
http
  .createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('lin-tunnel smoke ok')
  })
  .listen(port, '127.0.0.1', () => console.log(`up on ${port}`))
