# JU 实现日志（Step-10A 落地）

> 自主实现：**开发 agent 写代码、独立 agent 写测试**；每任务 → 自检(typecheck/lint) → 全量门禁(vitest + check-boundaries) → commit → 记录于此。
> 任务大纲见 [README.md](./README.md#实现逻辑step-10a-设计--跨页)。视觉件（局卡 art/分类模板/态过渡/PNG 布局）= Step 10B；品牌 PDF 待补，先做功能/结构、视觉用占位。

## 任务清单（依赖顺序）
1. **迁移 0022 + RPC 边界测试**（基础，PDF/视觉无关）— ✅ 完成
2. 局卡组件 + `next/og` 图片路由 + QR 生成库 — ✅ 完成（**QR 库安装待你**）
3. 建局（成局目标=capacity reframe / 发布校验 +时间/TBD+城市 / category+card_variant；选局卡视觉 picker→Step 10B）— ✅ 完成
4. 局详情（改造 `EventClient`：局卡顶+留位，移 slot，保地址 reveal）— ✅ 完成
5. 管理（改造 `[id]/page`：局卡+展开管理 / 满→提示成局 wiring）— ✅ 完成
6. 仪表盘（局卡顶 + 一键复用 `/new?from=`）— ✅ 完成
7. 设置（昵称合并 / host 通用联系方式 / 去 `/u/`）
8. 发现（紧凑局卡 + 静默隐藏过滤）

## 进度记录
### 任务 1 — 迁移 0022 + RPC 基础　【✅ 完成 2026-06-19】
- 范围：events.category/card_variant + profiles.contact；recreate get_event_by_slug（+category/card_variant 一等；**host_contact 与 host_wechat_id 同一双盲门控**，仅 unlocked+contact_open 时返回）、get_public_events（+静默隐藏 WHERE：未成局-过期 = past + capacity 设了 + going<cap + locked_at 空，用 locked_at 非 is_locked）；web types + view.ts schema。
- 开发 agent + 独立 RPC 边界测试（`web/tests/migration-0022-category-contact.test.ts`，8 例）+ 对抗审查（5 向量全 could-not-refute、无泄露）。
- 门禁：vitest **687/687**、护栏 **8/8**。

### 任务 2 — 局卡组件 + next/og 图片路由 + 卡片纯助手　【✅ 完成 2026-06-19】
- 新件：`web/lib/events/card.ts`（纯助手：initialCardState / spotsNeeded(缺X人,复用 remainingSpots) / viewerStatus / gatheringStatus / cardScanUrl）；`web/components/events/event-card.tsx`（两态、角色感知、reduced-motion，未接入页面、留给任务4-6）；`web/app/[slug]/opengraph-image.tsx`（next/og PNG，1200x630，first-tier-only，**兼作 og:image**）；eventCard i18n（zh+en）。
- **⚠️ 待你（需终端批准）**：QR 库未装。图片路由的二维码处是占位框 + `TODO(QR)` 注释 + 明文 scanUrl；接上只需 `pnpm --dir web add <qr 库>` 再把 cardScanUrl 渲染成二维码。
- **已知 MVP 取舍**：`gatheringStatus 'formed'` 用公开 façade 的 `is_locked`（公开层无法区分手动/自动锁）；`get_public_events` 静默隐藏仍用精确的 `locked_at`，安全/发现逻辑不受影响。任务 5 的"满→提示成局"用 `gatheringStatus 'full-pending'`。
- 测试：`web/tests/task-step10a-card-helpers.test.ts`（19 例纯单测，全绿）。门禁：护栏 **8/8**（typecheck/lint/build + grep + RLS）。

### 任务 3 — 建局功能层　【✅ 完成 2026-06-19】
- 新件 `web/lib/events/category.ts`（占位分类预设 + parseCategory 失败回退 generic）。`schema.ts`：发布校验（intent=publish 需 时间或 date_tbd + 城市；草稿不限）+ 解析 category/card_variant（publish 消息走 next-intl，纯调用方有英文兜底）。`actions.ts`：写 events.category/card_variant。`event-form.tsx`：加 category select + card_variant 隐藏默认 + capacity 文案 reframe 成"成局目标/缺X人"（数据不变）。edit 页查询/预填 category/card_variant。eventForm i18n（zh+en 平价）。
- **保留外观段**（cover/theme/effect）；**选局卡视觉 picker = Step 10B**。
- 测试：`event-schema.test.ts` +14 断言、修 `task-3-timezone.test.ts`（helper 加 city）。建局集成测试经 DB 直插、不过表单，故发布校验不影响它们。
- 门禁：vitest **721/721**、护栏 **8/8**。

### 任务 4 — 局详情 局卡中心化　【✅ 完成 2026-06-19】
- `event-view.tsx` 加 `cardSlot`（有卡时用 EventCard 当 hero、并隐藏重复人数 chip）；`event-client.tsx` 把 EventCard 作 cardSlot、RsvpForm 作 rsvpSlot，**不再 wire 名单/评论/投票 slot**（组件文件 + EventView 的可选 slot props 保留，仅页面层不传）；EventCard 加可选 `initialState` prop，局详情传 `personal` 直显态2（card.ts 未改，19/19 仍绿）。
- **分级安全保留**：地址仅 `event.unlocked` 时渲染（EventView Where 段未改、location_text 只读一次）；RSVP 仍 `!inactive && !locked` 门控；取消/结束/锁定横幅 + host 微信票根 stub 不变。管线全保留（token/poll/handleSubmitted/ended/viewerIsHost/密码解锁路径）。
- 测试：测试 agent 把 `task-4-lifecycle.test.ts` 的脆弱 JSX grep 改写成行为/安全不变量断言（地址解锁门控、RSVP 门控、locked 横幅、卡作 hero）；`task-3.1-guest-list.test.ts` 一条失效 grep 重定向到组件层。
- 门禁：vitest **727/727**、护栏 **8/8**。

### 任务 5 — 管理 局卡中心化 + 满→提示成局　【✅ 完成 2026-06-19】
- `[id]/page.tsx`（仍服务端、RLS 读名单）重排为 EventCard(host 态2)hero + 管理内容作 card 展开 children（统计/名单组/复制联系方式/候补 promote/EventLifecycle/LockEventButton/R4 成局后联系方式面板全保留）。标题/状态徽章/日期留在卡上方作页面 chrome（占位卡无标题槽）。
- **满→提示成局**：页面级 `fullPending = capacity!=null && remaining===0 && locked_at==null`（**用 locked_at 不用 is_locked**，自动锁不触发，贴"成局≠锁定"）→ 醒目"可成局了，确认成局？"提示，复用 R4 的 LockEventButton（无新 RPC）。独立手动锁入口加 `&& !fullPending` 去重。
- 测试：`task-5-host-ux.test.ts` 重定向到新结构（管理控件保留、contact host-only、成局后联系方式面板仍 locked-gated）；`card-helpers` 加 gatheringStatus full-pending 边界断言。
- 门禁：vitest **740/740**、护栏 **8/8**。

### 任务 6 — 仪表盘 局卡顶 + 一键复用　【✅ 完成 2026-06-19】
- 新件 `web/lib/events/clone.ts`（纯）：`cloneEventDefaults(source)` 复制 标题/描述/地点/容量/+1/可见性/rsvp/category/card_variant/chip-in/封面主题特效；时间 **+7 天**（同 wall-clock，date_tbd 透传）；**丢弃 id/slug/status/password/host_id**（防泄露，已测）。
- `new/page.tsx`：读 `?from=`（host 自有 RLS 读源局）→ cloneEventDefaults → 预填 EventForm（wechat 从 profile 补）；非 clone 路径不变。`dashboard/page.tsx`：顶部挂 EventCard(host hero，pickHeroEvent 选最近已发布局，额外读 capacity/locked_at/starts_at)；加"再开一局"→`/new?from=` + "管理"链接；原本地行组件 `EventCard`→ 重命名 `EventListRow`（避免与共享组件撞名，内部 going_count/isHost grep 仍命中）。
- 测试：`task-step10a-clone.test.ts`（19 例纯单测，含防泄露 + 时间 bump + TBD；vitest 无 @/ alias 用 vi.mock 透传真 theme、stub 仅类型用的 event-form）。
- 门禁：vitest **759/759**、护栏 **8/8**。
- 任务 6 ✅ → 任务 7 进行中。
