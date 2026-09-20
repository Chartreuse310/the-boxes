// API 层：界面只依赖这组接口（M1 打包 Tauri 时替换实现，界面代码不动）。
// 开发期实现：走 Vite 本地文件服务，见 vite.config.ts 的 boxesApi 插件。

import type { Todo } from './lib/parser'

export interface RawDay {
  date: string
  content: string
}

/** 运行环境信息。footer 用它显示数据目录与版本，界面里不存这两个值。 */
export interface BoxesInfo {
  /** 实际生效的数据目录（绝对路径） */
  dataDir: string
  /** 用户主目录，供界面把 dataDir 缩写成 ~/… */
  home: string
  /** 软件版本，来自 package.json */
  version: string | null
  /** 数据格式版本，来自 SPEC.md */
  specVersion: string | null
}

/** 任务卡片的摘要信息（GET /api/tasks） */
export interface TaskSummary {
  /** 提出月份（YYYY-MM），任务文件所在的 tasks/ 子目录名 */
  month: string
  slug: string
  title: string
  goal: string | null
  status: string | null
  created: string | null
}

export interface RawTask {
  month: string
  slug: string
  content: string
}

/** todo 的来源文件：day = inbox 日期文件，task = 任务文件（month 目录 + slug 文件名） */
export type TodoSource =
  | { kind: 'day'; date: string }
  | { kind: 'task'; month: string; slug: string }

/** 平铺视图的 todo：解析结果 + 来源（点击/迁移按来源分叉调接口） */
export interface SourcedTodo extends Todo {
  source: TodoSource
}

export interface BoxesApi {
  /** 运行环境信息（数据目录、版本） */
  info(): Promise<BoxesInfo>
  /** 有记录的日期列表，倒序（最新在前） */
  listDays(): Promise<string[]>
  /** 读取某日 inbox 的原文 markdown；文件不存在返回 null */
  getDay(date: string): Promise<RawDay | null>
  /** 确保某日文件存在（无则创建空文件）并补齐缺失 id；返回最新原文 */
  ensureIds(date: string): Promise<string>
  /**
   * 添加一条 todo 到某日 inbox（界面输入框回车）。text 可含行内 `@日期` / `+任务`
   * （SPEC §4），由服务端归入规范 token 并生成 id。返回新行 id。
   */
  addTodo(date: string, text: string): Promise<string>
  /** 修改某 todo 状态（三态：todo / doing / done） */
  setState(date: string, id: string, state: string): Promise<void>
  /** 迁移（SPEC v2.0）：把该行原样移动到目标日文件，源文件删行 */
  migrate(date: string, id: string, target: string): Promise<void>
  /** 按给定 id 顺序重排该日 todo */
  reorder(date: string, order: string[]): Promise<void>
  /** 任务列表（卡片用摘要），按提出日期倒序 */
  listTasks(): Promise<TaskSummary[]>
  /** 读取某任务文件原文；文件不存在返回 null */
  getTask(month: string, slug: string): Promise<RawTask | null>
  /** 补齐任务文件缺失 id，返回最新原文 */
  taskEnsureIds(month: string, slug: string): Promise<string>
  /**
   * 向任务文件添加一条 todo（界面输入框 `@任务` 路由 / 创建任务）。
   * 任务文件不存在则服务端按 SPEC §5 建骨架。归属由所在文件决定，行只带 `^id`。
   */
  addTaskTodo(month: string, slug: string, text: string): Promise<string>
  /** 修改任务内某 todo 状态（三态） */
  taskSetState(month: string, slug: string, id: string, state: string): Promise<void>
  /** 按给定 id 顺序重排任务内 todo */
  taskReorder(month: string, slug: string, order: string[]): Promise<void>
  /** 平铺视图：全部 todo（inbox 日期倒序在前，任务按提出日倒序在后），各附来源 */
  listAll(): Promise<SourcedTodo[]>
  /** 订阅数据目录变更（SSE）…… */
  subscribe(onChange: () => void): () => void
  /** 示例是否仍在（决定「清空示例」按钮显隐） */
  getOnboarding(): Promise<{ present: boolean; files: string[] }>
  /** 清空上手示例（删示例文件、标记已处理，下次开不再自动铺） */
  clearOnboarding(): Promise<void>
  /**
   * 编辑一行 todo（双击行 → 内联编辑器保存）。
   * patch.text 改正文；start/done 改 @start/@done（`null` 清除，`undefined` 不动，状态由时间派生）；
   * target 改所在文件，与来源不同即整行移动过去。
   */
  editTodo(
    source: TodoSource,
    id: string,
    patch: { text?: string; start?: string | null; done?: string | null; target?: TodoSource },
  ): Promise<void>
  /** 软删除：把整行移进 trash/<今天>.md（拖进底部垃圾箱）。数据仍在文件里，可打开找回。 */
  trashTodo(source: TodoSource, id: string): Promise<void>
}

