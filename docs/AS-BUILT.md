# JU 现状实现总览（Step-10A 后 · 按页 + 模块）

> **这是实际实现状态**（Round-4 + Step-10A 任务 1–7 后，已核验代码）。供 bug 排查对照"应有 vs 现有"。
> 设计/意图见 `docs/prd/`；本文件记"**现在代码里到底是什么、怎么连**"。bug 排查见 `docs/BUG-HUNT-HANDOFF.md`。
> **占位/桩/缓做（非 bug）**：二维码桩、Step-10B 视觉占位（局卡 art/态过渡/分类模板/选局卡 picker/紧凑发现卡）、活动页移出名单/评论/投票（组件保留、不渲染）。
> **门禁基线**：vitest 757、护栏 8/8（逐任务过）。⚠️ 仅覆盖 **RPC 边界 / 源码 grep / 纯单元 + build**，**非 e2e/渲染** —— 运行时/交互 bug 未覆盖。

---

## A. 后端 / 数据层（成局基座）
- **迁移 0021（R4）**：`profiles.wechat_id` / `events.locked_at` / `guests.wechat_id`；RPC `lock_event`（host-only、不可逆 null→now）、`get_event_guest_contacts`（host-only、锁定+窗口门控）；`get_event_by_slug` +`is_locked`/`host_wechat_id`（仅 unlocked 且 contact_open 时）；`submit_rsvp` +`wechat_id`（going/maybe 必填）+ 锁定即拒；列级 revoke（撤表级 grant、逐列重授，排除 `guests.wechat_id` SELECT、`events.locked_at` UPDATE）。
- **迁移 0022（Step-10A T1）**：`events.category` / `events.card_variant` / `profiles.contact`；`get_event_by_slug` +`category`/`card_variant`（一等、公开）+ `host_contact`（与 `host_wechat_id` **同一双盲门控**）；`get_public_events` +**静默隐藏过滤**（排除 未成局-过期 = `past + capacity!=null + going<capacity + locked_at IS NULL`，**用 locked_at 非 is_locked**）。
- **关键语义**：**成局 = 凑满 OR host 手动锁(`locked_at`)**；**`is_locked` = 手动 OR 到时自动锁**（R4 派生，临近开始即真）。→ 静默隐藏 / 满→提示成局 用 **`locked_at`**；联系方式揭示用 **`is_locked` + contact_open**（阅后即焚窗口）。
- **容量复用**：`capacity` 即"成局目标"；缺X人 = `remainingSpots(capacity, going)`（`lib/events/capacity.ts`）；满 → 候补（`submit_rsvp`）。

## B. 共享组件 / 纯助手
- **局卡** `components/events/event-card.tsx`（'use client'）：两态 `art`/`personal`；`mode: host|guest`；可选 `initialState` prop；点开展开 `children`（**仅 children!=null 才显展开 toggle**）；reduced-motion 安全（matchMedia，SSR 无动画）。态1 = `<img>` 指向局卡图路由；态2 = DOM（缺X人 + 你的状态 + 成局状态）。
- **局卡图路由** `app/[slug]/opengraph-image.tsx`（`next/og` ImageResponse，1200×630，force-dynamic）：**first-tier-only**（city + time，无地址/名单/联系方式）；**二维码 = 占位框 + 明文 `cardScanUrl` + `TODO(QR)`**（库未装）；**兼作 og:image**；`readEventBySlug` 无 token 读。
- **`lib/events/card.ts`**（纯）：`initialCardState` / `spotsNeeded`（复用 remainingSpots）/ `viewerStatus`(none/reserved/locked-seat) / `gatheringStatus`(open/full-pending/formed，**formed 用公开 is_locked**) / `cardScanUrl`。19 单测。
- **`lib/events/clone.ts`**（纯）：`cloneEventDefaults` 复制内容字段、**时间 +7 天**、**丢 id/slug/status/password/host_id**。19 单测。
- **`lib/events/category.ts`**（纯）：占位分类预设 + `parseCategory`（失败回退 generic）。

## C. 各页现状

### 落地 `/` + 登录 `/login` `/auth/*`
- **未改**（R4/prelaunch 基线）：落地营销首屏 + CTA（建局/浏览）；登录 magic link / OTP / Google；访客永不登录。

