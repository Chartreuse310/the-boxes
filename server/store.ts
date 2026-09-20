// 服务端存储逻辑：编辑/排序 todo 行（Node 侧，不进入前端 bundle）。
// 定位策略：按行尾 `^id` 精确定位；手写行无 id 时，先 ensureIds 补齐。
// 容错规则（SPEC §7）：非 todo 行原样保留，绝不重写无关内容。

import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { parseInbox } from '../src/lib/parser'

export type TodoState = 'todo' | 'doing' | 'done'

/** todo 所在文件的定位（inbox 某日 / 任务某月某名）——编辑与移动的通用参数 */
export type TodoSourceRef =
  | { kind: 'day'; date: string }
  | { kind: 'task'; month: string; slug: string }

const STATE_CHAR: Record<TodoState, string> = {
  todo: ' ',
  doing: '/',
  done: 'x',
}

// 单行 todo 正则：`- [状态] 文本 ... [^id]`（只认三态，SPEC v2.0）
const LINE_RE = /^(-\s\[)([ x/])(\].*?)(\s\^[a-z0-9]+)?$/i
// 从整行里取 id（` ^xxxx`：前面有空白；id 为字母数字，遇空白/行尾停止）
const ID_RE = /(\s|^)\^([a-z0-9]+)/i
// 添加时从用户原话里摘出的可选行内 token（SPEC §4）：意向日期与归属任务
const ADD_DATE_RE = /\s@(\d{4}-\d{2}-\d{2})\b/
const ADD_TASK_RE = /\s\+([^\s+@^]+)/

function inboxPath(dataDir: string, date: string): string {
  return path.join(dataDir, 'inbox', `${date}.md`)
}

/**
 * 任务文件的绝对路径。任务按提出月份嵌套（SPEC v2.2：tasks/YYYY-MM/<slug>.md，防重名）。
 * month 须为 YYYY-MM；slug 只许字母/数字/中文/下划线/连字符（防路径穿越）。
 */
export function taskPath(dataDir: string, month: string, slug: string): string {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`非法任务月份：${month}`)
  if (!/^[\p{L}\p{N}_-]+$/u.test(slug)) throw new Error(`非法任务名：${slug}`)
  return path.join(dataDir, 'tasks', month, `${slug}.md`)
}

/** 给无 id 的 todo 行补齐 `^xxxx`，写回文件（inbox 日文件与任务文件通用） */
export async function ensureIdsInFile(file: string): Promise<void> {
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

/** inbox 版：按日期定位文件 */
export function ensureIds(dataDir: string, date: string): Promise<void> {
  return ensureIdsInFile(inboxPath(dataDir, date))
}

/**
 * 修改某 id 的行状态（inbox 日文件与任务文件通用）。
 * - doing：写 @start:今天（若尚无）——开始日期
 * - done：写 @done:今天，清普通 @日期；保留 @start（完成时展示"始于…，完成于…"）
 * - todo：清 @done、@start 与 @日期，回到待处理
 */
export async function setTodoStateInFile(
  file: string,
  id: string,
  state: TodoState,
): Promise<void> {
  const content = await readFile(file, 'utf8')
  const lines = content.split('\n')
  const ch = STATE_CHAR[state]

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const idM = raw.match(ID_RE)
    // 只动三态行：带同 id 的未知行（如旧数据里的 [>]）原样跳过
    if (!idM || idM[2] !== id || !LINE_RE.test(raw)) continue
    // 替换状态符号：- [ ] → - [x]
    lines[i] = raw.replace(/^(-\s\[)([ x/])(\])/, (_, p1, _p2, p3) => p1 + ch + p3)

    if (state === 'doing') {
      // 开始：若尚无 @start，追加今天
      if (!/\s@start:\d{4}-\d{2}-\d{2}/.test(lines[i])) {
        lines[i] = lines[i].trimEnd() + ` @start:${localDate()}`
      }
    } else if (state === 'done') {
      // 完成：清普通 @日期 与 @done 冗余，写 @done:今天；保留 @start
      lines[i] =
        lines[i]
          .replace(/\s@\d{4}-\d{2}-\d{2}/g, '')
          .replace(/\s@done:\d{4}-\d{2}-\d{2}/g, '')
          .trimEnd() + ` @done:${localDate()}`
    } else {
      // todo：回到待处理，清 @日期/@start/@done
      lines[i] = lines[i]
        .replace(/\s@\d{4}-\d{2}-\d{2}/g, '')
        .replace(/\s@start:\d{4}-\d{2}-\d{2}/g, '')
        .replace(/\s@done:\d{4}-\d{2}-\d{2}/g, '')
    }
    await writeFile(file, lines.join('\n'))
    return
  }
  throw new Error(`todo 不存在：^${id}`)
}

