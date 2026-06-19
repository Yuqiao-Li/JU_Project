# JU 前端业务 PRD（Step 10A · 索引）

> 本目录 = 每页一份 PRD/task。来源：HANDOFF §12 + `JU 细节纠偏.md`（全 10 节）+ `DESIGN-TONE.md` + 代码盘点 + Step-10A 定稿讨论。
> **本轮只定"产品功能范围"，不含实现细节。** MVP 最简、只加"成局"相关功能、进阶缓做。
> 后续有新功能 → 改对应页的 PRD 文件。完整定稿计划见仓库外 `~/.claude/plans/planning-mode-step-10a-*.md`。
>
> ⚠️ **品牌 PDF（`step_10A_JU_Brand_Foundation_Internal.pdf`）当前工具读不了（CID 字体），用户将提供文本** → 到位后回填各页"品牌基调约束"。

## 成局逻辑（组织主轴）
局从"开"到"真实发生"的闭环，9 步 + 分享。每步 MVP 结论：

| 步 | MVP 结论 |
|---|---|
| 1 开局 | host 设**成局目标(缺几人)** + 选**分类** + 时间/地点；发布必填 = 标题 + 微信 + 时间(或TBD) + 城市 |
| 2 看见 | 局卡呈现；成局进度("已N人/缺X人")显示在局卡**个人化态**；发现页保持简单(紧凑卡) |
| 3 留位 | "留个位置"；必填 姓名+微信，可选 通用联系方式 + 一句话自我介绍 |
| 4 等确认 | host **成局前可见** 姓名+自我介绍(判断依据)；联系方式仍锁 |
| 5 成局 | **整体确认**（host 一键确认、留位者一起进，不逐人审）；触发 = 满→提示 host 确认 / 到时自动锁 / host 手动锁 |
| 6 解锁联系 | **双向**微信+通用联系方式（host↔访客，成局后）；访客之间不互见；**阅后即焚**(R4 已做) |
| 7 会出现 | MVP 仅轻提示"🎉成局了，去加微信群"；倒计时 / 出席邮戳 = V2 |
| 8 未成局兜底 | 到点仍未成局 → **静默隐藏**出公开列表；host 仍可见、可复用 |
| 9 复用 | **一键复用(Clone)**：历史局"再开一局"→克隆预填、时间顺延→改时间即发 |
| 分享 | **局卡(图+二维码)即唯一分享物**；不做文本接龙卡 |

## 跨页成局契约（多页共用，改这里影响多页）
- **成局目标"缺几人"**：局有目标人数；全员见"已 N 人 / 缺 X 人"（人数看板，非名单）；凑满为目标。
- **成局触发**：满 → 提示 host 确认 / 到时自动锁 / host 随时手动锁。
- **成局确认粒度**：**整体确认**（host 一键确认整局成，留位者一起进；**不逐人审**；MVP 无拉黑）。
- **联系方式双盲**：姓名 + 自我介绍 = host **成局前可见**（判断依据）；微信 + 通用联系方式 = **成局后双向解锁**（host↔访客）；**访客之间不互见**；**阅后即焚**（成局后窗口，R4 已做）。
- **留位必填/可选**：必填 姓名 + 微信；可选 通用联系方式 + 一句话自我介绍。
- **局分类(category)**：建局时选 → 驱动局卡设计选择 + 沉淀后台 category（为未来发现/推荐蓄水）。
- **静默隐藏**：到点仍未成局 → 自动从公开列表隐藏；host 仍可见、可一键复用。
- **信任/安全（§6）**：双盲✅(R4) · 阅后即焚✅(R4) · 随录 profile✅ · 静默拉黑=V2 · 邮箱认证=V2。

