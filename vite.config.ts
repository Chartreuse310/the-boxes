import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { readdir, readFile } from 'node:fs/promises'
import { watch as fsWatch, mkdirSync, type Dirent } from 'node:fs'
import type { ServerResponse } from 'node:http'
import path from 'node:path'
import {
  addTaskTodo,
  addTodo,
  clearOnboarding,
  emptyTrash,
  getOnboarding,
  listTrash,
  reorderInFile,
  seedOnboardingIfEmpty,
  taskPath,
  trashTodo,
  updateTodo,
  type TodoSourceRef,
} from './server/store'
import { parseInbox, parseTask } from './src/lib/parser'

/**
 * 掃描 tasks/YYYY-MM/ 下全部任務文件（SPEC v2.2：任務按提出月份嵌套，防重名）。
 * 只認 YYYY-MM 形態的子目錄，其餘原樣跳過（容錯：不算錯誤）。
 * 排序：提出日期新的在前；缺日期的按文件名排最後。
 */
async function readAllTasks(
  dataDir: string,
): Promise<{ month: string; slug: string; meta: ReturnType<typeof parseTask> }[]> {
  const out: { month: string; slug: string; meta: ReturnType<typeof parseTask> }[] = []
  let months: Dirent[]
  try {
    months = await readdir(path.join(dataDir, 'tasks'), { withFileTypes: true })
  } catch {
    return out // tasks/ 不存在 = 暫無任務
  }
  for (const d of months) {
    if (!d.isDirectory() || !/^\d{4}-\d{2}$/.test(d.name)) continue
    const files = await readdir(path.join(dataDir, 'tasks', d.name))
    for (const f of files.filter((x) => x.endsWith('.md'))) {
      const slug = f.replace(/\.md$/, '')
      const meta = parseTask(await readFile(path.join(dataDir, 'tasks', d.name, f), 'utf8'))
      out.push({ month: d.name, slug, meta })
    }
  }
  out.sort(
    (a, b) =>
      (b.meta.created ?? '').localeCompare(a.meta.created ?? '') || a.slug.localeCompare(b.slug),
  )
  return out
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
 *   GET /api/events      → SSE 文件变更流（数据目录改动即推 `changed`，界面自动刷新）
 *   GET /api/onboarding  → { present, files } 示例是否仍在；POST /api/onboarding/clear 清空示例
 *
 * 开发期读写、仅本机；日期/路径参数经过正则校验，防止路径穿越。打包 Tauri 时由 Rust 侧实现同名接口。
 */
function boxesApi(dataDir: string): Plugin {
  // SSE 客户端集合：数据目录一变（含本应用自己的写盘）就去抖广播一次，界面据此刷新（北极星：外部改动→刷新 ≤2s）
  const sseClients = new Set<ServerResponse>()
  return {
    name: 'boxes-dev-api',
    async configureServer(server) {
      // 空目录首次打开 → 铺一份自解释的示例数据（有数据/已处理过则跳过）。await 保证首个请求即见示例，
      // 避开前端时序竞态；打包 Tauri 时改由 Rust 侧在启动时做同样的事。
      await seedOnboardingIfEmpty(dataDir).catch(() => {})
      // 文件监听：递归 watch 数据目录，150ms 去抖后通知所有 SSE 客户端。
      // 目录可能尚不存在（用户第一次跑）→ 先建；不支持递归或 watch 抛错时降级为「无自动刷新」，不崩。
      let timer: ReturnType<typeof setTimeout> | null = null
      let watcher: ReturnType<typeof fsWatch> | null = null
      try {
        mkdirSync(dataDir, { recursive: true })
        watcher = fsWatch(dataDir, { recursive: true }, () => {
          if (timer) return
          timer = setTimeout(() => {
            timer = null
            for (const res of sseClients) {
              try {
                res.write('data: changed\n\n')
              } catch {
                sseClients.delete(res)
              }
            }
          }, 150)
        })
      } catch {
        watcher = null // 环境不支持监听：界面仍可手动刷新，仅失去自动
      }
      server.httpServer?.on('close', () => {
        watcher?.close()
        if (timer) clearTimeout(timer)
        for (const res of sseClients) res.end()
        sseClients.clear()
      })

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

        // GET /api/events : SSE 文件变更流。连接保持打开，数据目录一变就收到 `data: changed`，界面据此刷新。
        if (req.method === 'GET' && /^\/events\/?$/.test(pathname)) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
          })
          res.write('retry: 1000\n\n')
          sseClients.add(res)
          req.on('close', () => sseClients.delete(res))
          return
        }

        // GET /api/onboarding : 示例是否仍在（决定「清空示例」按钮显隐）。
        if (req.method === 'GET' && /^\/onboarding\/?$/.test(pathname)) {
          handle(() => getOnboarding(dataDir))
          return
        }

        // POST /api/onboarding/clear : 删示例文件、置空标记（下次开不再自动铺）。
        if (req.method === 'POST' && /^\/onboarding\/clear$/.test(pathname)) {
          handle(async () => {
            await clearOnboarding(dataDir)
            return { ok: true }
          })
          return
        }

        // GET /api/trash : 列出 trash/ 里的软删除行（垃圾箱视图）
        if (req.method === 'GET' && /^\/trash\/?$/.test(pathname)) {
          handle(() => listTrash(dataDir))
          return
        }

        // POST /api/trash/empty : 彻底清空垃圾箱（删 trash/ 下按日文件，不可再恢复）
        if (req.method === 'POST' && /^\/trash\/empty$/.test(pathname)) {
          handle(async () => {
            await emptyTrash(dataDir)
            return { ok: true }
          })
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

        // POST /api/days/:date/todos : 添加一条 todo（界面输入框回车，SPEC §4 行内语法）
        // 落该日文件末尾；文件不存在则创建；正文里 @日期 / +任务 归入规范 token。
        const ma = pathname.match(/^\/days\/(\d{4}-\d{2}-\d{2})\/todos$/)
        if (req.method === 'POST' && ma) {
          handle(async () => {
            const body = await readBody()
            const text = String(body.text ?? '')
            const { id } = await addTodo(dataDir, ma[1], text)
            return { ok: true, id }
          })
          return
        }

        // PUT /api/todos/edit : 编辑一行（双击行 → 内联编辑器保存）
        // body = { source, id, text?, start?, done?, target? }；start/done 传 null 清除、缺省不动。
        // source/target 为 {kind:'day',date} 或 {kind:'task',month,slug}；target 与 source 不同即整行移动。
        if (req.method === 'PUT' && /^\/todos\/edit$/.test(pathname)) {
          handle(async () => {
            const b = await readBody()
            const src = b.source as TodoSourceRef | undefined
            const id = String(b.id ?? '')
            if (!src || !id) throw new Error('缺少 source 或 id')
            const patch: { text?: string; start?: string | null; done?: string | null; target?: TodoSourceRef } = {}
            if ('text' in b) patch.text = String(b.text ?? '')
            if ('start' in b) patch.start = b.start == null ? null : String(b.start)
            if ('done' in b) patch.done = b.done == null ? null : String(b.done)
            if (b.target) patch.target = b.target as TodoSourceRef
            await updateTodo(dataDir, src, id, patch)
            return { ok: true }
          })
          return
        }

        // POST /api/todos/trash : 软删除——把整行移进 trash/<今天>.md（拖进底部垃圾箱）
        if (req.method === 'POST' && /^\/todos\/trash$/.test(pathname)) {
          handle(async () => {
            const b = await readBody()
            const src = b.source as TodoSourceRef | undefined
            const id = String(b.id ?? '')
            if (!src || !id) throw new Error('缺少 source 或 id')
            await trashTodo(dataDir, src, id)
            return { ok: true }
          })
          return
        }

        // —— 写操作 ——
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

        // —— 全部平铺（默认视图）——
        // GET /api/all : 所有文件的 todo，各附来源（day:date / task:month+slug）。
        // 顺序：inbox 日期倒序在前（最新一天最先），任务按提出日倒序在后。
        // 前端按来源分组渲染，组头直接显示来源文件名称。
        if (req.method === 'GET' && /^\/all\/?$/.test(pathname)) {
          handle(async () => {
            const out: Record<string, unknown>[] = []
            let dayFiles: string[] = []
            try {
              dayFiles = await readdir(path.join(dataDir, 'inbox'))
            } catch {
              /* inbox 目录不存在 = 无日期记录 */
            }
            const dates = dayFiles.filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().reverse()
            for (const f of dates) {
              const date = f.replace(/\.md$/, '')
              const todos = parseInbox(await readFile(path.join(dataDir, 'inbox', f), 'utf8'))
              for (const t of todos) out.push({ ...t, source: { kind: 'day', date } })
            }
            for (const tk of await readAllTasks(dataDir)) {
              for (const t of tk.meta.todos) {
                out.push({ ...t, source: { kind: 'task', month: tk.month, slug: tk.slug } })
              }
            }
            return { todos: out }
          })
          return
        }

        // —— 任务（tasks/YYYY-MM/ 目录，SPEC §5）——
        // GET /api/tasks : 任务列表（卡片用：名称 + 月份 + 一句话简介）
        if (req.method === 'GET' && /^\/tasks\/?$/.test(pathname)) {
          handle(async () => {
            const list = await readAllTasks(dataDir)
            return list.map(({ month, slug, meta }) => ({
              month,
              slug,
              title: meta.title ?? slug,
              goal: meta.goal,
              status: meta.status,
              created: meta.created,
            }))
          })
          return
        }

        // GET /api/tasks/:month/:slug : 任务文件原文
        const tg = pathname.match(/^\/tasks\/(\d{4}-\d{2})\/([^/]+)$/)
        if (req.method === 'GET' && tg) {
          readFile(taskPath(dataDir, tg[1], tg[2]), 'utf8')
            .then((content) => send(200, { month: tg[1], slug: tg[2], content }))
            .catch(() => send(404, { error: 'not found' }))
          return
        }

        // POST /api/tasks/:month/:slug/todos : 向任务添加 todo（界面输入框 @任务 路由 / 创建任务）
        // 文件缺失则按 SPEC §5 建骨架再写入；归属由所在文件决定，行只带 ^id。
        const at = pathname.match(/^\/tasks\/(\d{4}-\d{2})\/([^/]+)\/todos$/)
        if (req.method === 'POST' && at) {
          handle(async () => {
            const body = await readBody()
            const text = String(body.text ?? '')
            const { id } = await addTaskTodo(dataDir, at[1], at[2], text)
            return { ok: true, id }
          })
          return
        }

        // PUT /api/tasks/:month/:slug/reorder : 按给定 id 顺序重排任务内 todo
        const tr = pathname.match(/^\/tasks\/(\d{4}-\d{2})\/([^/]+)\/reorder$/)
        if (req.method === 'PUT' && tr) {
          handle(async () => {
            const body = await readBody()
            const order = (body.order as string[]) ?? []
            await reorderInFile(taskPath(dataDir, tr[1], tr[2]), order)
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