/** inbox 版：按日期定位文件 */
export function setState(
  dataDir: string,
  date: string,
  id: string,
  state: TodoState,
): Promise<void> {
  return setTodoStateInFile(inboxPath(dataDir, date), id, state)
}

/**
 * 迁移（SPEC v2.0）：把该行**原样移动**到目标日文件——
 * 状态、@start、@done、+任务、^id 全部保留，todo 身份不变；源文件删除该行。
 * 目标文件不存在时创建（含标题，与 touchDay 同一路径）。
 * 目标已有同 id 时（罕见）换新 id，避免身份撞车。
 */
export async function migrateTodo(
  dataDir: string,
  fromDate: string,
  id: string,
  targetDate: string,
): Promise<void> {
  // 1) 从源文件摘出整行（原样，含全部 token）
  const srcFile = inboxPath(dataDir, fromDate)
  const lines = (await readFile(srcFile, 'utf8')).split('\n')
  const idx = lines.findIndex((l) => l.match(ID_RE)?.[2] === id)
  if (idx === -1) throw new Error(`todo 不存在：^${id}`)
  const [line] = lines.splice(idx, 1)
  await writeFile(srcFile, lines.join('\n'))

  // 2) 目标文件：不存在则创建；原样追加
  const target = inboxPath(dataDir, targetDate)
  let content: string
  try {
    content = await readFile(target, 'utf8')
  } catch {
    await touchDay(dataDir, targetDate)
    content = await readFile(target, 'utf8')
  }
  const existing = new Set<string>()
  for (const raw of content.split('\n')) {
    const m = raw.match(ID_RE)
    if (m) existing.add(m[2])
  }
  let moved = line.trimEnd()
  if (existing.has(id)) {
    let newId: string
    do {
      newId = randomId()
    } while (existing.has(newId))
    moved = moved.replace(/\s\^[a-z0-9]+$/i, ` ^${newId}`)
  }

  const base = content === '' || content.endsWith('\n') ? content : content + '\n'
  await writeFile(target, `${base}${moved}\n`)
}

/**
 * 按给定 id 顺序重排 todo 行（inbox 日文件与任务文件通用）。
 * 只在"纯 todo 块"内移动；非 todo 行（标题、空行）保持相对位置，绝不重写。
 */
export async function reorderInFile(file: string, order: string[]): Promise<void> {
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
    await ensureIdsInFile(file)
    return reorderInFile(file, order)
  }

  const newLines = [...lines]
  validOrder.forEach((id, idx) => {
    newLines[todoIndexes[idx]] = idToLine.get(id)!
  })
  await writeFile(file, newLines.join('\n'))
}

