import { useEffect, useRef, useState } from 'react'
import { api } from './api'
import { parseInbox, type Todo, type TodoState } from './lib/parser'

/** 本地时区的今日日期（YYYY-MM-DD） */
function today(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 状态 → box 内符号（the-boxes 的品牌就是这五个盒子）
 *  done 不使用此处的字形，改由 <DoneCheck /> 矢量绘制，见下。 */
const STATE_SYMBOL: Record<TodoState, string> = {
  todo: '',
  doing: '/',
  done: '✓',
  deferred: '>',
  scheduled: '<',
}

/** 完成勾的线宽（单位与 viewBox 一致，1 单位 = 1 CSS px）。
 *  0.9 来自与同一行里 `/` `>` `<` 三个字形（12px/500）的实测对齐，
 *  量法是覆盖率场 α≥0.5 下的垂直剖面（16 倍设备像素比截图）：
 *      / = 0.807 · > = 0.942 · < = 0.940  （CSS px，按符号取均值 0.896）
 *  取 0.9 与字形整体均值差 +0.004px，是"和别的符号一样粗"的解。
 *  box 自身描边为 1.5px，故勾不会比外圈更抢眼。 */
const CHECK_STROKE = 0.9

/**
 * 完成勾：矢量绘制。
 *
 * 为什么不用 `✓` 字形：该字形在部分平台会落到衬线体字体，形态不可控。
 * 为什么不用 CSS 边框拼 L 形：它的线宽被边框宽度绑死（1px 边框 = 两条 1px 的
 * 边，勾因此变成 2px，比所有字形粗一倍），且 L 形绕自身中心旋转 45° 后
 * 「墨迹包围盒中心」与旋转原点不重合（实测偏左 1.4px、偏下 0.7px），
 * 只能靠 translate 补一个随尺寸漂移的魔数。
 *
 * 几何：viewBox 12×12，墨迹包围盒以 (6,6) 为心 ——
 * 三点 x∈[2.2,9.8]、y∈[3,9]，加上 round cap 的 CHECK_STROKE/2 外扩后仍以 (6,6) 为心。
 * 因此 SVG 只要被 flex 居中，勾就是居中的（实测中心偏差 0.00 CSS px）。
 * 尺寸不写在这里：由 `.box-check { width: var(--fs-label) }` 统一给出，
 * 避免同一个数值存在两处来源。
 */
function DoneCheck() {
  return (
    <svg
      className="box-check"
      viewBox="0 0 12 12"
      aria-hidden="true"
      focusable="false"
    >
      <polyline
        points="2.2 6.8 4.4 9 9.8 3"
        fill="none"
        stroke="currentColor"
        strokeWidth={CHECK_STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
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

  const doneCount = todos?.filter((t) => t.state === 'done').length ?? 0
  const totalCount = todos?.length ?? 0
  const donePct = totalCount ? Math.round((doneCount / totalCount) * 100) : 0

  return (
    <div className="app">
      <header>
        <div className="brand">
          <span className="logo" aria-hidden>
            <i className="lld" />
            <i className="lbl" />
            <i className="ltb" />
          </span>
          <h1>the-boxes</h1>
        </div>
        <div className="date-picker">
          {selected === today() && <span className="today-badge">今日</span>}
          <div className="select-wrap">
            <select
              value={selected ?? ''}
              onChange={(e) => setSelected(e.target.value || null)}
              disabled={days.length === 0}
              aria-label="选择日期"
            >
              {days.length === 0 && <option value="">暂无记录</option>}
              {days.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>
        </div>
      </header>

      {todos && todos.length > 0 && (
        <div className="day-status" role="progressbar" aria-valuenow={donePct} aria-label={`${doneCount}/${totalCount} 完成`}>
          <span className="day-status-label">
            {doneCount}/{totalCount} 完成
          </span>
          <div className="bar">
            <span className="bar-fill" style={{ width: `${donePct}%` }} />
          </div>
        </div>
      )}

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
                style={{ '--i': i } as import('react').CSSProperties}
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
                  aria-label={`状态：${t.state}`}
                >
                  <span className="box-sym" key={t.state}>
                    {t.state === 'done' ? <DoneCheck /> : STATE_SYMBOL[t.state]}
                  </span>
                </button>
                <span className="text">
                  {t.text}
                  {t.startDate && (
                    <span className="done-note">
                      {' '}
                      —— 始于 {t.startDate} 🛫
                      {t.doneDate && <>，完成于 {t.doneDate} 🎉</>}
                    </span>
                  )}
                  {!t.startDate && t.doneDate && (
                    <span className="done-note"> —— 完成于 {t.doneDate} 🎉</span>
                  )}
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
