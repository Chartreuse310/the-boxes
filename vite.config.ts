import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  ensureIdsInFile,
  migrateTodo,
  reorderInFile,
  setTodoStateInFile,
  taskPath,
  touchDay,
  type TodoState,
} from './server/store'
import { parseTask } from './src/lib/parser'

/** 某日文件是否存在 */
async function dayExistsFor(dataDir: string, date: string): Promise<boolean> {
  try {
    await readFile(path.join(dataDir, 'inbox', `${date}.md`), 'utf8')
    return true
  } catch {
    return false
  }
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
 * 运行环境信息：数据目录 + 版本号。
 *
 * 版本号必须现读，不能硬编码在界面里 —— footer 原来写死 "SPEC v1.0"，
 * SPEC 升到 v1.2 后没人记得改，界面就开始说谎（style-guide v0.3.3 的成因）。
 */
async function readVersions(): Promise<{ version: string | null; specVersion: string | null }> {
  const read = async (rel: string): Promise<string | null> => {
    try {
      return await readFile(path.join(process.cwd(), rel), 'utf8')
    } catch {
      return null // 读不到就不显示，不报错
    }
  }
  const pkg = await read('package.json')
  const spec = await read('SPEC.md')
  let version: string | null = null
  if (pkg) {
    try {
      version = JSON.parse(pkg).version ?? null
    } catch {
      version = null
    }
  }
  return { version, specVersion: spec?.match(/SPEC v(\d+\.\d+(?:\.\d+)?)/)?.[1] ?? null }
}

/**
 * 开发期本地文件 API（M1 打包 Tauri 时由 Rust 侧实现同样的接口，界面代码不动）：
 *   GET /api/info        → { dataDir, home, version, specVersion } 运行环境信息
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

        // 任务名可含中文等非 ASCII 字符，浏览器 fetch 会 percent-encode，
        // 匹配路由前统一解码（解码失败则保留原文，交给 taskPath 校验拒绝）
        let pathname = (req.url ?? '/').split('?')[0]
        try {
          pathname = decodeURIComponent(pathname)
        } catch {
          /* 非法百分号序列：保留原文 */
        }

        // GET /api/info : 数据目录与版本。界面 footer 显示它们，值必须来自这里（不许硬编码）
        if (req.method === 'GET' && /^\/info\/?$/.test(pathname)) {
          readVersions().then((v) => send(200, { dataDir, home: process.env.HOME ?? '', ...v }))
          return
        }

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
            const file = path.join(dataDir, 'inbox', `${mt[1]}.md`)
            if (!(await dayExistsFor(dataDir, mt[1]))) await touchDay(dataDir, mt[1])
            await ensureIdsInFile(file)
            return { content: await readFile(file, 'utf8') }
          })
          return
        }

        // PUT /api/days/:date/todos/:id/state : 修改某 todo 状态（三态）
        const ms = pathname.match(/^\/days\/(\d{4}-\d{2}-\d{2})\/todos\/([a-z0-9]+)\/state$/)
        if (req.method === 'PUT' && ms) {
          handle(async () => {
            const body = await readBody()
            const state = String(body.state ?? '')
            const allowed = ['todo', 'doing', 'done']
            if (!allowed.includes(state)) throw new Error(`非法状态：${state}`)
            await setTodoStateInFile(path.join(dataDir, 'inbox', `${ms[1]}.md`), ms[2], state as TodoState)
            return { ok: true }
          })
          return
        }

        // PUT /api/days/:date/todos/:id/migrate : 迁移（SPEC v2.0 整行原样移动）
        // 源文件删行，目标日文件原样追加（文件不存在则创建）
        const mm = pathname.match(/^\/days\/(\d{4}-\d{2}-\d{2})\/todos\/([a-z0-9]+)\/migrate$/)
        if (req.method === 'PUT' && mm) {
          handle(async () => {
            const body = await readBody()
            const target = String(body.target ?? '')
            if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) throw new Error(`非法目标日期：${target}`)
            if (target === mm[1]) throw new Error('目标日期与源文件相同，无迁移意义')
            await migrateTodo(dataDir, mm[1], mm[2], target)
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
            await reorderInFile(path.join(dataDir, 'inbox', `${mr[1]}.md`), order)
            return { ok: true }
          })
          return
        }

        // —— 任务（tasks/ 目录，SPEC §5）——
        // GET /api/tasks : 任务列表（卡片用：名称 + 一句话简介 + 进度）
        if (req.method === 'GET' && /^\/tasks\/?$/.test(pathname)) {
          handle(async () => {
            let files: string[]
            try {
              files = await readdir(path.join(dataDir, 'tasks'))
            } catch {
              return [] // tasks/ 不存在 = 暂无任务
            }
            const tasks = await Promise.all(
              files
                .filter((f) => f.endsWith('.md'))
                .map(async (f) => {
                  const slug = f.replace(/\.md$/, '')
                  const meta = parseTask(await readFile(path.join(dataDir, 'tasks', f), 'utf8'))
                  return {
                    slug,
                    title: meta.title ?? slug,
                    goal: meta.goal,
                    status: meta.status,
                    created: meta.created,
                    total: meta.todos.length,
                    done: meta.todos.filter((t) => t.state === 'done').length,
                  }
                }),
            )
            // 提出日期新的在前；缺日期的按文件名排最后
            tasks.sort((a, b) => (b.created ?? '').localeCompare(a.created ?? '') || a.slug.localeCompare(b.slug))
            return tasks
          })
          return
        }

        // GET /api/tasks/:slug : 任务文件原文
        const tg = pathname.match(/^\/tasks\/([^/]+)$/)
        if (req.method === 'GET' && tg) {
          readFile(taskPath(dataDir, tg[1]), 'utf8')
            .then((content) => send(200, { slug: tg[1], content }))
            .catch(() => send(404, { error: 'not found' }))
          return
        }

        // PUT /api/tasks/:slug/ensure-ids : 给缺失 id 的 todo 补 `^xxxx`
        const te = pathname.match(/^\/tasks\/([^/]+)\/ensure-ids$/)
        if (req.method === 'PUT' && te) {
          handle(async () => {
            const file = taskPath(dataDir, te[1])
            await ensureIdsInFile(file)
            return { content: await readFile(file, 'utf8') }
          })
          return
        }

        // PUT /api/tasks/:slug/todos/:id/state : 修改任务内某 todo 状态（三态）
        const ts = pathname.match(/^\/tasks\/([^/]+)\/todos\/([a-z0-9]+)\/state$/)
        if (req.method === 'PUT' && ts) {
          handle(async () => {
            const body = await readBody()
            const state = String(body.state ?? '')
            const allowed = ['todo', 'doing', 'done']
            if (!allowed.includes(state)) throw new Error(`非法状态：${state}`)
            await setTodoStateInFile(taskPath(dataDir, ts[1]), ts[2], state as TodoState)
            return { ok: true }
          })
          return
        }

        // PUT /api/tasks/:slug/reorder : 按给定 id 顺序重排任务内 todo
        const tr = pathname.match(/^\/tasks\/([^/]+)\/reorder$/)
        if (req.method === 'PUT' && tr) {
          handle(async () => {
            const body = await readBody()
            const order = (body.order as string[]) ?? []
            await reorderInFile(taskPath(dataDir, tr[1]), order)
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
