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
/** 点击三态循环：只走到完成，停在 [x]，不回环 */
const STATE_CYCLE: TodoState[] = ['todo', 'doing', 'done']

export default function App() {
  const [days, setDays] = useState<string[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [todos, setTodos] = useState<Todo[] | null>(null)
  const dragIndex = useRef<number | null>(null)
  // 悬停迁移菜单：记录当前打开的 todo id 及其"迁移到以后"是否在选日期
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [pickingDate, setPickingDate] = useState<string | null>(null)

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
    setOpenMenu(null)
    setPickingDate(null)
  }, [selected])

  // 点击 box：三态前进（todo→doing→done，done 停住）
  const cycleState = async (todo: Todo, index: number) => {
    if (selected === null || !todo.id) return
    const cur = STATE_CYCLE.indexOf(todo.state)
    if (cur === -1 || cur === STATE_CYCLE.length - 1) return // 非三态(done以外如 >/</迁出) 或已到 done → 不点
    const next = STATE_CYCLE[cur + 1]
    setTodos((prev) => {
      if (!prev) return prev
      const copy = [...prev]
      copy[index] = { ...todo, state: next }
      return copy
    })
    await api.setState(selected, todo.id, next)
    reload(selected)
  }

  // 迁移：state=[>] 今天 / [<] 所选日
  const migrate = async (todo: Todo, target: 'today' | 'later', laterDate?: string) => {
    if (selected === null || !todo.id) return
    const state: TodoState = target === 'today' ? 'deferred' : 'scheduled'
    const migrateDate = target === 'today' ? today() : laterDate
    if (!migrateDate) return
    await api.setState(selected, todo.id, state, migrateDate)
    setOpenMenu(null)
    setPickingDate(null)
    reload(selected)
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
                title={t.id ? '拖拽调整顺序' : '无 id，暂不支持编辑'}
                onMouseLeave={() => setOpenMenu(null)}
              >
                <button
                  className={`box box-${t.state}`}
                  disabled={!t.id}
                  onClick={() => cycleState(t, i)}
                >
                  {STATE_SYMBOL[t.state]}
                </button>
                <span className="text">
                  {t.text}
                  {t.doneDate && <span className="done-note">—— 完成于 {t.doneDate} 🎉</span>}
                </span>
                {t.task && <span className="chip chip-task">+{t.task}</span>}
                {t.date && <span className="chip chip-date">@{t.date}</span>}

                {t.id && (
                  <div className="menu-wrap">
                    <button
                      className="menu-trigger"
                      aria-label="迁移"
                      onClick={(e) => {
                        e.stopPropagation()
                        setOpenMenu(openMenu === t.id ? null : t.id)
                      }}
                    >
                      ⋯
                    </button>
                    {openMenu === t.id && (
                      <div className="menu">
                        <button onClick={() => migrate(t, 'today')}>迁移到今天</button>
                        <button
                          onClick={() => setPickingDate(pickingDate === t.id ? null : t.id)}
                        >
                          迁移到以后…
                        </button>
                        {pickingDate === t.id && (
                          <input
                            type="date"
                            className="menu-date"
                            min={today()}
                            onChange={(e) => {
                              if (e.target.value) migrate(t, 'later', e.target.value)
                            }}
                          />
                        )}
                      </div>
                    )}
                  </div>
                )}
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
