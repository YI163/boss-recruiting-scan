// 把 127.0.0.1:3080 的 TCP 流量转发到 127.0.0.1:7775，
// 让硬编码了 3080 的 dsh 浏览器助手扩展能连上当前 DSH 的 /ext/bridge。
import net from 'node:net'

const LISTEN = Number(process.env.FWD_LISTEN || 3080)
const TARGET = Number(process.env.FWD_TARGET || 7775)

const server = net.createServer((client) => {
  const upstream = net.connect(TARGET, '127.0.0.1')
  const teardown = () => {
    client.destroy()
    upstream.destroy()
  }
  upstream.on('connect', () => {
    client.pipe(upstream)
    upstream.pipe(client)
  })
  client.on('error', teardown)
  upstream.on('error', teardown)
  client.on('close', teardown)
  upstream.on('close', teardown)
})

server.listen(LISTEN, '127.0.0.1', () => {
  console.log(`forwarding 127.0.0.1:${LISTEN} -> 127.0.0.1:${TARGET}`)
})
