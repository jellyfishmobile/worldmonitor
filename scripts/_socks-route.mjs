// scripts/_socks-route.mjs  (stonebridge fork — not upstream)
//
// Preloaded via NODE_OPTIONS="--import" into every seeder node process. Routes
// ONLY the hosts in SOCKS_PROXY_HOSTS through a SOCKS5 proxy (SOCKS_PROXY_URL);
// everything else (Binance, *.railway.internal, …) stays DIRECT. Fixes the
// datacenter-IP blocks on GDELT (429) and UCDP (401). Fail-safe: any setup
// error leaves global fetch untouched so the seeder never breaks.
import net from 'node:net'
import tls from 'node:tls'

const PROXY = process.env.SOCKS_PROXY_URL || ''
const HOSTS = (process.env.SOCKS_PROXY_HOSTS || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)

if (PROXY && HOSTS.length) {
  try {
    const pu = new URL(PROXY) // socks5://user:pass@host:port
    const proxyHost = pu.hostname
    const proxyPort = Number(pu.port) || 1080
    const user = decodeURIComponent(pu.username || '')
    const pass = decodeURIComponent(pu.password || '')
    const matches = (host) => { const h = String(host).toLowerCase(); return HOSTS.some((t) => h === t || h.endsWith('.' + t)) }

    // Establish a SOCKS5 tunnel to destHost:destPort (domain ATYP, user/pass or none).
    const socks5Connect = (destHost, destPort) => new Promise((resolve, reject) => {
      const s = net.connect(proxyPort, proxyHost)
      let stage = 'greet'
      let buf = Buffer.alloc(0)
      const fail = (m) => { try { s.destroy() } catch {} reject(new Error(m)) }
      const sendConnect = () => {
        const h = Buffer.from(destHost, 'ascii')
        s.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, h.length]), h, Buffer.from([(destPort >> 8) & 0xff, destPort & 0xff])]))
        stage = 'reply'
      }
      s.once('error', (e) => fail(`socks tcp: ${e.message}`))
      s.setTimeout(15_000, () => fail('socks timeout'))
      s.once('connect', () => {
        const methods = user ? [0x00, 0x02] : [0x00]
        s.write(Buffer.from([0x05, methods.length, ...methods]))
      })
      s.on('data', (d) => {
        buf = Buffer.concat([buf, d])
        if (stage === 'greet') {
          if (buf.length < 2) return
          if (buf[0] !== 0x05) return fail('bad socks version')
          const method = buf[1]; buf = buf.subarray(2)
          if (method === 0x02) { const u = Buffer.from(user, 'utf8'); const p = Buffer.from(pass, 'utf8'); s.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p])); stage = 'auth' }
          else if (method === 0x00) sendConnect()
          else return fail('socks: no acceptable auth method')
        }
        if (stage === 'auth') {
          if (buf.length < 2) return
          if (buf[1] !== 0x00) return fail('socks auth failed')
          buf = buf.subarray(2); sendConnect()
        }
        if (stage === 'reply') {
          if (buf.length < 4) return
          if (buf[1] !== 0x00) return fail(`socks connect rejected (rep=${buf[1]})`)
          const atyp = buf[3]
          const total = atyp === 0x01 ? 10 : atyp === 0x04 ? 22 : atyp === 0x03 ? 4 + 1 + buf[4] + 2 : 0
          if (!total || buf.length < total) return
          buf = buf.subarray(total) // consume full reply; any leftover belongs to the tunnel
          s.setTimeout(0)
          s.removeAllListeners('data')
          stage = 'done'
          if (buf.length) s.unshift(buf)
          resolve(s)
        }
      })
    })

    const { Agent } = await import('undici')
    const proxyDispatcher = new Agent({
      connect(opts, cb) {
        const port = Number(opts.port) || (opts.protocol === 'http:' ? 80 : 443)
        socks5Connect(opts.hostname, port).then((raw) => {
          if (opts.protocol === 'http:') { cb(null, raw); return }
          const tlsSock = tls.connect({ socket: raw, servername: opts.servername || opts.hostname, host: opts.hostname, port })
          tlsSock.once('secureConnect', () => cb(null, tlsSock))
          tlsSock.once('error', (e) => cb(e, null))
        }).catch((e) => cb(e, null))
      },
    })

    const origFetch = globalThis.fetch
    globalThis.fetch = (input, init = {}) => {
      let url
      try { url = new URL(typeof input === 'string' ? input : (input && input.url) || String(input)) } catch { return origFetch(input, init) }
      if (!matches(url.hostname)) return origFetch(input, init)
      return origFetch(input, { ...init, dispatcher: proxyDispatcher })
    }
    console.log(`[socks-route] proxying ${HOSTS.join(', ')} via ${proxyHost}:${proxyPort}`)
  } catch (e) {
    console.warn(`[socks-route] disabled (setup failed): ${e?.message ?? e}`)
  }
}
