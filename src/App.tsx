import { useEffect, useRef, useState } from 'react'
import { api } from './api'
import { parseInbox, type Todo, type TodoState } from './lib/parser'

/** 本地时区的今日日期（YYYY-MM-DD） */
function today(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 状态 → box 内符号（the-boxes 的品牌就是这五个盒子） */
const STATE_SYMBOL: Record<TodoState, string> = {
  todo: '',
  doing: '/',
  done: '✓',
  deferred: '>',
  scheduled: '<',
}
/** 状态循环顺序（点击 box 依次切换） */
const STATE_CYCLE: TodoState[] = ['todo', 'doing', 'done', 'deferred', 'scheduled']

export default function App() {
  const [days, setDays] = useState<string[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [todos, setTodos] = useState<Todo[] | null>(null)
  const dragIndex = useRef<number | null>(null)

  const reload = async (date: string) => {
    const day = await api.getDay(date)
    setTodos(day ? parseInbox(day.content) : [])
  }

  // 启动：拉取有记录的日期，默认选中今日（无则选最近一天）
  useEffect(() => {
    api.listDays().then((ds) => {
      setDays(ds)
      const t = today()
      setSelected(ds.includes(t) ? t : (ds[0] ?? null))
    })
  }, [])

  // 切换日期：读取文件并按 SPEC §4 解析
  useEffect(() => {
    if (selected === null) {
      setTodos([])
      return
    }
    setTodos(null)
    reload(selected)
  }, [selected])

  // 点击 box：循环切换状态，落盘后重载
  const cycleState = async (todo: Todo, index: number) => {
    if (selected === null || !todo.id) return
    const next = STATE_CYCLE[(STATE_CYCLE.indexOf(todo.state) + 1) % STATE_CYCLE.length]
    // 乐观更新
    setTodos((prev) => {
      if (!prev) return prev
      const copy = [...prev]
      copy[index] = { ...todo, state: next }
      return copy
    })
    await api.setState(selected, todo.id, next)
    reload(selected) // 后台落盘后精确刷新（含 @done 追加）
  }

  // 拖动重排：drop 时按新 id 顺序提交
  const onDrop = async (targetIndex: number) => {
    const from = dragIndex.current
    dragIndex.current = null
    if (from === null || from === targetIndex || selected === null) return
    let newOrder: string[] | null = null
    setTodos((prev) => {
      if (!prev) return prev
      const copy = [...prev]
      const [moved] = copy.splice(from, 1)
      copy.splice(targetIndex, 0, moved)
      newOrder = copy.map((t) => t.id).filter(Boolean) as string[]
      return copy
    })
    if (newOrder) await api.reorder(selected, newOrder)
  }

  return (
    <div className="app">
      <header>
        <h1>
          <span className="logo" aria-hidden />
          the-boxes
        </h1>
        <div className="date-picker">
          {selected === today() && <span className="today-badge">今日</span>}
          <select
            value={selected ?? ''}
            onChange={(e) => setSelected(e.target.value || null)}
            disabled={days.length === 0}
          >
            {days.length === 0 && <option value="">暂无记录</option>}
            {days.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>
      </header>

      <main>
        {todos === null ? (
          <p className="muted">加载中…</p>
        ) : todos.length === 0 ? (
          <p className="muted empty">
            这一天还没有 todo。
            <br />
            在 <code>~/the-boxes/inbox/{selected}.md</code> 里加一行，保存后刷新即可看到。
          </p>
        ) : (
          <ul className="todos">
            {todos.map((t, i) => (
              <li
                key={t.id ?? i}
                className={`todo todo-${t.state}`}
                draggable={!!t.id}
                onDragStart={() => (dragIndex.current = i)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => onDrop(i)}
                title={t.id ? '拖拽调整顺序 · 点击左侧盒子切换状态' : '无 id，暂不支持编辑'}
              >
                <button
                  className={`box box-${t.state}`}
                  disabled={!t.id}
                  onClick={() => cycleState(t, i)}
                >
                  {STATE_SYMBOL[t.state]}
                </button>
                <span className="text">{t.text}</span>
                {t.task && <span className="chip chip-task">+{t.task}</span>}
                {t.date && <span className="chip chip-date">@{t.date}</span>}
                {t.doneDate && <span className="chip chip-done">done {t.doneDate}</span>}
              </li>
            ))}
          </ul>
        )}
      </main>

      <footer className="muted">
        数据=本地 Markdown 文件（路径可在 .env 用 BOXES_DATA_DIR 自定义）· 开发模式 · SPEC v1.0
      </footer>
    </div>
  )
}
