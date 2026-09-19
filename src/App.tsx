import { useEffect, useRef, useState } from 'react'
import { api, type BoxesInfo } from './api'
import { parseInbox, type Todo, type TodoState } from './lib/parser'

/** 本地时区的今日日期（YYYY-MM-DD） */
function today(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 状态 → box 内字形（the-boxes 的品牌就是这五个盒子）
 *  done 不在表内：它不用字形，改由 <DoneCheck /> 矢量绘制（见下）。
 *  类型上直接排除 done，而不是留一个用不到的 '✓' —— 免得后来者以为改这里能改勾。 */
const STATE_SYMBOL: Record<Exclude<TodoState, 'done'>, string> = {
  todo: '',
  doing: '/',
  deferred: '>',
  scheduled: '<',
}

/** 状态 → 中文名。只用于无障碍标签：§6 禁止把内部枚举名（done/scheduled）念给用户。 */
const STATE_LABEL: Record<TodoState, string> = {
  todo: '待办',
  doing: '进行中',
  done: '完成',
  deferred: '顺延到今日',
  scheduled: '排期到以后',
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

/** 点击 box 会推进到的下一个状态；不可推进（终态，或 >/< 这类非三态）时返回 null */
function nextState(state: TodoState): TodoState | null {
  const i = STATE_CYCLE.indexOf(state)
  return i === -1 || i === STATE_CYCLE.length - 1 ? null : STATE_CYCLE[i + 1]
}

/** box 的无障碍标签：可推进时报"会变成什么"，到终态时报当前状态名 */
function boxAriaLabel(state: TodoState): string {
  const next = nextState(state)
  return next ? `标记为${STATE_LABEL[next]}` : STATE_LABEL[state]
}

/** 日期短格式（§5.1）：同年 M/D，非同年 YYYY/M/D */
function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-')
  return y === String(new Date().getFullYear())
    ? `${Number(m)}/${Number(d)}`
    : `${y}/${Number(m)}/${Number(d)}`
}

/** 主目录缩写为 ~，footer 显示用 */
function shortDir(dir: string, home: string): string {
  return home && dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir
}

export default function App() {
  const [days, setDays] = useState<string[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [todos, setTodos] = useState<Todo[] | null>(null)
  const dragIndex = useRef<number | null>(null)
  // 悬停迁移菜单：记录当前打开的 todo id 及其"迁移到以后"是否在选日期
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [pickingDate, setPickingDate] = useState<string | null>(null)
  // 运行环境信息（数据目录 / 版本）：只用于 footer。取不到就不显示那一段，不阻塞界面。
  const [info, setInfo] = useState<BoxesInfo | null>(null)

  const reload = async (date: string) => {
    const day = await api.getDay(date)
    setTodos(day ? parseInbox(day.content) : [])
  }

  // 环境信息：与日期列表无关，只需一次
  useEffect(() => {
    api.info().then(setInfo).catch(() => setInfo(null))
  }, [])

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
    const next = nextState(todo.state)
    if (!next) return // 已到 done，或 >/< 这类非三态 → 不响应点击
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

  // footer 说明：数据目录 + 版本。两者都来自 /api/info，界面里不存这两个值，
  // 所以 SPEC / package.json 升级后这里不会变成谎话。缺项自动省略。
  const footerInfo =
    info &&
    [
      `数据 ${shortDir(info.dataDir, info.home)}`,
      info.version && `v${info.version}`,
      info.specVersion && `数据格式 SPEC v${info.specVersion}`,
    ]
      .filter(Boolean)
      .join(' · ')

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
                  {fmtDate(d)}
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
            在数据目录的 <code>inbox/{selected}.md</code> 里加一行，保存后刷新即可看到。
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
                onMouseLeave={() => setOpenMenu(null)}
              >
                <button
                  className={`box box-${t.state}`}
                  disabled={!t.id}
                  onClick={() => cycleState(t, i)}
                  aria-label={boxAriaLabel(t.state)}
                >
                  <span className="box-sym" key={t.state}>
                    {t.state === 'done' ? <DoneCheck /> : STATE_SYMBOL[t.state]}
                  </span>
                </button>
                <span className="text">
                  {t.text}
                  {/* 日期注记（§5.1）：不用破折号、不用 emoji。
                      同日起止不写成区间——「9/19 → 9/19」没有信息量，只报完成日。 */}
                  {t.startDate && t.doneDate && t.startDate !== t.doneDate && (
                    <span className="done-note">
                      {' '}
                      {fmtDate(t.startDate)} → {fmtDate(t.doneDate)}
                    </span>
                  )}
                  {t.doneDate && (!t.startDate || t.startDate === t.doneDate) && (
                    <span className="done-note"> 完成 {fmtDate(t.doneDate)}</span>
                  )}
                  {t.startDate && !t.doneDate && (
                    <span className="done-note"> 始于 {fmtDate(t.startDate)}</span>
                  )}
                </span>
                {t.task && <span className="chip chip-task">{t.task}</span>}
                {t.date && <span className="chip chip-date">{fmtDate(t.date)}</span>}

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

      <footer className="muted">{footerInfo ?? '数据存于本地 Markdown 文件'}</footer>
    </div>
  )
}