### 建局 `/dashboard/events/new`（共享 `event-form.tsx` + `lib/events/schema.ts` + `actions.ts`）
- **功能**：单屏建局 —— 标题/描述、**外观段仍在**（封面 CoverUploader / 主题色 / 特效）、时间(+TBD)、地点(城市/地址/地图)、容量、+1、RSVP 开关、Chip-in、公开/私密、密码、主办微信、发布/草稿。**新增**：分类 `<select name="category">`（可选、默认 generic）+ `card_variant` 隐藏默认 + 容量文案 reframe 成"成局目标/缺X人"（数据仍是 capacity）+ **发布校验 时间(或TBD)+城市必填** + `?from=<id>` 复用预填（cloneEventDefaults，wechat 从 profile 补）。
- **逻辑**：`parseEventForm`（zod；intent=publish 时校验 时间/TBD + 城市；解析 category[parseCategory]/card_variant）→ `createEvent`/`updateEvent` 写 events 含 category/card_variant。**选局卡视觉 picker = Step 10B**（现仅 category 下拉 + 隐藏 variant）。

### 局详情（访客）`/[slug]`（`event-client.tsx` + `event-view.tsx`）
- **功能**：EventCard（态2 直显，`initialState=personal`）作 **hero**（event-view 的 `cardSlot`）+ 留位表单（RsvpForm，`rsvpSlot`）在下；提交 → `handleSubmitted` 重读解锁 → 个人化；成局后**地址解锁**（`event.unlocked` 门控，EventView Where 段，location_text 只读一次）；取消/结束/锁定横幅；密码门；AddToCalendar（first-tier）。**名单/评论/日期投票 slot 不再 wire**（组件 + EventView 可选 slot props 保留）。
- **逻辑**：SSR `readEventBySlug` → EventClient（token from localStorage → 轮询 `/api/events/[slug]?token=` → applySnapshot；可见性感知轮询；retryUnlock；ended/viewerIsHost；密码解锁路径不变）。分级安全在 event-view + 数据层。

### 管理台 `/dashboard/events/[id]`
- **功能**：服务端组件（host RLS 读 event + roster）。页面 chrome（标题/状态/private/locked 徽章 + 日期）在卡**上方**；EventCard（host，`initialState=personal`，`record=null`）作 hero；**管理内容作 card 展开 children**：统计(going/maybe/spots) + going/maybe/declined 名单组(含 contact，host-only) + 复制全部联系方式 + 候补+PromoteButton + EventLifecycle(发布/下架/取消/删除) + LockEventButton(R4 两步锁) + **成局后联系方式面板**(`get_event_guest_contacts`，`locked` 时)。
- **满→提示成局**：`fullPending = capacity!=null && remaining===0 && locked_at==null` → 醒目"可成局了，确认成局？" → 复用 **LockEventButton**(`lock_event`，无新 RPC)；独立手动锁入口 `&& !fullPending` 去重。

### 仪表盘 `/dashboard`
- **功能**：顶部 EventCard（host hero，`pickHeroEvent` 选最近已发布局，额外读 capacity/locked_at/starts_at 算 heroLocked）+ "再开一局"(→`/new?from=<id>`)/"管理"(→`/[id]`) 链接；我主办 + 我参加列表（原本地行组件改名 **EventListRow**，避免与共享 EventCard 撞名；going_count/isHost 内部不变）；每个 hosted 行也有"再开一局"链接；计数。

### 设置 `/dashboard/settings`（`profile-form.tsx` + `actions.ts` + `page.tsx`）
- **功能**：单 **"昵称"(=display_name，必填)** + 微信 + **通用联系方式(`profiles.contact`，可选 ≤200)**；**无用户名输入 / 无可用性检查 / 无 /u/**。`updateProfile` 写 `{display_name, wechat_id, contact}`（own-row scoped；空 contact→null）。host 的 微信+通用联系方式 = 成局后才向访客揭示（T1 的 get_event_by_slug）。
- **保留闲置（不删）**：`get_public_events_by_host` RPC、`read-public-events`、`username` 列/唯一索引、`/api/username-check`、`lib/profile/username.ts`。

### 发现 `/discover`
- **功能**：公开活动网格（现有 `public-event-card.tsx`）+ **静默隐藏过滤已生效**（`get_public_events` 排除 未成局-过期）。**紧凑局卡变体 = Step 10B**（现仍用旧卡）。

### ~~`/u/[username]`~~ —— 已删除
- 删 `page.tsx` + `loading.tsx`；移除所有 /u/ 链接（活动页 hostedBy 本就纯文本）。RPC/列保留闲置。

---

## D. 提交对照（prelaunch-fixes，已推 GitHub 到 `3312bee`）
`a6e4e14` T1 迁移0022 · `8fde12a` T2 局卡 · `ef8e7fa` T3 建局 · `075abf6` T4 局详情 · `20dee86` T5 管理 · `8ea8089` T6 仪表盘 · `cf478d8` T7 设置/删/u/。逐任务进度见 `docs/prd/IMPLEMENTATION-LOG.md`。
