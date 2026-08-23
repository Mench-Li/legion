// smoke-static.mjs — 冒烟：起服务并抓取静态资源与 /healthz，验证 200 与 MIME。
import { spawn } from 'node:child_process';

const PORT = 18421;
const child = spawn(process.execPath, ['apps/server/src/index.js'], {
  cwd: new URL('..', import.meta.url).pathname.slice(1),
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DB_PATH: ':memory:' },
  stdio: 'ignore',
});

const paths = ['/', '/styles.css', '/js/main.mjs', '/js/renderer.mjs', '/shared/crdt.mjs', '/healthz'];

setTimeout(async () => {
  try {
    for (const p of paths) {
      const r = await fetch(`http://127.0.0.1:${PORT}${p}`);
      console.log(`${p} -> ${r.status} ${r.headers.get('content-type') || ''}`);
    }
  } catch (e) {
    console.error('ERROR', e.message);
  } finally {
    child.kill('SIGKILL');
  }
}, 900);
