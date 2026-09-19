# the-boxes · 界面风格规则（Style Guide）

> 版本 v0.2 · 2026-09-19 · 设计系统沿用 [obsidian-minimal](https://github.com/kepano/obsidian-minimal)（MIT License，Copyright (c) 2020-2026 Steph Ango）。本文定义 the-boxes 的设计 token 与易用性原则，供 M1/M5 及后续落地统一遵循。

## 0. 版权说明

- 本项目**沿用 Minimal 的设计系统**：以单一 HSL 基准 `--base-h/s/l` 派生全部中性色、Inter 系字体栈、圆形 checkbox、完成项默认无删除线。已适配为 the-boxes 自己的 CSS 变量，非整体复制 Obsidian 主题代码。
- obsidian-minimal 为 **MIT License**（Copyright 2020-2026 Steph Ango），本项目遵循其许可并在样式文件头部保留来源署名。
- 若日后引入 Minimal 的 checkbox SVG 图标等具体实现，须连同其版权声明一并保留。

## 1. 设计理念（从 Minimal 继承，适配 todo 场景）

1. **内容优先，去除干扰**：不装饰元素，用间距与层级而非颜色/阴影表达结构。每个额外的视觉元素都需要"为什么存在"。
2. **单一色相派生**：全部中性色由一个 HSL 基准派生（可控 base 即整套配色），而非各处硬编码堆色。
3. **易读性至上**：字号不小于阈值，行高充足，灰度文本可读；任何磨玻璃、动画、渐变不影响阅读。
4. **空格即结构**：优先用留白分块，少用边框和分割线。
5. **日日用的"轻"**：动效短而轻微，为反馈而非表演（呼应 PLAN 铁律 4"先日用后打磨"）。

## 2. 设计 Token（CSS 变量）

### 2.1 中性色（由 --base-h/s/l 派生）

| Token | 派生 | 用途 |
|---|---|---|
| `--base-h/-s/-l` | `0 / 0% / 96%` | 派生基准（Minimal light `hsl(0 0% 96%)`） |
| `--bg-page` | base | 页面背景 |
| `--bg-card` | 白 | 卡片、输入框 |
| `--bg-hover` | l-6% | hover / 淡色 chip |
| `--bg-subtle` | l-12% | chip、弱背景 |
| `--text` | l-90% | 主文本 |
| `--text-subtle` | l-25% | 次要文本 |
| `--text-muted` | l-50% | 弱化文本（完成日期等） |
| `--border` | l-12% | 卡片边框 |
| `--border-strong` | l-20% | 输入框边框 |

### 2.2 状态色（light 主题下 Minimal 语义色，仅用于 box + chip）

| 状态 | Token | 值 |
|---|---|---|
| 完成 `[x]` | `--c-done` | `#6e9151`（绿，MUDF） |
| 进行 `[/]` | `--c-doing` | `#6c99bb`（蓝） |
| 顺延 `[>]` | `--c-deferred` | `#d5763f`（橙，Minimal light orange） |
| 排期 `[<]` | `--c-scheduled` | `#9e86c8`（紫，Minimal light purple） |
| 强调/操作 | `--accent` | `#2563eb` |

> 状态色为"辅助色"：即便色盲场景，也靠 box 符号区分（box 内打状态字符），颜色只是强化，不单独承载语义。

### 2.3 辅助标签色（chip 前景）

| Token | 值 | 用途 |
|---|---|---|
| `--chip-task-fg` | `#b45309` | `+任务` chip 文字 |
| `--chip-date-fg` | `#7e22ce` | 日期 chip 文字 |
| `--bg-code` | l-20% | code 内嵌背景 |

### 2.4 字体栈（沿用 Minimal system-first + Inter）

```
-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Ubuntu,
'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif
```

- 系统字体：不打包字体文件，追求"原生应用"感与性能（符合 Minimal 的 system-first）。
- `-webkit-font-smoothing: antialiased` 常开。
- 数字/日期用等宽感？不强制——todo 是短文本，比例字体更易读。

## 3. 字号与行高

| 元素 | 字号 | 说明 |
|---|---|---|
| 页面标题 h1 | 20px / 700 | 顶栏唯一大字 |
| todo 文本 | 15px（默认） | 不小于 14px |
| 辅助文本（chip、日期、done-note、菜单、footer） | 12–13px | 不低于 11px |
| box 内状态字符 | 12px / 500 | 居中于圆形 box（`--checkbox-size`） |

- 行高：正文 ≥ 1.5；列表 item 垂直 padding 保证点击区域 ≥ 40px（易点中）。
- 日期改用短格式展示（如 `9/19`）可减少视觉噪音——留待 M1 验证。

## 4. 间距与留白节奏（8px 网格基数）

| 用途 | 值 |
|---|---|
| 页面上下 | 48px 上 / 28px 下 |
| 页面侧（最大宽 620px 居中） | 20px |
| header 与列表间距 | 20px |
| todo 列表项间距 | 6px |
| todo 卡片内边距 | 10px 垂直 / 12px 水平 |
| 卡片内元素间距 | 10px |
| 卡片圆角 | 10px（按钮/输入框 6–8px，chip/胶囊 999px） |
| 边框 | 1px 细边框，占位用色不喧宾 |

- 相邻但关联弱的区域用 20px，无关分组用 28px+。多块之间少画线，靠留白。
- 阴影仅用于浮层（menu、date-picker 下拉），用 `0 6px 20px rgba(28,25,23,0.12)` 等级别；普通卡片无投影。

### 4.1 Checkbox（沿用 Minimal）

- **形状**：圆形（`--checkbox-radius: 50%`），尺寸 `--checkbox-size = 15px × 0.85`，不低于 18px 保证可点。
- **完成项**：默认**无删除线**（Minimal `--checklist-done-decoration: none`），以 box 符号 + 完成日期灰字表达。
- **状态切换**：点击循环 `[ ] → [/] → [x]`，到完成停住；`[>]`/`[<]` 走悬停迁移菜单。
- box 内显示状态字符（`/`/`x`/`>`/`<`），颜色只是强化，符号才是语义主通道。

## 5. 交互与动效

- 动效时长：150ms 内（现有 hover `0.12s`、transition `0.06–0.12s` 合理）。
- 原则：`transition on color/background/opacity/transform(scale 轻微)`；不出现位移、拉长、旋转、扫光。
- 状态切换 box：可轻微 `scale(1.08)` + 颜色过渡，反馈即时（优先秒开，动画是点缀）。
- 全局禁止：磨砂/毛玻璃、背景动画、主题切换动画（移除为主，不做花哨过渡）。

## 6. 落地检查清单（做视觉前对照）

- [ ] 颜色是否全部来自 §2 token？无硬编码 hex。
- [ ] 是否加了不必要的边框/阴影/背景色？（应尽量只靠留白）
- [ ] 最小文本字号是否 ≥ 11px？正文 ≥ 14px？
- [ ] 状态仅用颜色区分吗？（必须同时有 box 符号）
- [ ] 动效 ≤ 150ms 且功能无关？
- [ ] 点击区域是否 ≥ 40px？

## 变更日志

- **2026-09-19** v0.2：从"理念参考"升级为"设计系统沿用"。①配色改为 Minimal 的单一 HSL 基准派生体系（`--base-h:0/-s:0%/-l:96%`，对齐 light 主题），状态色改为 Minimal 语义色；②字体栈加 Inter；③checkbox 改为圆形小尺寸，完成项无删除线规则；④版权声明改为"沿用设计系统，遵循 MIT"。落地于 `src/styles.css`。
- **2026-09-19** v0.1：初版。收编现有 styles.css 的颜色/字号/间距为设计 token；确立 5 条设计理念、字体栈、动效上限与落地检查清单；声明版权只借鉴理念不复制 Minimal 代码（MIT）。