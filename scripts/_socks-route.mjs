// scripts/_socks-route.mjs  (stonebridge fork — not upstream)
//
// Preloaded via NODE_OPTIONS="--import" into every seeder node process. Routes
// ONLY the hosts in SOCKS_PROXY_HOSTS through a SOCKS5 proxy (SOCKS_PROXY_URL);
// everything else (Binance, *.railway.internal, …) stays DIRECT. Fixes the
// datacenter-IP blocks on GDELT (429) and UCDP (401). Fail-safe: any setup
// error leaves global fetch untouched so the seeder never breaks.
import net from 'node:net'
import tls from 'node:tls'
import dns from 'node:dns/promises'

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

    // Establish a SOCKS5 tunnel to destHost:destPort. The proxy has NO DNS —
    // resolve to IPv4 client-side and send ATYP=0x01 (domain ATYP is rejected
    // with REP=1). TLS SNI keeps the original hostname (done by the caller).
    const socks5Connect = (destIp, destPort) => new Promise((resolve, reject) => {
      const s = net.connect(proxyPort, proxyHost)
      let stage = 'greet'
      let buf = Buffer.alloc(0)
      const fail = (m) => { try { s.destroy() } catch {} reject(new Error(m)) }
      const sendConnect = () => {
        const octets = destIp.split('.').map((n) => Number(n) & 0xff)
        s.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x01, ...octets]), Buffer.from([(destPort >> 8) & 0xff, destPort & 0xff])]))
        stage = 'reply'
      }
      s.once('error', (e) => fail(`socks tcp: ${e.message}`))
      s.setTimeout(6_000, () => fail('socks timeout'))
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

    // Use the INSTALLED undici's own fetch for proxied requests — Node's global
    // fetch (its bundled undici) rejects a dispatcher from a different undici
    // version ("invalid onRequestStart method"). Agent + fetch from the same
    // package are compatible; direct requests keep Node's global fetch.
    // The proxy fronts a pool of routers, some flaky (transient rep=1 / connect
    // fail / timeout). A fresh TCP connection likely lands on a DIFFERENT router,
    // so retry-with-backoff hits a healthy one — the right client posture (the
    // proxy has no quota; failures are reliability, not limits).
    const socks5ConnectRetry = async (ip, port, attempts = 4) => {
      let lastErr
      for (let i = 0; i < attempts; i++) {
        try { return await socks5Connect(ip, port) }
        catch (e) { lastErr = e; if (i < attempts - 1) await new Promise((r) => setTimeout(r, 300 * (2 ** i))) }
      }
      throw lastErr
    }

    const { Agent, fetch: undiciFetch } = await import('undici')
    const proxyDispatcher = new Agent({
      connect(opts, cb) {
        const port = Number(opts.port) || (opts.protocol === 'http:' ? 80 : 443)
        const resolveIp = /^\d+\.\d+\.\d+\.\d+$/.test(opts.hostname)
          ? Promise.resolve(opts.hostname)
          : dns.resolve4(opts.hostname).then((ips) => { if (!ips.length) throw new Error('no A record'); return ips[0] })
        resolveIp.then((ip) => socks5ConnectRetry(ip, port)).then((raw) => {
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
      return undiciFetch(input, { ...init, dispatcher: proxyDispatcher })
    }
    console.log(`[socks-route] proxying ${HOSTS.join(', ')} via ${proxyHost}:${proxyPort}`)
  } catch (e) {
    console.warn(`[socks-route] disabled (setup failed): ${e?.message ?? e}`)
  }
}
