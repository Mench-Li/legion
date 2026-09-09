/**
 * P1-3 fixture control plugin (file-URL injected into the fixture profile).
 * Provides two control surfaces on the real host webserver:
 *   GET  /__p13/ready     → 200 once the tree is up (used to poll boot completion)
 *   POST /__p13/shutdown  → graceful bounded shutdown via ctx.appExit.exit(0)
 *                          (the same channel a one-shot surface uses; disposes
 *                          the whole tree incl. legion plugins' teardowns).
 * @module p13-control
 */

export const name = 'p13-control'

export const inject = ['webServer', 'appExit']

export function apply(ctx) {
  ctx.webServer.register({
    kind: 'exact',
    path: '/__p13/ready',
    handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, pid: process.pid, name }))
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/__p13/shutdown',
    handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, shuttingDown: true }))
      // Let the response flush before the bounded shutdown starts disposing.
      setTimeout(() => {
        try {
          ctx.appExit(0)
        } catch (error) {
          process.exitCode = 1
          console.error('[p13-control] appExit failed', error)
          throw error
        }
      }, 50)
    },
  })
}
