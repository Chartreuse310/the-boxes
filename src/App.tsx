import { useEffect, useRef, useState } from 'react'
import { api, type BoxesInfo } from './api'
import { parseInbox, type Todo, type TodoState } from './lib/parser'

/** 本地时区的今日日期（YYYY-MM-DD） */
function today(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 某日的次日（YYYY-MM-DD，本地时区） */
function nextDay(date: string): string {
  const d = new Date(date + 'T00:00:00')
  d.setDate(d.getDate() + 1)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 状态 → box 内字形（the-boxes 的品牌就是这五个盒子）
 *  done / doing 不在表内：它们不用字形，改由矢量绘制（<DoneCheck /> / <DoingHalf />，见下）。
 *  类型上直接排除这两个状态，而不是留一个用不到的 '✓' '/' —— 免得后来者以为改这里能改符号。 */
const STATE_SYMBOL: Record<Exclude<TodoState, 'done' | 'doing'>, string> = {
  todo: '',
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

/**
 * 进行中：半填充圆 —— 一个圆被 45° 的 `/` 分成两半，左上那半填满、右下留空。
 *
 * 方向依据：填的是"先到"的那半。列表阅读方向是左→右、上→下，进度条
 * （`.bar-fill`）也是从左端起填，所以半填充取左上而不是右下。
 * 等价说法：Unicode ◐「左半实心」整体顺时针转 45°，实心部分就落在左上。
 *
 * 为什么不用渐变做半填充：渐变要额外引入一个色值（v0.2 的 `--c-doing-tint`
 * 就是因此被删）。这里用真实的矢量半圆盘，颜色仍是外圈那个 `currentColor`，
 * §4.2「五个状态只有完成有颜色」因此不被打破 —— 被禁的是"用渐变"，不是"半填充"。
 *
 * 为什么只填、不描边：
 * - 外圈已经提供了 1.5px 的圆环。若再把这段弧描一笔（0.9px），这个状态的环
 *   会变成约 1.95px，比其他四个状态粗一圈，是最容易露馅的那种"偏心"。
 * - 分割线也不必另画一笔：它就是半圆盘的直边，与外圈同色，画了也看不出来。
 *
 * 几何：viewBox 取**单位圆**（2×2，圆心 (1,1)，半径 1），于是这个符号与
 * 状态框的具体像素尺寸彻底解耦 —— 大小只由 CSS 给（`.box-half` 取
 * `--checkbox-size`，即半径 1 = 框外缘 9px）。半径取到外缘是有意的：
 * 超出的那部分由 `.box` 的 border-radius + overflow: hidden 裁掉，
 * "贴合描边内缘"因此是裁剪的副产品，不必知道描边究竟多宽。
 * （若改成按内区尺寸画，会撞上描边宽度被设备像素吸附：DPR 1 时 1.5px 被
 * Chrome 吸附成 1px，内区由 15px 变 16px，半圆就比内缘小 0.5px 而露缝。）
 * 45° 斜杠的两端在圆上，坐标轴投影为 1/√2 ≈ 0.7071：
 *   左下端点 (1 − 0.7071, 1 + 0.7071) = (0.2929, 1.7071)
 *   右上端点 (1 + 0.7071, 1 − 0.7071) = (1.7071, 0.2929)
 * 弧从左上绕过去（sweep=1 = 屏幕上顺时针：135° → 180° → 270° → 315°），
 * 正好经过"左"与"上"两个点，即左上那半。实测量得填充跨 135.00°→315.00°。
 */
const HALF_ARC = 'M 0.2929 1.7071 A 1 1 0 0 1 1.7071 0.2929 Z'

function DoingHalf() {
  return (
    <svg
      className="box-half"
      viewBox="0 0 2 2"
      aria-hidden="true"
      focusable="false"
    >
      <path d={HALF_ARC} fill="currentColor" />
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
  // 迁移菜单：记录当前打开的 todo id 及其"迁移到以后"是否在选日期
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

  // 菜单只在外部点击时关闭。不能用 mouseleave：浮层与行之间有 4px 间隙，
  // 鼠标穿行时已离开 li 的 DOM 子树会误关；且 <input type="date"> 的原生
  // 日历弹层不属于页面 DOM，鼠标移上去同样触发 mouseleave——日期根本点不到。
  useEffect(() => {
    if (openMenu === null) return
    const onDown = (e: MouseEvent) => {
      if ((e.target as Element | null)?.closest('.menu-wrap')) return
      setOpenMenu(null)
      setPickingDate(null)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [openMenu])

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

  // 迁移（SPEC v1.3 物理移动）：原行改 [>] / [<] 留在原文件作记录，
  // 目标日文件新建同名 [ ] 待办。目标文件可能是新建的，需刷新日期列表。
  const migrate = async (todo: Todo, target: 'today' | 'later', laterDate?: string) => {
    if (selected === null || !todo.id) return
    const state: TodoState = target === 'today' ? 'deferred' : 'scheduled'
    const migrateDate = target === 'today' ? today() : laterDate
    if (!migrateDate || migrateDate === selected) return // 目标即本文件：无迁移意义
    await api.migrate(selected, todo.id, state, migrateDate)
    setOpenMenu(null)
    setPickingDate(null)
    api.listDays().then(setDays)
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

  // footer 说明：数据目录 + 版本，不带标签。两者都来自 /api/info，
  // 界面里不存这两个值，所以 SPEC / package.json 升级后这里不会变成谎话。
  const footerInfo =
    info &&
    [
      shortDir(info.dataDir, info.home),
      info.version && `v${info.version}`,
      info.specVersion && `SPEC v${info.specVersion}`,
    ]
      .filter(Boolean)
      .join(' · ')

  // 空态要指出 todo 的来源文件。用 /api/info 给的实际数据目录，而不是默认路径——
  // 原实现写死 ~/the-boxes，配过 .env 的用户会看到一条指向不存在文件的指引。
  const inboxFile = info
    ? `${shortDir(info.dataDir, info.home)}/inbox/${selected}.md`
    : `inbox/${selected}.md`

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
            在 <code>{inboxFile}</code> 里加一行，保存后刷新即可看到。
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
              >
                <button
                  className={`box box-${t.state}`}
                  disabled={!t.id}
                  onClick={() => cycleState(t, i)}
                  aria-label={boxAriaLabel(t.state)}
                >
                  <span className="box-sym" key={t.state}>
                    {t.state === 'done' ? (
                      <DoneCheck />
                    ) : t.state === 'doing' ? (
                      <DoingHalf />
                    ) : (
                      STATE_SYMBOL[t.state]
                    )}
                  </span>
                </button>
                <span className="text">
                  {t.text}
                  {/* 日期注记：沿用文件里的 ISO 日期（与 Markdown 原文对得上）和原始措辞。
                      这是 §5.1「界面不用 emoji / 不用破折号拼注记」的既定例外。 */}
                  {t.startDate && (
                    <span className="done-note">
                      {' '}
                      ——始于 {t.startDate} 🛫
                      {t.doneDate && <>，完成于 {t.doneDate} 🎉</>}
                    </span>
                  )}
                  {!t.startDate && t.doneDate && (
                    <span className="done-note"> ——完成于 {t.doneDate} 🎉</span>
                  )}
                </span>
                {/* 元数据保留文件里的完整值，便于与 inbox 原文对应（§5.1）：
                    日期用完整 ISO（那也是当日的文件名），任务统一用 @ 记号。 */}
                {t.task && <span className="chip chip-task">@{t.task}</span>}
                {t.date && <span className="chip chip-date">@{t.date}</span>}

                {/* 迁移菜单只对 [ ] 与 [/] 开放：[>]/[<] 是迁移记录、[x] 已完结，
                    再迁会在目标文件产生重复副本 */}
                {t.id && (t.state === 'todo' || t.state === 'doing') && (
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
                        {/* 查看今日文件时无"迁移到今天"——todo 本就在今天 */}
                        {selected !== today() && (
                          <button onClick={() => migrate(t, 'today')}>迁移到今天</button>
                        )}
                        <button
                          onClick={() => setPickingDate(pickingDate === t.id ? null : t.id)}
                        >
                          迁移到以后…
                        </button>
                        {pickingDate === t.id && (
                          <input
                            type="date"
                            className="menu-date"
                            /* 查看今日时下限为明天（选今天等于没迁）；看过去时下限为今天 */
                            min={selected === today() ? nextDay(today()) : today()}
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