/** inbox 版：按日期定位文件 */
export function reorder(dataDir: string, date: string, order: string[]): Promise<void> {
  return reorderInFile(inboxPath(dataDir, date), order)
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

/** 某日文件不存在时，生成空文件（含标题 + 空行占位） */
export async function touchDay(dataDir: string, date: string): Promise<void> {
  await ensureInboxDir(dataDir)
  await writeFile(inboxPath(dataDir, date), `# ${date}\n\n`)
}

/**
 * 添加一条 todo（界面输入框回车，落某日 inbox 文件）。
 * `text` 为用户原话，可含行内语法（SPEC §4）：`@YYYY-MM-DD`（意向日期）、`+任务`（归属）。
 * 其余 token（@start/@done/^id）对新建无意义，一律丢弃。
 * 行按 SPEC §4 规范顺序拼为 `- [ ] 正文 [+任务] [@日期] ^id`，追加到该日文件末尾；
 * 文件不存在则创建（含标题）。id 随机 4 位、避让文件内已有 id。返回新行 id。
 */
export async function addTodo(
  dataDir: string,
  date: string,
  text: string,
): Promise<{ id: string }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`非法日期：${date}`)
  let body = text.trim()
  if (!body) throw new Error('todo 内容为空')

  // 摘出可保留的行内 token（先任务后日期，正文里抹掉它们）
  let dateTok: string | null = null
  let taskTok: string | null = null
  const dm = body.match(ADD_DATE_RE)
  if (dm) {
    dateTok = dm[1]
    body = body.replace(dm[0], ' ')
  }
  const tm = body.match(ADD_TASK_RE)
  if (tm) {
    taskTok = tm[1]
    body = body.replace(tm[0], ' ')
  }
  // 丢弃用户可能误粘的 @start/@done/^id；压缩多余空白
  body = body
    .replace(/\s@start:\d{4}-\d{2}-\d{2}\b/g, '')
    .replace(/\s@done:\d{4}-\d{2}-\d{2}\b/g, '')
    .replace(/\s\^[a-z0-9]+\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!body) throw new Error('todo 内容为空')

  // 文件：不存在则创建（含标题），并收集已有 id 以避让
  const file = inboxPath(dataDir, date)
  let content: string
  try {
    content = await readFile(file, 'utf8')
  } catch {
    await touchDay(dataDir, date)
    content = await readFile(file, 'utf8')
  }
  const existing = new Set<string>()
  for (const raw of content.split('\n')) {
    const m = raw.match(ID_RE)
    if (m) existing.add(m[2])
  }
  let id: string
  do {
    id = randomId()
  } while (existing.has(id))

  // 规范顺序：正文 +任务 @日期 ^id
  let line = `- [ ] ${body}`
  if (taskTok) line += ` +${taskTok}`
  if (dateTok) line += ` @${dateTok}`
  line += ` ^${id}`

  const base = content === '' || content.endsWith('\n') ? content : content + '\n'
  await writeFile(file, `${base}${line}\n`)
  return { id }
}

/**
 * 向任务文件添加一条 todo（界面输入框 `@任务` 路由，或选中「创建任务」）。
 * 归属由所在文件决定，故只写 `- [ ] 正文 ^id`，不带 `+任务`/`@日期` token（SPEC v2.2 精神）。
 * 任务文件不存在则按 SPEC §5 建骨架。month/slug 经 taskPath 校验（slug 不含空格）。
 */
export async function addTaskTodo(
  dataDir: string,
  month: string,
  slug: string,
  text: string,
): Promise<{ id: string }> {
  const file = taskPath(dataDir, month, slug) // 非法 month/slug 直接抛出
  const content = await ensureTaskFile(dataDir, month, slug)

  const body = text.trim().replace(/\s+/g, ' ').trim()
  if (!body) throw new Error('todo 内容为空')

  const existing = new Set<string>()
  for (const raw of content.split('\n')) {
    const m = raw.match(ID_RE)
    if (m) existing.add(m[2])
  }
  let id: string
  do {
    id = randomId()
  } while (existing.has(id))

  const base = content === '' || content.endsWith('\n') ? content : content + '\n'
  await writeFile(file, `${base}- [ ] ${body} ^${id}\n`)
  return { id }
}

/** 任务文件绝对路径（校验后）。 */
function fileFor(dataDir: string, src: TodoSourceRef): string {
  return src.kind === 'day' ? inboxPath(dataDir, assertDay(src.date)) : taskPath(dataDir, src.month, src.slug)
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
function assertDay(date: string): string {
  if (!DAY_RE.test(date)) throw new Error(`非法日期：${date}`)
  return date
}

function sameSrc(a: TodoSourceRef, b: TodoSourceRef): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'day') return b.kind === 'day' && a.date === b.date
  return b.kind === 'task' && a.month === b.month && a.slug === b.slug
}

