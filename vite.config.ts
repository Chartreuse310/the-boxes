import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * 数据目录：默认 ~/the-boxes（SPEC §3），可用环境变量 BOXES_DATA_DIR 覆盖。
 */
const DATA_DIR = process.env.BOXES_DATA_DIR
  ? path.resolve(process.env.BOXES_DATA_DIR)
  : path.join(process.env.HOME ?? '.', 'the-boxes')

/**
 * 开发期本地文件 API（M1 打包 Tauri 时由 Rust 侧实现同样的接口，界面代码不动）：
 *   GET /api/days        → ["2026-09-19", ...] 有记录的日期，倒序
 *   GET /api/days/:date  → { date, content } 该日 inbox 的原文 markdown
 *
 * 只读、仅本机；日期参数经过正则校验，防止路径穿越。
 */
function boxesApi(): Plugin {
  return {
    name: 'boxes-dev-api',
    configureServer(server) {
      server.middlewares.use('/api', (req, res) => {
        const send = (code: number, body: unknown) => {
          res.statusCode = code
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify(body))
        }

        const pathname = (req.url ?? '/').split('?')[0]

        if (req.method === 'GET' && /^\/days\/?$/.test(pathname)) {
          readdir(path.join(DATA_DIR, 'inbox'))
            .then((files) => {
              const days = files
                .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
                .map((f) => f.replace(/\.md$/, ''))
                .sort()
                .reverse()
              send(200, days)
            })
            .catch(() => send(200, [])) // inbox 目录不存在时视为无记录
          return
        }

        const m = pathname.match(/^\/days\/(\d{4}-\d{2}-\d{2})$/)
        if (req.method === 'GET' && m) {
          readFile(path.join(DATA_DIR, 'inbox', `${m[1]}.md`), 'utf8')
            .then((content) => send(200, { date: m[1], content }))
            .catch(() => send(404, { error: 'not found' }))
          return
        }

        send(404, { error: 'not found' })
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), boxesApi()],
})
