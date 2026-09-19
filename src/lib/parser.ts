// SPEC §4 行格式解析器。
// 容错规则（SPEC §7）：无法识别的行原样忽略，不算错误。

export type TodoState = 'todo' | 'doing' | 'done'

export interface Todo {
  id: string | null // ^a3f9 短哈希
  state: TodoState
  text: string
  date: string | null // @YYYY-MM-DD（可选意向日期）
  startDate: string | null // @start:YYYY-MM-DD（[/] 开始日期）
  doneDate: string | null // @done:YYYY-MM-DD
  task: string | null // +任务slug
}

const STATE_SYMBOLS: Record<string, TodoState> = {
  ' ': 'todo',
  '/': 'doing',
  x: 'done',
}

// 只认三态（SPEC v2.0）；[>] / [<] 等旧符号的行按未知语法容错忽略
const LINE_RE = /^-\s\[([ x/])\]\s+(.*)$/
const ID_RE = /\s\^([a-z0-9]+)\b/i
const START_RE = /\s@start:(\d{4}-\d{2}-\d{2})\b/
const DONE_RE = /\s@done:(\d{4}-\d{2}-\d{2})\b/
const DATE_RE = /\s@(\d{4}-\d{2}-\d{2})\b/
const TASK_RE = /\s\+([^\s+@^]+)/

/** 解析一个 inbox / 任务文件的 markdown 内容，返回 todo 列表 */
export function parseInbox(markdown: string): Todo[] {
  const todos: Todo[] = []
  for (const line of markdown.split('\n')) {
    const m = line.match(LINE_RE)
    if (!m) continue // 标题、空行、未知行：忽略（SPEC §7）

    const state = STATE_SYMBOLS[m[1]] ?? 'todo'
    let rest = m[2]

    // 依次摘出元数据 token（@done 要先于 @date，避免前缀误匹配）
    const take = (re: RegExp): string | null => {
      const t = rest.match(re)
      if (!t) return null
      rest = rest.replace(t[0], '')
      return t[1]
    }
    const id = take(ID_RE)
    const startDate = take(START_RE)
    const doneDate = take(DONE_RE)
    const date = take(DATE_RE)
    const task = take(TASK_RE)

    todos.push({ id, state, text: rest.trim(), date, startDate, doneDate, task })
  }
  return todos
}