## 实现逻辑（Step-10A 设计 · 跨页）
> 各页实现细节见对应 PRD 的"实现逻辑"节。这里是跨页 wiring + 迁移 + 任务大纲。
- **⚠️ 成局 ≠ 锁定**：R4 自动锁让临近开始的局都 `is_locked`；**"成局" = 凑满(going≥capacity) OR host 手动锁(`locked_at` 非空)，自动锁(纯到时)不算**。联系方式解锁用 `is_locked`(R4)；静默隐藏用"成局"判定。
- **成局触发"满→提示 host"**：`going ≥ capacity` 且 `locked_at` 空 → host 局卡态2/管理显示"确认成局？"→ 调 `lock_event`(R4)。满前=候补、成局后=停新 RSVP（均 R4）。无新后端。
- **会出现轻提示**：成局后 局卡态2/局详情显示"🎉成局了，去加微信群"。
- **迁移 0022（附加，下一个迁移号）**：`events.category` + `events.card_variant` + `profiles.contact`；recreate `get_event_by_slug`（成局后补返回 category/card_variant/host 联系方式）、`get_public_events`（加静默隐藏 WHERE）。
- **新件**：局卡共享组件（角色感知、两态）；`next/og` 局卡图片路由（嵌 QR、兼 OG）；QR 生成库。
- **任务大纲（建议顺序）**：① 迁移 0022 + RPC 边界测试 → ② 局卡组件 + 图片路由 + QR → ③ 建局(选局卡/成局目标/校验) → ④ 局详情(改 `EventClient`) → ⑤ 管理(改 `[id]/page` + 满→提示成局) → ⑥ 仪表盘(局卡顶 + 一键复用) → ⑦ 设置(昵称/contact/去 /u/) → ⑧ 发现(紧凑卡 + 静默隐藏)。视觉件=Step 10B。
- **测试**：分层 —— 页面/组件轻量单元 + 安全门控(双盲/锁定/微信/静默隐藏 的 RPC)保留 RPC 边界测试 + 全量门禁（vitest + check-boundaries，绝不接 `| tail`）。

## PRD 文件索引
| 文件 | 页 / 组件 |
|---|---|
| [event-card.md](./event-card.md) | **局卡**（核心通用组件） |
| [event-create.md](./event-create.md) | 建局 `/dashboard/events/new` |
| [event-page.md](./event-page.md) | 局详情（访客）`/[slug]` |
| [event-manage.md](./event-manage.md) | 管理（局卡中心化）`/dashboard/events/[id]` |
| [dashboard.md](./dashboard.md) | 仪表盘 `/dashboard` |
| [settings.md](./settings.md) | 设置 `/dashboard/settings` |
| [discover.md](./discover.md) | 发现 `/discover` |
| [auth-landing.md](./auth-landing.md) | 登录/落地 `/login` `/auth/*` `/` |

**砍掉**：`/u/[username]` 主办主页（§5 入口是局不是人；代码保留、MVP 不出口）。

## 路线（V2 / 缓做，登记不漏）
倒计时 · 出席邮戳/票根墙 · host 静默拉黑 · 邮箱后缀认证 · Vibe Filter/黑话筛选 · 宏观城市+微观邻里 · 城市局单策展 ·
首页局卡流 · onboarding 调频 · 局卡态3背面大二维码 · 单独局卡页 · 钱包化 · host 传图包装 · host 简介 · 粘贴一键建局 · 视觉容器系统(4:5/噪点/波普卡/手风琴，Step 10B)。

**🟡 明确不做（V1）**：cohost、photo album、guest approval、questionnaire、comment reactions、reminders、broadcasts、anonymize_guest_list、lat/lng。

## 注记
- **视觉件**（局卡 art / 态过渡 / 分类模板 / 视觉容器系统）走 **Step 10B（Figma）**。
- **实现**走"实现 agent + 独立测试 agent" + **分层测试**（安全门控保留 RPC 边界测试，其余轻量单元测试）。
- **Round-4（微信绑定 + 锁定）已实现并合入 `prelaunch-fixes`**（vitest 679/679、护栏 8/8）：成局闭环第 5/6 步的 DB 与基础 UI。