const httpApi: BoxesApi = {
  info: async () => {
    const r = await fetch('/api/info')
    if (!r.ok) throw new Error(`info 失败：${r.status}`)
    return r.json()
  },
  listDays: async () => {
    const r = await fetch('/api/days')
    if (!r.ok) throw new Error(`listDays 失败：${r.status}`)
    return r.json()
  },
  getDay: async (date) => {
    const r = await fetch(`/api/days/${date}`)
    if (!r.ok) return null
    return r.json()
  },
  ensureIds: async (date) => {
    const r = await fetch(`/api/days/${date}/ensure-ids`, { method: 'PUT' })
    if (!r.ok) throw new Error(`ensureIds 失败：${r.status} ${await r.text()}`)
    return (await r.json()).content
  },
  addTodo: async (date, text) => {
    const r = await fetch(`/api/days/${date}/todos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    if (!r.ok) throw new Error(`addTodo 失败：${r.status} ${await r.text()}`)
    return (await r.json()).id
  },
  setState: async (date, id, state) => {
    const r = await fetch(`/api/days/${date}/todos/${id}/state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state }),
    })
    if (!r.ok) throw new Error(`setState 失败：${r.status} ${await r.text()}`)
  },
  migrate: async (date, id, target) => {
    const r = await fetch(`/api/days/${date}/todos/${id}/migrate`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target }),
    })
    if (!r.ok) throw new Error(`migrate 失败：${r.status} ${await r.text()}`)
  },
  reorder: async (date, order) => {
    const r = await fetch(`/api/days/${date}/reorder`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order }),
    })
    if (!r.ok) throw new Error(`reorder 失败：${r.status} ${await r.text()}`)
  },
  listTasks: async () => {
    const r = await fetch('/api/tasks')
    if (!r.ok) throw new Error(`listTasks 失败：${r.status}`)
    return r.json()
  },
  getTask: async (month, slug) => {
    const r = await fetch(`/api/tasks/${month}/${encodeURIComponent(slug)}`)
    if (!r.ok) return null
    return r.json()
  },
  taskEnsureIds: async (month, slug) => {
    const r = await fetch(`/api/tasks/${month}/${encodeURIComponent(slug)}/ensure-ids`, {
      method: 'PUT',
    })
    if (!r.ok) throw new Error(`taskEnsureIds 失败：${r.status} ${await r.text()}`)
    return (await r.json()).content
  },
  addTaskTodo: async (month, slug, text) => {
    const r = await fetch(`/api/tasks/${month}/${encodeURIComponent(slug)}/todos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    if (!r.ok) throw new Error(`addTaskTodo 失败：${r.status} ${await r.text()}`)
    return (await r.json()).id
  },
  taskSetState: async (month, slug, id, state) => {
    const r = await fetch(`/api/tasks/${month}/${encodeURIComponent(slug)}/todos/${id}/state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state }),
    })
    if (!r.ok) throw new Error(`taskSetState 失败：${r.status} ${await r.text()}`)
  },
  taskReorder: async (month, slug, order) => {
    const r = await fetch(`/api/tasks/${month}/${encodeURIComponent(slug)}/reorder`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order }),
    })
    if (!r.ok) throw new Error(`taskReorder 失败：${r.status} ${await r.text()}`)
  },
  listAll: async () => {
    const r = await fetch('/api/all')
    if (!r.ok) throw new Error(`listAll 失败：${r.status}`)
    return (await r.json()).todos
  },
  subscribe: (onChange) => {
    const es = new EventSource('/api/events')
    es.onmessage = () => onChange()
    // 连接错误不处理：EventSource 会按 retry 自动重连，恢复后即恢复刷新
    return () => es.close()
  },
  getOnboarding: async () => {
    const r = await fetch('/api/onboarding')
    if (!r.ok) throw new Error(`getOnboarding 失败：${r.status}`)
    return r.json()
  },
  clearOnboarding: async () => {
    const r = await fetch('/api/onboarding/clear', { method: 'POST' })
    if (!r.ok) throw new Error(`clearOnboarding 失败：${r.status} ${await r.text()}`)
  },
  editTodo: async (source, id, patch) => {
    const r = await fetch('/api/todos/edit', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, id, ...patch }),
    })
    if (!r.ok) throw new Error(`editTodo 失败：${r.status} ${await r.text()}`)
  },
  trashTodo: async (source, id) => {
    const r = await fetch('/api/todos/trash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, id }),
    })
    if (!r.ok) throw new Error(`trashTodo 失败：${r.status} ${await r.text()}`)
  },
}

export const api: BoxesApi = httpApi