/** 任务文件：存在则读，缺失则按 SPEC §5 建骨架后返回其内容。 */
async function ensureTaskFile(dataDir: string, month: string, slug: string): Promise<string> {
  const file = taskPath(dataDir, month, slug)
  try {
    return await readFile(file, 'utf8')
  } catch {
    const created = month === localDate().slice(0, 7) ? localDate() : `${month}-01`
    await mkdir(path.dirname(file), { recursive: true })
    const content = `# 任务：${slug}\n\n**状态**：进行中\n**提出**：${created}\n\n## todos\n\n`
    await writeFile(file, content)
    return content
  }
}

/** 日文件：存在则读，缺失则 touchDay 建空文件（含标题）后返回。 */
async function ensureDayFile(dataDir: string, date: string): Promise<string> {
  const file = inboxPath(dataDir, assertDay(date))
  try {
    return await readFile(file, 'utf8')
  } catch {
    await touchDay(dataDir, date)
    return await readFile(file, 'utf8')
  }
}

/**
 * 编辑一行 todo（双击行 → 内联编辑器保存）。
 * patch：text 改正文；start/done 改 @start/@done（`null` 清除、`undefined` 不动）；
 * target 改所在文件（与来源相同则原地保存，否则整行移动到目标文件，id 保留、撞车则换新）。
 * 状态由时间派生：有 done→done，否则有 start→doing，否则 todo（「清除开始时间且无完成时间即回未开始」等）。
 * 保留行内既有的 legacy `+任务`/`@日期` token（SPEC §7 容错），只重写受控字段并按 §4 规范顺序排布。
 */
export async function updateTodo(
  dataDir: string,
  source: TodoSourceRef,
  id: string,
  patch: { text?: string; start?: string | null; done?: string | null; target?: TodoSourceRef },
): Promise<void> {
  const srcFile = fileFor(dataDir, source)
  const lines = (await readFile(srcFile, 'utf8')).split('\n')
  const idx = lines.findIndex((l) => LINE_RE.test(l) && l.match(ID_RE)?.[2] === id)
  if (idx === -1) throw new Error(`todo 不存在：^${id}`)
  const parsed = parseInbox(lines[idx])[0]
  if (!parsed) throw new Error(`行解析失败：^${id}`)

  const start = patch.start === undefined ? parsed.startDate : patch.start
  const done = patch.done === undefined ? parsed.doneDate : patch.done
  if (start && !DAY_RE.test(start)) throw new Error(`非法开始日期：${start}`)
  if (done && !DAY_RE.test(done)) throw new Error(`非法完成日期：${done}`)
  const text = (patch.text === undefined ? parsed.text : patch.text).trim().replace(/\s+/g, ' ').trim()
  if (!text) throw new Error('todo 内容为空')
  const state: TodoState = done ? 'done' : start ? 'doing' : 'todo'

  // §4 规范顺序：正文 +任务 @start @日期 @done ^id（task/date 为 legacy，原样保留）
  let line = `- [${STATE_CHAR[state]}] ${text}`
  if (parsed.task) line += ` +${parsed.task}`
  if (start) line += ` @start:${start}`
  if (parsed.date) line += ` @${parsed.date}`
  if (done) line += ` @done:${done}`
  line += ` ^${id}`

  const target = patch.target
  if (!target || sameSrc(target, source)) {
    lines[idx] = line
    await writeFile(srcFile, lines.join('\n'))
    return
  }

  // 移动到别的文件：校验 + 写目标在前、删源在后（宁可重复也不丢行）。
  const tgtFile = fileFor(dataDir, target) // 非法 target 在动源之前抛出
  const tgtContent =
    target.kind === 'day'
      ? await ensureDayFile(dataDir, target.date)
      : await ensureTaskFile(dataDir, target.month, target.slug)
  const existing = new Set<string>()
  for (const raw of tgtContent.split('\n')) {
    const m = raw.match(ID_RE)
    if (m) existing.add(m[2])
  }
  let finalId = id
  if (existing.has(finalId)) {
    do {
      finalId = randomId()
    } while (existing.has(finalId))
    line = line.replace(/\^[a-z0-9]+$/i, `^${finalId}`)
  }
  const base = tgtContent === '' || tgtContent.endsWith('\n') ? tgtContent : tgtContent + '\n'
  await writeFile(tgtFile, `${base}${line}\n`)

  // 目标已落，安全地从源删行
  const srcLines = (await readFile(srcFile, 'utf8')).split('\n')
  const srcIdx = srcLines.findIndex((l) => LINE_RE.test(l) && l.match(ID_RE)?.[2] === id)
  if (srcIdx !== -1) {
    srcLines.splice(srcIdx, 1)
    await writeFile(srcFile, srcLines.join('\n'))
  }
}

