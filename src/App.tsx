import { Fragment, useEffect, useRef, useState } from 'react'
import { api, type AnySource, type BoxesInfo, type SourcedTodo, type TaskSummary, type TodoSource, type TrashItem } from './api'
import { parseInbox, parseTask, type TaskMeta, type TodoState } from './lib/parser'

/**
 * 主视图：默认平铺（all），点日历某天 / 任务卡片进入筛选（day / task）。
 * 取消筛选回平铺：点右上角 home 图标，或再按一次已选中的日期 / 任务卡片。
 * 任务按提出月份嵌套在 tasks/YYYY-MM/ 下。
 */
type View =
  | { kind: 'all' }
  | { kind: 'day'; date: string }
  | { kind: 'task'; month: string; slug: string }
  | { kind: 'trash' }

/** 本地时区的今日日期（YYYY-MM-DD） */
function today(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** ISO 日期 → 'YYYY-MM'（mini 日历的浏览位置） */
function monthOf(iso: string): string {
  return iso.slice(0, 7)
}

/** 月份 +n 个月（'YYYY-MM'，本地时区） */
function addMonth(month: string, n: number): string {
  const d = new Date(`${month}-01T00:00:00`)
  d.setMonth(d.getMonth() + n)
  const p = (v: number) => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}`
}

/**
 * 添加框的路由目标：新 todo 整行落到哪个文件（归属 = 所在文件，SPEC v2.2）。
 * day → inbox 某日文件；task → 已存在任务文件；newTask → 以当前月建任务骨架后写入。
 */
type AddTarget =
  | { kind: 'day'; date: string }
  | { kind: 'task'; month: string; slug: string; title: string }
  | { kind: 'newTask'; name: string }

/** `@` 下拉里的一条候选 */
interface AtCand {
  key: string
  label: string
  hint?: string
  target: AddTarget
}

/**
 * 依 `@` 后的查询串构造候选：已有任务 + 已有日期文件；查询是完整 ISO 日期则补「用该日期」；
 * 查询非空且没有同名任务则补「创建任务」（末位，需显式选中才建，回车不自动建）。
 */
function buildAtCandidates(query: string, tasks: TaskSummary[], days: string[]): AtCand[] {
  const q = query.trim()
  const out: AtCand[] = []
  for (const t of tasks.filter((x) => x.slug.includes(q) || (x.title ?? '').includes(q)).slice(0, 5)) {
    out.push({
      key: `task:${t.month}/${t.slug}`,
      label: t.title || t.slug,
      hint: `任务 ${t.month}`,
      target: { kind: 'task', month: t.month, slug: t.slug, title: t.title || t.slug },
    })
  }
  for (const d of days.filter((x) => x.includes(q)).slice(0, 5)) {
    out.push({ key: `day:${d}`, label: d, hint: '日期', target: { kind: 'day', date: d } })
  }
  // 查询本身是合法 ISO 日期（哪怕当天文件还没建）→ 可路由过去，落盘时自动建日文件
  if (/^\d{4}-\d{2}-\d{2}$/.test(q) && !days.includes(q)) {
    out.unshift({ key: `day:${q}`, label: q, hint: '新日期', target: { kind: 'day', date: q } })
  }
  // 无同名任务时给「创建任务」；需显式选中（回车不自动建，避免手滑建库）
  if (q && !tasks.some((t) => t.slug === q)) {
    out.push({ key: `new:${q}`, label: `创建任务 ${q}`, hint: '新任务', target: { kind: 'newTask', name: q } })
  }
  return out
}

/** 目标徽章文案 */
function targetLabel(t: AddTarget): string {
  if (t.kind === 'day') return t.date
  if (t.kind === 'task') return t.title
  return `新建任务 ${t.name}`
}

/** 状态 → 中文名。只用于无障碍标签：§6 禁止把内部枚举名（done/scheduled）念给用户。 */
const STATE_LABEL: Record<TodoState, string> = {
  todo: '待办',
  doing: '进行中',
  done: '完成',
}

/** 完成勾的线宽（单位与 viewBox 一致，1 单位 = 1 CSS px）。
 *  0.9 来自与同一行里 `/` 字形（12px/500，实测 0.807）的对齐，取略粗一档，
 *  是"和别的符号一样粗"的解。box 自身描边为 1.5px，故勾不会比外圈更抢眼。 */
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
 * 方向依据：填的是"先到"的那半。列表阅读方向是左→右、上→下，
 * 所以半填充取左上而不是右下。
 * 等价说法：Unicode ◐「左半实心」整体顺时针转 45°，实心部分就落在左上。
 *
 * 为什么不用渐变做半填充：渐变要额外引入一个色值（v0.2 的 `--c-doing-tint`
 * 就是因此被删）。这里用真实的矢量半圆盘，颜色仍是外圈那个 `currentColor`，
 * §4.2「三个状态只有完成有颜色」因此不被打破 —— 被禁的是"用渐变"，不是"半填充"。
 *
 * 为什么只填、不描边：
 * - 外圈已经提供了 1.5px 的圆环。若再把这段弧描一笔（0.9px），这个状态的环
 *   会变成约 1.95px，比其他状态粗一圈，是最容易露馅的那种"偏心"。
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

/**
 * home 图标：回到平铺视图（默认视图）。
 * 矢量绘制——§5.1 禁止 emoji 作界面元素；房子轮廓 + 门柱，
 * stroke 2 / viewBox 24，由 CSS 显示为 18px（描边实际渲染 1.5px，
 * 与状态框外圈同粗）。颜色走 currentColor = 按钮的 --text-secondary。
 */
function HomeIcon() {
  return (
    <svg className="home-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <polyline
        points="9 22 9 12 15 12 15 22"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * 垃圾箱图标：矢量绘制（§5.1 禁 emoji 作界面元素）。垃圾桶轮廓 + 盖 + 两道竖纹，
 * stroke 2 / viewBox 24，尺寸由 CSS 给（.trash-icon 26px）。仅用于拖动时底部的删除落点。
 */
function TrashIcon() {
  return (
    <svg className="trash-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 7h16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      <path
        d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M9 7V4h6v3" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 11v6M14 11v6" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
    </svg>
  )
}

/** 平铺视图的一组：来源相同的相邻行（/api/all 的排序已保证同文件行相邻） */
interface TodoGroup {
  key: string
  /** 组头 = 来源文件名称：inbox → 日期，任务 → 任务名 */
  title: string
  /** 任务组附带的提出月份（较淡显示，区分跨月重名任务） */
  month?: string
  items: { t: SourcedTodo; i: number }[]
}

/** 把平铺的 todos 按来源文件分组。行尾不再标来源——组头直接显示文件名称。 */
function groupBySource(todos: SourcedTodo[]): TodoGroup[] {
  const groups: TodoGroup[] = []
  todos.forEach((t, i) => {
    const key =
      t.source.kind === 'day' ? `day:${t.source.date}` : `task:${t.source.month}/${t.source.slug}`
    const title = t.source.kind === 'day' ? t.source.date : t.source.slug
    const month = t.source.kind === 'task' ? t.source.month : undefined
    const last = groups[groups.length - 1]
    if (last && last.key === key) last.items.push({ t, i })
    else groups.push({ key, title, month, items: [{ t, i }] })
  })
  return groups
}

/** 两个来源是否同一文件（重排只在同文件内落子）。 */
function sameSource(a: TodoSource, b: TodoSource): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'day') return b.kind === 'day' && a.date === b.date
  return b.kind === 'task' && a.month === b.month && a.slug === b.slug
}

/** box 的无障碍标签：点击展开起止日期编辑，播报当前状态。 */
function boxAriaLabel(state: TodoState): string {
  return `编辑起止日期（当前${STATE_LABEL[state]}）`
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

/**
 * mini 日历（左上角）。
 * - 点击某天 → 查看该日 todo（含尚无文件的日子）
 * - 把 todo 拖到某天上 → 迁移到该日文件（SPEC v2.0 整行移动），格子高亮为落点
 * - 有记录的日子标圆点；今天描圈；点月份标题回到本月
 * 周一开头：周标题「一 二 三 四 五 六 日」，首行前置 (getDay()+6)%7 个空位。
 */
function MiniCalendar(props: {
  marked: Set<string>
  selected: string | null
  todayIso: string
  onPick: (date: string) => void
  onDropDate: (date: string) => void
}) {
  const { marked, selected, todayIso, onPick, onDropDate } = props
  // 正在浏览的月份（可与今天所在月不同）
  const [cursor, setCursor] = useState(() => monthOf(todayIso))
  // 拖动悬停的日期（drop 落点高亮）
  const [over, setOver] = useState<string | null>(null)

  // 拖拽在任何地方结束（含取消：拖回列表松手）都要清落点高亮。
  // dragend 冒泡到 document；drop 已在格子自己的 onDrop 里清过，这里兜底。
  useEffect(() => {
    const clear = () => setOver(null)
    document.addEventListener('dragend', clear)
    document.addEventListener('drop', clear)
    return () => {
      document.removeEventListener('dragend', clear)
      document.removeEventListener('drop', clear)
    }
  }, [])

  const lead = (new Date(`${cursor}-01T00:00:00`).getDay() + 6) % 7 // 周一开头的前置空位
  const daysInMonth = new Date(Number(cursor.slice(0, 4)), Number(cursor.slice(5, 7)), 0).getDate()
  const cells: (string | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => `${cursor}-${String(i + 1).padStart(2, '0')}`),
    ...Array.from({ length: (7 - ((lead + daysInMonth) % 7)) % 7 }, () => null), // 尾部补齐整周
  ]

  return (
    <div className="calendar" aria-label="日期日历">
      <div className="cal-head">
        <button type="button" className="cal-nav" onClick={() => setCursor(addMonth(cursor, -1))} aria-label="上个月">
          ‹
        </button>
        {/* 点月份标题 = 回到本月（比"今天"按钮省一个词） */}
        <button type="button" className="cal-title" onClick={() => setCursor(monthOf(todayIso))}>
          {Number(cursor.slice(5))}月 {cursor.slice(0, 4)}
        </button>
        <button type="button" className="cal-nav" onClick={() => setCursor(addMonth(cursor, 1))} aria-label="下个月">
          ›
        </button>
      </div>
      <div className="cal-grid" role="grid">
        {['一', '二', '三', '四', '五', '六', '日'].map((w) => (
          <span key={w} className="cal-weekday" aria-hidden>
            {w}
          </span>
        ))}
        {cells.map((d, i) =>
          d === null ? (
            <span key={`blank-${i}`} className="cal-cell" aria-hidden />
          ) : (
            <button
              key={d}
              type="button"
              className={
                'cal-cell cal-day' +
                (d === todayIso ? ' is-today' : '') +
                (d === selected ? ' is-selected' : '') +
                (over === d ? ' is-drag-over' : '')
              }
              aria-label={`查看 ${d}`}
              aria-current={d === selected ? 'true' : undefined}
              onClick={() => onPick(d)}
              onDragOver={(e) => {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
              }}
              onDragEnter={() => setOver(d)}
              onDragLeave={(e) => {
                // 子元素间穿行会冒泡 dragleave，只有真正离开该格才取消高亮
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null)
              }}
              onDrop={(e) => {
                e.preventDefault()
                setOver(null)
                onDropDate(d)
              }}
            >
              <span className="cal-num">{Number(d.slice(8))}</span>
              {marked.has(d) && <i className="cal-dot" aria-hidden />}
            </button>
          ),
        )}
      </div>
    </div>
  )
}

/**
 * 点 checkbox 展开的日期条：编辑开始/完成日期（状态随之派生）+「标为完成（今天）」。
 * 每次改动即时写盘（数据即文件）；名称编辑靠双击、换文件靠拖，都不在这里。
 */
function DateStrip(props: {
  todo: SourcedTodo
  onPatch: (p: { start?: string | null; done?: string | null }) => void
}) {
  const { todo, onPatch } = props
  return (
    <div className="date-strip" onKeyDown={(e) => e.stopPropagation()}>
      <label className="edit-field">
        <span className="edit-cap">开始</span>
        <input
          type="date"
          value={todo.startDate ?? ''}
          onChange={(e) => onPatch({ start: e.target.value || null })}
          aria-label="开始日期"
        />
        {todo.startDate && (
          <button type="button" className="edit-clear" onClick={() => onPatch({ start: null })} aria-label="清除开始日期">
            ×
          </button>
        )}
      </label>
      <label className="edit-field">
        <span className="edit-cap">完成</span>
        <input
          type="date"
          value={todo.doneDate ?? ''}
          onChange={(e) => onPatch({ done: e.target.value || null })}
          aria-label="完成日期"
        />
        {todo.doneDate && (
          <button type="button" className="edit-clear" onClick={() => onPatch({ done: null })} aria-label="清除完成日期">
            ×
          </button>
        )}
      </label>
      {!(todo.state === 'done' && todo.doneDate === today()) && (
        <button type="button" className="btn date-quick" onClick={() => onPatch({ done: today() })}>
          标为完成（今天）
        </button>
      )}
    </div>
  )
}

export default function App() {
  const [days, setDays] = useState<string[]>([])
  const [tasks, setTasks] = useState<TaskSummary[]>([])
  // 当前视图：平铺 / 某日 inbox / 某任务
  const [view, setView] = useState<View | null>(null)
  const [todos, setTodos] = useState<SourcedTodo[] | null>(null)
  // 任务视图的元数据（day / all 视图为 null）
  const [taskMeta, setTaskMeta] = useState<TaskMeta | null>(null)
  // 拖动中的 todo：源可含垃圾箱（AnySource）。day 视图列表内 drop → 重排；拖到日历/卡片 → 换文件（从 trash 拖出即恢复）
  const drag = useRef<{ index: number; id: string; source: AnySource } | null>(null)
  // 运行环境信息（数据目录 / 版本）：只用于 footer。取不到就不显示那一段，不阻塞界面。
  const [info, setInfo] = useState<BoxesInfo | null>(null)
  // 添加框草稿（all / day 视图输入，回车提交后清空）
  const [draft, setDraft] = useState('')
  // `@` 选中的路由目标（null = 未选，提交时落当天 / 正在看的那天）
  const [target, setTarget] = useState<AddTarget | null>(null)
  // `@` 下拉键盘高亮项下标
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  // 名称就地编辑：双击行文字进入，nameKey = 正在改的行 key，nameDraft = 草稿。
  const [nameKey, setNameKey] = useState<string | null>(null)
  const [nameDraft, setNameDraft] = useState('')
  // 日期条：点 checkbox 展开该行的起止日期编辑，datesKey = 展开的行 key。
  const [datesKey, setDatesKey] = useState<string | null>(null)
  // 拖拽中：显示底部垃圾箱落点；trashOver = 正悬停在垃圾箱上。
  const [dragging, setDragging] = useState(false)
  const [trashOver, setTrashOver] = useState(false)
  // 上手示例是否仍在（决定顶部「清空示例」横幅显隐）。启动播种在服务器侧完成，这里只查状态。
  const [demoActive, setDemoActive] = useState(false)
  // 垃圾箱内容（决定头部垃圾桶入口是否出现 + 计数）；trash 视图列出它。
  const [trash, setTrash] = useState<TrashItem[]>([])

  const loadTrash = () => api.getTrash().then(setTrash).catch(() => setTrash([]))

  const loadDay = async (date: string) => {
    const day = await api.getDay(date)
    setTaskMeta(null)
    setTodos(day ? parseInbox(day.content).map((t) => ({ ...t, source: { kind: 'day', date } })) : [])
  }

  const loadTask = async (month: string, slug: string) => {
    const raw = await api.getTask(month, slug)
    if (!raw) {
      setTaskMeta(null)
      setTodos([])
      return
    }
    const parsed = parseTask(raw.content)
    setTaskMeta(parsed)
    setTodos(parsed.todos.map((t) => ({ ...t, source: { kind: 'task', month, slug } })))
  }

  const loadAll = async () => {
    const all = await api.listAll()
    setTaskMeta(null)
    setTodos(all)
  }

  /** 按当前视图重新加载（写操作后刷新用） */
  const refreshView = () => {
    if (view === null) return
    if (view.kind === 'all') loadAll()
    else if (view.kind === 'day') loadDay(view.date)
    else if (view.kind === 'task') loadTask(view.month, view.slug)
    else loadTrash()
  }

  // 环境信息：与日期列表无关，只需一次
  useEffect(() => {
    api.info().then(setInfo).catch(() => setInfo(null))
  }, [])

  // 启动：默认平铺所有 todo；日期与任务列表供日历圆点 / 卡片使用，trash 供垃圾箱入口计数
  useEffect(() => {
    setView({ kind: 'all' })
    api.listDays().then(setDays).catch(() => setDays([]))
    api.listTasks().then(setTasks).catch(() => setTasks([]))
    loadTrash()
  }, [])

  // 切换视图：读取文件并按 SPEC §4/§5 解析（trash 视图单独走 loadTrash）
  useEffect(() => {
    if (view === null) {
      setTodos([])
      setTaskMeta(null)
      return
    }
    if (view.kind === 'trash') {
      loadTrash()
      return
    }
    setTodos(null)
    if (view.kind === 'all') loadAll()
    else if (view.kind === 'day') loadDay(view.date)
    else loadTask(view.month, view.slug)
  }, [view])

  // SSE 自动刷新（北极星：外部改动→界面 ≤2s）。订阅只建一次，靠 ref 读最新的
  // refreshView / 编辑态（否则闭包陈旧）。正在改名称或开着日期条时不刷新，免得冲掉输入。
  const liveRef = useRef({ refreshView, editing: false })
  liveRef.current = { refreshView, editing: nameKey !== null || datesKey !== null }
  useEffect(
    () =>
      api.subscribe(() => {
        api.listDays().then(setDays).catch(() => {})
        api.listTasks().then(setTasks).catch(() => {})
        loadTrash()
        if (!liveRef.current.editing) liveRef.current.refreshView()
      }),
    [],
  )

  // 示例是否还在（启动播种已在服务器侧完成）→ 决定横幅显隐
  useEffect(() => {
    api.getOnboarding().then((o) => setDemoActive(o.present)).catch(() => setDemoActive(false))
  }, [])

  // 清空示例：删文件 → 标记已处理（不再自动铺）→ 重载列表与当前视图、收起横幅
  const clearDemo = async () => {
    try {
      await api.clearOnboarding()
    } catch {
      return
    }
    setDemoActive(false)
    api.listDays().then(setDays).catch(() => {})
    api.listTasks().then(setTasks).catch(() => {})
    refreshView()
  }

  /** 行 key：来源 + id，用于就地编辑 / 日期条定位 */
  const rowKey = (t: SourcedTodo) =>
    (t.source.kind === 'day' ? 'd' + t.source.date : 't' + t.source.month + '/' + t.source.slug) + ':' + t.id

  // 统一写盘：文本 / 起止日期 / 换文件（target）都走 updateTodo，改后按盘重取。
  const patchTodo = async (
    t: SourcedTodo,
    patch: { text?: string; start?: string | null; done?: string | null; target?: TodoSource },
  ) => {
    if (!t.id) return
    try {
      await api.editTodo(t.source, t.id, patch)
    } catch {
      refreshView() // 失败回滚到盘上现状
      return
    }
    api.listDays().then(setDays).catch(() => {})
    api.listTasks().then(setTasks).catch(() => {})
    refreshView()
  }

  // 名称就地编辑：双击行文字进入；Enter/失焦提交（后端把换行并成空格），Esc 取消。
  const startNameEdit = (t: SourcedTodo) => {
    if (!t.id) return
    setNameKey(rowKey(t))
    setNameDraft(t.text)
  }
  const commitName = (t: SourcedTodo) => {
    const v = nameDraft.trim()
    if (v && v !== t.text) void patchTodo(t, { text: v })
    setNameKey(null)
  }

  // 点 checkbox：切换该行日期条（不再盲切三态——状态改由日期驱动）。
  const toggleDates = (t: SourcedTodo) => {
    if (!t.id) return
    setDatesKey((k) => (k === rowKey(t) ? null : rowKey(t)))
  }

  // 拖拽换文件（也是垃圾箱行的"恢复"）：拖到日历某格 → 移到那天；拖到任务卡片 → 移进该任务。
  // 直接吃 drag.current（源可为 trash），不记原处——落点即去处。同文件则跳过。
  const moveTo = async (target: TodoSource) => {
    const d = drag.current
    drag.current = null
    setDragging(false)
    setTrashOver(false)
    if (!d) return
    if (d.source.kind !== 'trash' && sameSource(d.source, target)) return
    try {
      await api.editTodo(d.source, d.id, { target })
    } catch {
      refreshView()
      return
    }
    api.listDays().then(setDays).catch(() => {})
    api.listTasks().then(setTasks).catch(() => {})
    loadTrash()
    refreshView()
  }

  // 拖进底部垃圾箱 = 软删除（移进 trash/，从视图消失但文件里仍可找回）。
  const dropToTrash = async () => {
    const d = drag.current
    drag.current = null
    setDragging(false)
    setTrashOver(false)
    if (!d || d.source.kind === 'trash') return // 垃圾箱条目本身不再"扔进垃圾箱"
    try {
      await api.trashTodo(d.source, d.id)
    } catch {
      refreshView()
      return
    }
    api.listDays().then(setDays).catch(() => {})
    api.listTasks().then(setTasks).catch(() => {})
    loadTrash()
    refreshView()
  }

  // 清空垃圾箱：彻底删除 trash/（不可恢复），刷新计数并回平铺
  const emptyAllTrash = async () => {
    try {
      await api.emptyTrash()
    } catch {
      return
    }
    loadTrash()
    setView({ kind: 'all' })
  }

  // 拖动重排：只在同一来源文件内落子——单文件视图=整列表，平铺视图=该组内；跨来源的落点忽略
  // （平铺按来源分组，组间无全序意义，迁移走日历）。新顺序直接从当前 todos 的该来源子序列算，
  // 不经 setTodos 的 updater（React 18 批处理下同步代码读不到它赋的值）。
  const onDrop = async (targetIndex: number) => {
    const from = drag.current
    drag.current = null
    if (!from || !todos) return
    const moved = todos[from.index]
    const target = todos[targetIndex]
    if (!moved?.id || !target || from.index === targetIndex || !sameSource(moved.source, target.source)) return
    const idxs = todos.map((_, i) => i).filter((i) => sameSource(todos[i].source, moved.source))
    const ids = idxs.map((i) => todos[i].id).filter(Boolean) as string[]
    const pos = idxs.indexOf(from.index)
    const dest = idxs.indexOf(targetIndex)
    if (pos === -1 || dest === -1 || pos === dest) return
    const [mv] = ids.splice(pos, 1)
    ids.splice(dest, 0, mv)
    if (moved.source.kind === 'day') await api.reorder(moved.source.date, ids)
    else await api.taskReorder(moved.source.month, moved.source.slug, ids)
    refreshView() // 落盘后按文件顺序重取，界面即所见即所得（平铺组序、单文件同理）
  }

  // —— 添加框：`@` 路由到某个文件（归属 = 所在文件），回车整行落盘 ——
  // 当前 `@` 查询串（草稿末尾未闭合的 @token），有则弹下拉
  const atQuery = /@([^\s@]*)$/.exec(draft)?.[1] ?? null
  const atCandidates = atQuery === null ? [] : buildAtCandidates(atQuery, tasks, days)
  const menuShown = atQuery !== null && atCandidates.length > 0
  const activeIdx = menuShown ? Math.min(active, atCandidates.length - 1) : 0

  // 选中一条候选：记为路由目标，并从草稿里抹掉 `@查询`（token 只用于唤起，不落进正文）
  const pickTarget = (c: AtCand) => {
    setTarget(c.target)
    setDraft((d) => d.replace(/@([^\s@]*)$/, '').replace(/\s+$/, ''))
    setActive(0)
    inputRef.current?.focus()
  }

  const clearTarget = () => {
    setTarget(null)
    inputRef.current?.focus()
  }

  // 下拉打开时接管方向键 / 回车 / Esc；关闭时回车走表单提交
  const onDraftKey = (e: import('react').KeyboardEvent<HTMLInputElement>) => {
    if (!menuShown) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => Math.min(a + 1, atCandidates.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      pickTarget(atCandidates[activeIdx])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setDraft((d) => d.replace(/@([^\s@]*)$/, '')) // 抹掉未选中的 @token 即收起
    }
  }

  // 提交：目标来自下拉选中；否则解析正文里残留的 `@token`（键盘党：`@2026-..`/`@已有任务` 直接回车）；
  // 都没有 → 落正在看的那天（平铺落今天）。失败回填草稿与目标，不吞输入。
  const submitDraft = async () => {
    let text = draft.trim()
    let tgt: AddTarget | null = target
    if (!tgt) {
      const m = text.match(/@([^\s@]+)/)
      if (m) {
        const tok = m[1]
        if (/^\d{4}-\d{2}-\d{2}$/.test(tok)) tgt = { kind: 'day', date: tok }
        else {
          const tk = tasks.find((x) => x.slug === tok)
          if (tk) tgt = { kind: 'task', month: tk.month, slug: tk.slug, title: tk.title || tk.slug }
        }
        if (tgt) text = text.replace(m[0], '').trim()
      }
    }
    if (!text) return // 只有目标没有正文，不提交
    const route: AddTarget = tgt ?? {
      kind: 'day',
      date: view?.kind === 'day' ? view.date : today(),
    }
    setDraft('')
    setTarget(null)
    try {
      if (route.kind === 'day') await api.addTodo(route.date, text)
      else if (route.kind === 'task') await api.addTaskTodo(route.month, route.slug, text)
      else await api.addTaskTodo(today().slice(0, 7), route.name, text) // 新任务：按当前月建骨架
    } catch {
      setDraft(text)
      setTarget(tgt)
      return
    }
    api.listDays().then(setDays).catch(() => {})
    api.listTasks().then(setTasks).catch(() => {})
    if (view === null) setView({ kind: 'all' })
    else refreshView()
  }

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
  const dataRoot = info ? shortDir(info.dataDir, info.home) : ''
  const inboxFile = `${dataRoot}/inbox/${view?.kind === 'day' ? view.date : '日期'}.md`

  /** 单行 todo 的渲染（平铺分组与筛选视图共用；i 是 todos 的全局下标，重排靠它定位） */
  const renderTodo = (t: SourcedTodo, i: number) => {
    const key = rowKey(t)
    const editingName = nameKey === key
    const row = (
      <li
        key={t.id ?? i}
        className={`todo todo-${t.state}`}
        style={{ '--i': i } as import('react').CSSProperties}
        draggable={!!t.id && !editingName}
        onDragStart={(e) => {
          if (!t.id) return
          // 声明这是移动而非复制：否则浏览器默认在游标旁画「+」角标，误导成「会复制」
          e.dataTransfer.effectAllowed = 'move'
          drag.current = { index: i, id: t.id, source: t.source }
          setDragging(true)
        }}
        onDragEnd={() => {
          drag.current = null
          setDragging(false)
          setTrashOver(false)
        }}
        onDragOver={(e) => {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move' // 落点也标移动，与日历/卡片迁移手感一致
        }}
        onDrop={() => onDrop(i)}
      >
        <button
          className={`box box-${t.state}`}
          disabled={!t.id}
          onClick={() => toggleDates(t)}
          aria-label={boxAriaLabel(t.state)}
          aria-expanded={datesKey === key}
        >
          <span className="box-sym" key={t.state}>
            {t.state === 'done' ? (
              <DoneCheck />
            ) : t.state === 'doing' ? (
              <DoingHalf />
            ) : null}
          </span>
        </button>
        <span className="text">
          {editingName ? (
            <input
              className="todo-name-input"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => commitName(t)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commitName(t)
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  setNameKey(null)
                }
              }}
              autoFocus
              aria-label="编辑名称"
            />
          ) : (
            <span className="todo-title" onDoubleClick={() => startNameEdit(t)} title="双击编辑名称">
              {t.text}
            </span>
          )}
          {/* 日期注记：沿用文件里的 ISO 日期与原始措辞（§5.1 例外），标题首行、注记次行。 */}
          {t.startDate && (
            <span className="done-note">
              ——始于 {t.startDate} 🛫
              {t.doneDate && <>，完成于 {t.doneDate} 🎉</>}
            </span>
          )}
          {!t.startDate && t.doneDate && (
            <span className="done-note">——完成于 {t.doneDate} 🎉</span>
          )}
        </span>
        {/* 元数据保留文件里的完整值，便于与 inbox 原文对应（§5.1）：
            日期用完整 ISO（那也是当日的文件名），任务统一用 @ 记号。 */}
        {t.task && <span className="chip chip-task">@{t.task}</span>}
        {t.date && <span className="chip chip-date">@{t.date}</span>}
      </li>
    )
    if (t.id && datesKey === key) {
      return (
        <Fragment key={t.id}>
          {row}
          <li className="todo-dates">
            <DateStrip todo={t} onPatch={(p) => void patchTodo(t, p)} />
          </li>
        </Fragment>
      )
    }
    return row
  }

  const todayStr = today()

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
        {/* home：回到平铺（默认视图）。垃圾箱入口改到左栏任务卡片底部，见 sidebar。 */}
        <button
          type="button"
          className="home-btn"
          onClick={() => {
            if (view?.kind !== 'all') setView({ kind: 'all' })
          }}
          aria-label="回到平铺"
          title="回到平铺"
          aria-current={view?.kind === 'all' ? 'true' : undefined}
        >
          <HomeIcon />
        </button>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <MiniCalendar
            marked={new Set(days)}
            selected={view?.kind === 'day' ? view.date : null}
            todayIso={todayStr}
            onPick={(date) =>
              // 再按一次已选中的那天 = 取消筛选，回平铺
              setView(view?.kind === 'day' && view.date === date ? { kind: 'all' } : { kind: 'day', date })
            }
            onDropDate={(date) => void moveTo({ kind: 'day', date })}
          />

          {/* 任务卡片：名称 + 提出月份（较淡，区分跨月重名）+ 一句话简介（**目标**） */}
          {tasks.length > 0 && (
            <nav className="task-list" aria-label="任务列表">
              <div className="sidebar-heading">任务</div>
              {tasks.map((t) => {
                const selected =
                  view?.kind === 'task' && view.month === t.month && view.slug === t.slug
                return (
                  <button
                    key={`${t.month}/${t.slug}`}
                    type="button"
                    className={'task-card' + (selected ? ' is-selected' : '')}
                    aria-current={selected ? 'true' : undefined}
                    onClick={() =>
                      // 再按一次已选中的卡片 = 取消筛选，回平铺
                      setView(selected ? { kind: 'all' } : { kind: 'task', month: t.month, slug: t.slug })
                    }
                    onDragOver={(e) => {
                      if (!drag.current) return
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'move'
                    }}
                    onDrop={(e) => {
                      e.preventDefault()
                      void moveTo({ kind: 'task', month: t.month, slug: t.slug })
                    }}
                  >
                    <span className="task-top">
                      <span className="task-name">{t.title}</span>
                      <span className="task-month">{t.month}</span>
                    </span>
                    {t.goal && <span className="task-goal">{t.goal}</span>}
                  </button>
                )
              })}
            </nav>
          )}

          {/* 垃圾箱入口：非空时置于任务卡片下方（同款 task-card 样式，图标 + 计数） */}
          {trash.length > 0 && (
            <nav className="task-list sidebar-trash" aria-label="垃圾箱">
              <button
                type="button"
                className={'task-card trash-entry' + (view?.kind === 'trash' ? ' is-selected' : '')}
                onClick={() => setView(view?.kind === 'trash' ? { kind: 'all' } : { kind: 'trash' })}
                aria-current={view?.kind === 'trash' ? 'true' : undefined}
              >
                <span className="task-top">
                  <TrashIcon />
                  <span className="task-name">垃圾箱</span>
                  <span className="task-month">{trash.length}</span>
                </span>
              </button>
            </nav>
          )}
        </aside>

        <main>
        {/* 上手示例横幅：仅示例数据仍在时出现，一键清空后不再显示 */}
        {demoActive && (
          <div className="demo-note" role="note">
            <span className="demo-note-text">
              下面是<strong>示例数据</strong>，随便点、改、拖来试；上手后一键清掉，从你自己的第一条开始。
            </span>
            <button type="button" className="btn" onClick={clearDemo}>
              清空示例
            </button>
          </div>
        )}
        {/* 添加框（默认平铺 / 某日视图）：`@` 唤起文件下拉（任务 + 日期），选中即把新行
            路由到该文件；无匹配可「创建任务」。归属由所在文件决定。任务视图不显示。 */}
        {(view?.kind === 'all' || view?.kind === 'day') && (
          <form
            className="add-bar"
            onSubmit={(e) => {
              e.preventDefault()
              submitDraft()
            }}
          >
            <div className="add-line">
              {target && (
                <button
                  type="button"
                  className="add-target"
                  onClick={clearTarget}
                  title="点击取消目标（当前：回车添加到此文件）"
                  aria-label={`添加目标：${targetLabel(target)}，点击取消`}
                >
                  <span className="add-target-x" aria-hidden>
                    ×
                  </span>
                  {targetLabel(target)}
                </button>
              )}
              <input
                ref={inputRef}
                className="add-input"
                type="text"
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value)
                  setActive(0)
                }}
                onKeyDown={onDraftKey}
                placeholder={
                  target
                    ? '继续输入内容，回车添加'
                    : view?.kind === 'day'
                      ? `添加到 ${view.date}…（@ 选任务/日期）`
                      : '添加 todo…（@ 选任务/日期，回车）'
                }
                aria-label="添加 todo"
                aria-autocomplete="list"
                aria-expanded={menuShown}
                role="combobox"
                autoComplete="off"
              />
            </div>
            {menuShown && (
              <ul className="at-menu" role="listbox" aria-label="添加目标">
                {atCandidates.map((c, i) => (
                  <li
                    key={c.key}
                    role="option"
                    aria-selected={i === activeIdx}
                    className={
                      'at-item' +
                      (c.target.kind === 'newTask' ? ' at-new' : '') +
                      (i === activeIdx ? ' is-active' : '')
                    }
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(e) => {
                      e.preventDefault() // 抢在 input blur 之前选中
                      pickTarget(c)
                    }}
                  >
                    <span className="at-label">{c.label}</span>
                    {c.hint && <span className="at-hint">{c.hint}</span>}
                  </li>
                ))}
              </ul>
            )}
          </form>
        )}
        {/* 任务详情头：名称 + 目标 + 状态行（v0.3.11 起为主区第一个元素） */}
        {view?.kind === 'task' && taskMeta && (
          <div className="task-header">
            <h2 className="task-title">{taskMeta.title ?? view.slug}</h2>
            {taskMeta.goal && <p className="task-goal-line">{taskMeta.goal}</p>}
            {(taskMeta.status || taskMeta.created) && (
              <p className="task-meta-line">
                {taskMeta.status}
                {taskMeta.status && taskMeta.created && ' · '}
                {taskMeta.created && `提出于 ${fmtDate(taskMeta.created)}`}
              </p>
            )}
          </div>
        )}
        {view?.kind === 'trash' ? (
          <div className="trash-view">
            <div className="view-head">
              <h2 className="view-title">垃圾箱</h2>
              {trash.length > 0 && (
                <button type="button" className="btn" onClick={emptyAllTrash}>
                  清空垃圾箱
                </button>
              )}
            </div>
            {trash.length === 0 ? (
              <p className="muted empty">垃圾箱是空的。</p>
            ) : (
              <>
                <p className="trash-hint">把某条拖到左上的日历某天、或左下的任务卡片，就恢复到那里。</p>
                <ul className="todos">
                {trash.map((t, i) => (
                  <li
                    key={t.id ?? i}
                    className={`todo todo-${t.state}`}
                    draggable={!!t.id}
                    onDragStart={(e) => {
                      if (!t.id) return
                      e.dataTransfer.effectAllowed = 'move'
                      drag.current = { index: i, id: t.id, source: { kind: 'trash', date: t.date } }
                      // 不置 dragging：从垃圾箱拖出是"恢复"，不该弹出底部的删除垃圾箱
                    }}
                    onDragEnd={() => {
                      drag.current = null
                      setDragging(false)
                      setTrashOver(false)
                    }}
                    title="拖到日历某天或任务卡片即可恢复"
                  >
                    <span className={'box box-' + t.state} aria-hidden>
                      <span className="box-sym">
                        {t.state === 'done' ? <DoneCheck /> : t.state === 'doing' ? <DoingHalf /> : null}
                      </span>
                    </span>
                    <span className="text">
                      <span className="todo-title">{t.text}</span>
                      <span className="done-note">——删除于 {t.date}</span>
                    </span>
                  </li>
                ))}
                </ul>
              </>
            )}
          </div>
        ) : todos === null ? (
          <p className="muted">加载中…</p>
        ) : todos.length === 0 ? (
          view?.kind === 'task' ? (
            <p className="muted empty">
              任务里还没有 todo。
              <br />
              在 <code>tasks/{view.slug}.md</code> 的「## todos」下加一行，保存后刷新即可看到。
            </p>
          ) : view?.kind === 'day' ? (
            <p className="muted empty">
              这一天还没有 todo。
              <br />
              在上方输入框回车即可添加（也可在 <code>{inboxFile}</code> 里直接写）。
            </p>
          ) : (
            <p className="muted empty">
              还没有任何 todo。
              <br />
              在上方输入框回车即可添加（也可在 <code>{dataRoot}/inbox/日期.md</code> 里直接写）。
            </p>
          )
        ) : view?.kind === 'all' ? (
          /* 平铺：按来源文件分组，组头直接显示文件名称（inbox → 日期；任务 → 任务名 +
             提出月份），行尾不再标来源 */
          <div className="todo-groups">
            {groupBySource(todos).map((g) => (
              <section key={g.key} className="todo-group">
                <h3 className="group-title">
                  {g.title}
                  {g.month && <span className="group-month">{g.month}</span>}
                </h3>
                <ul className="todos">{g.items.map(({ t, i }) => renderTodo(t, i))}</ul>
              </section>
            ))}
          </div>
        ) : (
          /* 筛选视图：单一来源，直接平铺（来源已由日历选中态 / 任务详情头标明） */
          <ul className="todos">{todos.map((t, i) => renderTodo(t, i))}</ul>
        )}
        </main>
      </div>

      <footer className="muted">{footerInfo ?? '数据存于本地 Markdown 文件'}</footer>

      {/* 拖动中才浮出的底部删除落点：把行拖进来 = 软删除进垃圾箱 */}
      {dragging && (
        <div
          className={'trash-drop' + (trashOver ? ' is-over' : '')}
          role="button"
          aria-label="拖到此处删除（进垃圾箱）"
          onDragOver={(e) => {
            if (!drag.current) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            if (!trashOver) setTrashOver(true)
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setTrashOver(false)
          }}
          onDrop={(e) => {
            e.preventDefault()
            void dropToTrash()
          }}
        >
          <TrashIcon />
        </div>
      )}
    </div>
  )
}
