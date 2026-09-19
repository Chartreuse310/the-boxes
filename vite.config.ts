import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  ensureIds,
  ensureInboxDir,
  reorder,
  setState,
  type TodoState,
} from './server/store'

/** 某日文件是否存在 */
async function dayExistsFor(dataDir: string, date: string): Promise<boolean> {
  try {
    await readFile(path.join(dataDir, 'inbox', `${date}.md`), 'utf8')
    return true
  } catch {
    return false
  }
}

/** 某日文件不存在时，生成空文件（含标题 + 空行占位） */
async function touchDay(dataDir: string, date: string): Promise<void> {
  await ensureInboxDir(dataDir)
  await writeFile(path.join(dataDir, 'inbox', `${date}.md`), `# ${date}\n\n`)
}

/**
 * 数据目录的解析优先级（由高到低）：
 *   1. 环境变量 BOXES_DATA_DIR
 *   2. 仓库根目录 .env 里的 BOXES_DATA_DIR
 *   3. 默认 ~/the-boxes
 *
 * 普通用户建议直接在仓库根目录建 .env，写一行 BOXES_DATA_DIR=你要的路径，
 * 不必配置 shell 环境变量。详见 README「自定义数据目录」。
 */
function resolveDataDir(mode: string): string {
  const env = loadEnv(mode, process.cwd(), '')
  const fromEnv = process.env.BOXES_DATA_DIR ?? env.BOXES_DATA_DIR
  if (fromEnv) return path.resolve(fromEnv)
  return path.join(process.env.HOME ?? '.', 'the-boxes')
}

/**
 * 开发期本地文件 API（M1 打包 Tauri 时由 Rust 侧实现同样的接口，界面代码不动）：
 *   GET /api/days        → ["2026-09-19", ...] 有记录的日期，倒序
 *   GET /api/days/:date  → { date, content } 该日 inbox 的原文 markdown
 *
 * 只读、仅本机；日期参数经过正则校验，防止路径穿越。
 */
function boxesApi(dataDir: string): Plugin {
  return {
    name: 'boxes-dev-api',
    configureServer(server) {
      server.middlewares.use('/api', (req, res) => {
        const send = (code: number, body: unknown) => {
          res.statusCode = code
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify(body))
        }
        // 读取 JSON 请求体
        const readBody = (): Promise<Record<string, unknown>> =>
          new Promise((resolve, reject) => {
            let raw = ''
            req.on('data', (c) => (raw += c))
            req.on('end', () => {
              try {
                resolve(raw ? JSON.parse(raw) : {})
              } catch {
                reject(new Error('请求体不是合法 JSON'))
              }
            })
            req.on('error', reject)
          })
        const handle = async (fn: () => Promise<unknown>) => {
          try {
            send(200, await fn())
          } catch (e) {
            send(400, { error: e instanceof Error ? e.message : '失败' })
          }
        }

        const pathname = (req.url ?? '/').split('?')[0]

        if (req.method === 'GET' && /^\/days\/?$/.test(pathname)) {
          readdir(path.join(dataDir, 'inbox'))
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
          readFile(path.join(dataDir, 'inbox', `${m[1]}.md`), 'utf8')
            .then((content) => send(200, { date: m[1], content }))
            .catch(() => send(404, { error: 'not found' }))
          return
        }

        // —— 写操作 ——
        // PUT /api/days/:date/ensure-ids : 给缺失 id 的 todo 补 `^xxxx`
        const mt = pathname.match(/^\/days\/(\d{4}-\d{2}-\d{2})\/ensure-ids$/)
        if (req.method === 'PUT' && mt) {
          handle(async () => {
            if (!(await dayExistsFor(dataDir, mt[1]))) await touchDay(dataDir, mt[1])
            await ensureIds(dataDir, mt[1])
            const content = await readFile(path.join(dataDir, 'inbox', `${mt[1]}.md`), 'utf8')
            return { content }
          })
          return
        }

        // PUT /api/days/:date/todos/:id/state : 修改某 todo 状态
        const ms = pathname.match(/^\/days\/(\d{4}-\d{2}-\d{2})\/todos\/([a-z0-9]+)\/state$/)
        if (req.method === 'PUT' && ms) {
          handle(async () => {
            const body = await readBody()
            const state = String(body.state ?? '')
            const allowed = ['todo', 'doing', 'done', 'deferred', 'scheduled']
            if (!allowed.includes(state)) throw new Error(`非法状态：${state}`)
            await setState(dataDir, ms[1], ms[2], state as TodoState)
            return { ok: true }
          })
          return
        }

        // PUT /api/days/:date/reorder : 按给定 id 顺序重排
        const mr = pathname.match(/^\/days\/(\d{4}-\d{2}-\d{2})\/reorder$/)
        if (req.method === 'PUT' && mr) {
          handle(async () => {
            const body = await readBody()
            const order = (body.order as string[]) ?? []
            await reorder(dataDir, mr[1], order)
            return { ok: true }
          })
          return
        }

        send(404, { error: 'not found' })
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const dataDir = resolveDataDir(mode)
  return {
    plugins: [react(), boxesApi(dataDir)],
  }
})