/**
 * 删除 = 软删除进垃圾箱：把该行原样移动到 `trash/<今天>.md`（应用不扫描 trash/，故从各视图消失、
 * 但仍是可以用编辑器打开找回的 Markdown）。与移动同序——先写垃圾箱、再从源删行，绝不丢行。
 * 文件不存在则建（含标题）。跨文件不要求 id 唯一（各文件内定位），原 id 保留。
 */
export async function trashTodo(dataDir: string, source: TodoSourceRef, id: string): Promise<void> {
  const srcFile = fileFor(dataDir, source)
  const lines = (await readFile(srcFile, 'utf8')).split('\n')
  const idx = lines.findIndex((l) => LINE_RE.test(l) && l.match(ID_RE)?.[2] === id)
  if (idx === -1) throw new Error(`todo 不存在：^${id}`)
  const line = lines[idx]

  const date = localDate()
  const trashFile = path.join(dataDir, 'trash', `${date}.md`)
  let content: string
  try {
    content = await readFile(trashFile, 'utf8')
  } catch {
    await mkdir(path.dirname(trashFile), { recursive: true })
    content = `# 垃圾箱 ${date}\n\n`
    await writeFile(trashFile, content)
  }
  const base = content === '' || content.endsWith('\n') ? content : content + '\n'
  await writeFile(trashFile, `${base}${line}\n`)

  const srcLines = (await readFile(srcFile, 'utf8')).split('\n')
  const srcIdx = srcLines.findIndex((l) => LINE_RE.test(l) && l.match(ID_RE)?.[2] === id)
  if (srcIdx !== -1) {
    srcLines.splice(srcIdx, 1)
    await writeFile(srcFile, srcLines.join('\n'))
  }
}

// —— 上手示例（onboarding）：空目录首次打开自动铺一份自解释的示例数据，界面可一键清空 ——
// 标记文件记在数据目录根，扫描 inbox/tasks 时不会读到它；有它 = 已处理过（含"已清空"），故不再重铺。

const ONBOARDING_FILE = '.boxes-onboarding.json'

interface OnboardingMarker {
  seeded: true
  files: string[] // 相对数据目录的示例文件路径（清空时逐个删；已清空则为 []）
}

async function readMarker(dataDir: string): Promise<OnboardingMarker | null> {
  try {
    return JSON.parse(await readFile(path.join(dataDir, ONBOARDING_FILE), 'utf8')) as OnboardingMarker
  } catch {
    return null
  }
}

async function writeMarker(dataDir: string, files: string[]): Promise<void> {
  await writeFile(dataDir.length ? path.join(dataDir, ONBOARDING_FILE) : ONBOARDING_FILE, JSON.stringify({ seeded: true, files }))
}

/** 数据目录里是否一个 todo 文件都没有（inbox 日文件 / 任务文件皆无）。 */
async function isEmptyStore(dataDir: string): Promise<boolean> {
  try {
    const inbox = await readdir(path.join(dataDir, 'inbox'))
    if (inbox.some((f) => DAY_RE.test(f.replace(/\.md$/, '')))) return false
  } catch {
    /* inbox 不存在 = 无 */
  }
  try {
    const months = await readdir(path.join(dataDir, 'tasks'), { withFileTypes: true })
    for (const m of months) {
      if (!m.isDirectory() || !/^\d{4}-\d{2}$/.test(m.name)) continue
      const files = await readdir(path.join(dataDir, 'tasks', m.name))
      if (files.some((f) => f.endsWith('.md'))) return false
    }
  } catch {
    /* tasks 不存在 = 无 */
  }
  return true
}

