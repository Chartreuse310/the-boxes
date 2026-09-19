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

export interface BoxesApi {
  /** 运行环境信息（数据目录、版本） */
  info(): Promise<BoxesInfo>
  /** 有记录的日期列表，倒序（最新在前） */
  listDays(): Promise<string[]>
  /** 读取某日 inbox 的原文 markdown；文件不存在返回 null */
  getDay(date: string): Promise<RawDay | null>
  /** 确保某日文件存在（无则创建空文件）并补齐缺失 id；返回最新原文 */
  ensureIds(date: string): Promise<string>
  /** 修改某 todo 状态；migrateDate 用于迁移 [>]今天/[<]所选日 */
  setState(date: string, id: string, state: string, migrateDate?: string): Promise<void>
  /** 按给定 id 顺序重排该日 todo */
  reorder(date: string, order: string[]): Promise<void>
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
  setState: async (date, id, state, migrateDate) => {
    const r = await fetch(`/api/days/${date}/todos/${id}/state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, migrateDate }),
    })
    if (!r.ok) throw new Error(`setState 失败：${r.status} ${await r.text()}`)
  },
  reorder: async (date, order) => {
    const r = await fetch(`/api/days/${date}/reorder`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order }),
    })
    if (!r.ok) throw new Error(`reorder 失败：${r.status} ${await r.text()}`)
  },
}

export const api: BoxesApi = httpApi
