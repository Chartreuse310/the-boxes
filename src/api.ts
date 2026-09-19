// API 层：界面只依赖这组接口（M1 打包 Tauri 时替换实现，界面代码不动）。
// 开发期实现：走 Vite 本地文件服务，见 vite.config.ts 的 boxesApi 插件。

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
  slug: string
  title: string
  goal: string | null
  status: string | null
  created: string | null
  total: number
  done: number
}

export interface RawTask {
  slug: string
  content: string
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
  /** 修改某 todo 状态（三态：todo / doing / done） */
  setState(date: string, id: string, state: string): Promise<void>
  /** 迁移（SPEC v2.0）：把该行原样移动到目标日文件，源文件删行 */
  migrate(date: string, id: string, target: string): Promise<void>
  /** 按给定 id 顺序重排该日 todo */
  reorder(date: string, order: string[]): Promise<void>
  /** 任务列表（卡片用摘要），按提出日期倒序 */
  listTasks(): Promise<TaskSummary[]>
  /** 读取某任务文件原文；文件不存在返回 null */
  getTask(slug: string): Promise<RawTask | null>
  /** 补齐任务文件缺失 id，返回最新原文 */
  taskEnsureIds(slug: string): Promise<string>
  /** 修改任务内某 todo 状态（三态） */
  taskSetState(slug: string, id: string, state: string): Promise<void>
  /** 按给定 id 顺序重排任务内 todo */
  taskReorder(slug: string, order: string[]): Promise<void>
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
  getTask: async (slug) => {
    const r = await fetch(`/api/tasks/${encodeURIComponent(slug)}`)
    if (!r.ok) return null
    return r.json()
  },
  taskEnsureIds: async (slug) => {
    const r = await fetch(`/api/tasks/${encodeURIComponent(slug)}/ensure-ids`, { method: 'PUT' })
    if (!r.ok) throw new Error(`taskEnsureIds 失败：${r.status} ${await r.text()}`)
    return (await r.json()).content
  },
  taskSetState: async (slug, id, state) => {
    const r = await fetch(`/api/tasks/${encodeURIComponent(slug)}/todos/${id}/state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state }),
    })
    if (!r.ok) throw new Error(`taskSetState 失败：${r.status} ${await r.text()}`)
  },
  taskReorder: async (slug, order) => {
    const r = await fetch(`/api/tasks/${encodeURIComponent(slug)}/reorder`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order }),
    })
    if (!r.ok) throw new Error(`taskReorder 失败：${r.status} ${await r.text()}`)
  },
}

export const api: BoxesApi = httpApi