/** 生成示例文件的 Markdown（不含 ^id，落盘后由 ensureIdsInFile 补，保证可编辑/可拖）。 */
function onboardingFiles(dataDir: string): { rel: string; abs: string; content: string }[] {
  const today = localDate()
  const month = today.slice(0, 7)
  const slug = '示例任务'
  const dayRel = `inbox/${today}.md`
  const taskRel = `tasks/${month}/${slug}.md`
  const day =
    `# ${today}\n\n` +
    `下面几条是**示例**，随手点点就能学会；点顶部「清空示例」可一键清掉、从你自己的第一条开始。` +
    `数据就是你自己的 Markdown 文件，用任何编辑器改 \`inbox/\`、\`tasks/\` 都会自动反映到界面。\n\n` +
    `- [ ] 点左边的圆圈：待办 → 进行中 → 完成（完成会自动记下日期）\n` +
    `- [/] 双击这一行：能改文字、改开始/完成时间、还能把它挪到别的文件 @start:${today}\n` +
    `- [x] 这条已经完成了 @done:${today}\n` +
    `- [ ] 把我拖到左边日历里的另一天，就挪到那天去了\n` +
    `- [ ] 上方输入框敲一行回车即可添加；想归进某个任务就 @ 选一个（没有就现建）\n`
  const task =
    `# 任务：${slug}\n\n` +
    `**目标**：这是示例任务，点左下任务卡片即进任务视图（按文件归属，示例可清空）\n` +
    `**状态**：进行中\n` +
    `**提出**：${today}\n\n` +
    `## todos\n\n` +
    `- [ ] 任务 = 一组相关 todo + 一个目标，比清单重、比项目轻\n` +
    `- [ ] 这个 todo 就存在 \`tasks/${month}/${slug}.md\` 里，改文件即改这里\n` +
    `- [ ] 任务里的 todo 也能点状态、双击编辑、组内拖动排序\n`
  return [
    { rel: dayRel, abs: inboxPath(dataDir, today), content: day },
    { rel: taskRel, abs: taskPath(dataDir, month, slug), content: task },
  ]
}

/** 若目录是空的（且没处理过）→ 铺示例，返回是否铺了。有数据或已处理过则不铺。 */
export async function seedOnboardingIfEmpty(dataDir: string): Promise<boolean> {
  if (await readMarker(dataDir)) return false // 已铺过或已清空：不再打扰
  if (!(await isEmptyStore(dataDir))) {
    await writeMarker(dataDir, []) // 用户已有真实数据：标记为已处理，永不自动铺
    return false
  }
  await ensureInboxDir(dataDir)
  const written: string[] = []
  for (const f of onboardingFiles(dataDir)) {
    await mkdir(path.dirname(f.abs), { recursive: true })
    await writeFile(f.abs, f.content)
    await ensureIdsInFile(f.abs) // 给示例行补 ^id，使其可点/可编辑/可拖
    written.push(f.rel)
  }
  await writeMarker(dataDir, written)
  return true
}

/** 删除示例文件并把标记置空（保持标记存在 → 下次开不再自动铺）。 */
export async function clearOnboarding(dataDir: string): Promise<void> {
  const marker = await readMarker(dataDir)
  if (!marker) return
  for (const rel of marker.files) {
    await unlink(path.join(dataDir, rel)).catch(() => {})
  }
  await writeMarker(dataDir, [])
}

/** 界面用：示例是否仍在（决定「清空示例」按钮是否显示）。 */
export async function getOnboarding(dataDir: string): Promise<{ present: boolean; files: string[] }> {
  const marker = await readMarker(dataDir)
  const files = marker?.files ?? []
  return { present: files.length > 0, files }
}