// 服务端存储逻辑：编辑/排序 todo 行（Node 侧，不进入前端 bundle）。
// 定位策略：按行尾 `^id` 精确定位；手写行无 id 时，先 ensureIds 补齐。
// 容错规则（SPEC §7）：非 todo 行原样保留，绝不重写无关内容。

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

export type TodoState = 'todo' | 'doing' | 'done' | 'deferred' | 'scheduled'

const STATE_CHAR: Record<TodoState, string> = {
  todo: ' ',
  doing: '/',
  done: 'x',
  deferred: '>',
  scheduled: '<',
}

// 单行 todo 正则：`- [状态] 文本 ... [^id]`
const LINE_RE = /^(-\s\[)([ x/<>])(\].*?)(\s\^[a-z0-9]+)?$/i
// 从整行里取 id（` ^xxxx`：前面有空白；id 为字母数字，遇空白/行尾停止）
const ID_RE = /(\s|^)\^([a-z0-9]+)/i

function inboxPath(dataDir: string, date: string): string {
  return path.join(dataDir, 'inbox', `${date}.md`)
}

/** 给无 id 的 todo 行补齐 `^xxxx`，写回文件 */
export async function ensureIds(dataDir: string, date: string): Promise<void> {
  const file = inboxPath(dataDir, date)
  const content = await readFile(file, 'utf8')
  const lines = content.split('\n')
  const existing = new Set<string>()
  for (const raw of lines) {
    const m = raw.match(ID_RE)
    if (m) existing.add(m[2])
  }

  let dirty = false
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (!LINE_RE.test(raw)) continue
    const m = raw.match(ID_RE)
    if (m) continue
    let id: string
    do {
      id = randomId()
    } while (existing.has(id))
    existing.add(id)
    lines[i] = raw.trimEnd() + ` ^${id}`
    dirty = true
  }

  if (dirty) await writeFile(file, lines.join('\n'))
}

/**
 * 修改某 id 的行状态。
 * - done：写 @done:今天；清除普通 @日期（完成即不再迁移）
 * - 迁移（deferred=[>] 今天 / scheduled=[<] 所选日）：清除旧 @日期，写 @migrateDate
 * - 三态中的 todo/doing：清除 @done 与 @日期（回到待处理）
 */
export async function setState(
  dataDir: string,
  date: string,
  id: string,
  state: TodoState,
  migrateDate?: string,
): Promise<void> {
  const file = inboxPath(dataDir, date)
  const content = await readFile(file, 'utf8')
  const lines = content.split('\n')
  const ch = STATE_CHAR[state]

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const idM = raw.match(ID_RE)
    if (!idM || idM[2] !== id) continue
    // 替换状态符号：- [ ] → - [x]
    lines[i] = raw.replace(/^(-\s\[)([ x/<>])(\])/, (_, p1, _p2, p3) => p1 + ch + p3)
    // 去掉已完成标记
    lines[i] = lines[i].replace(/\s@done:\d{4}-\d{2}-\d{2}/g, '')

    if (state === 'done') {
      // 完成：清旧 @日期，写 @done:今天
      lines[i] = lines[i].replace(/\s@\d{4}-\d{2}-\d{2}/g, '').trimEnd() + ` @done:${localDate()}`
    } else if (migrateDate) {
      // 迁移：清旧 @日期，写 @目标日
      lines[i] = lines[i].replace(/\s@\d{4}-\d{2}-\d{2}/g, '').trimEnd() + ` @${migrateDate}`
    } else {
      // 三态非 done：清 @日期（回到待处理，无目标日）
      lines[i] = lines[i].replace(/\s@\d{4}-\d{2}-\d{2}/g, '')
    }
    await writeFile(file, lines.join('\n'))
    return
  }
  throw new Error(`todo 不存在：^${id}`)
}

/**
 * 按给定 id 顺序重排 todo 行。只在"纯 todo 块"内移动；
 * 非 todo 行（标题、空行）保持相对位置，绝不重写。
 */
export async function reorder(
  dataDir: string,
  date: string,
  order: string[],
): Promise<void> {
  const file = inboxPath(dataDir, date)
  const content = await readFile(file, 'utf8')
  const lines = content.split('\n')
  const idToLine = new Map<string, string>()
  const todoIndexes: number[] = []
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const idM = raw.match(ID_RE)
    if (LINE_RE.test(raw) && idM) {
      idToLine.set(idM[2], raw)
      todoIndexes.push(i)
    }
  }

  // 只重排存在于文件中的 id，忽略未知 id
  const validOrder = order.filter((id) => idToLine.has(id))
  if (validOrder.length !== todoIndexes.length) {
    // 数量不符说明有 todo 无 id 或缺行：先补齐再交还。
    await ensureIds(dataDir, date)
    return reorder(dataDir, date, order)
  }

  const newLines = [...lines]
  validOrder.forEach((id, idx) => {
    newLines[todoIndexes[idx]] = idToLine.get(id)!
  })
  await writeFile(file, newLines.join('\n'))
}

/** 生成 4 位 base36 随机短 id */
export function randomId(): string {
  let s = ''
  for (let i = 0; i < 4; i++) {
    s += Math.floor(Math.random() * 36).toString(36)
  }
  return s
}

/** 本地时区日期 YYYY-MM-DD */
export function localDate(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// inbox 目录可能不存在（用户刚建数据目录），方便时创建
export async function ensureInboxDir(dataDir: string): Promise<void> {
  await mkdir(path.join(dataDir, 'inbox'), { recursive: true })
}

export { inboxPath }