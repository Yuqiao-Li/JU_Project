# JU — 逐页 Bug 排查（交接文档 · 新对话从这里起）

> **给新对话**：本任务 = **一页一页排查 + 修复功能实现 bug**。先读本文件 + **`docs/AS-BUILT.md`（现状实现总览，最关键）**，再实跑 + 对照各页 PRD。
> `docs/AS-BUILT.md` 记"现在代码里到底是什么、怎么连"（已核验）；本文件记"怎么跑 + 排查方法 + 已知 bug"。
> 品牌 vs 功能对齐审查 = **之后再做**（见 `docs/BRAND-ALIGNMENT-HANDOFF.md`）；先把功能 bug 排干净。

## 一、为什么 bug 多（背景）
Step-10A 功能层是 agent **快速自主实现**的（局卡中心化大重构 + 占位视觉 + 二维码桩），每个任务的门禁是
**RPC 边界测试 / 源码 grep / 纯单元测试 + build**，**没有跑 e2e / 真实渲染** —— 所以
**运行时 / 集成 / 交互 / UX / 数据流类 bug 不会被这些测试抓到**。用户实跑后发现功能实现方面 bug 很多。

## 二、任务
**逐页排查 + 修复功能实现 bug。** 每页：跑起来 → 走主流程 + 边界 → 对照该页 PRD 的"预期行为" → 记 bug → 修 → 复验（测试 + 实跑）。

## 三、怎么跑起来（本地；坑都在这）
- `web/.env.local` 是**占位符**；真值用 `eval "$(supabase status -o env)"`（`API_URL` / `ANON_KEY` / `SERVICE_ROLE_KEY` / `DB_URL`）。本地 API `http://127.0.0.1:54321`，Mailpit（magic-link 邮件）`http://127.0.0.1:54324`。
- **别在主工作树跑 `pnpm dev`**（会和测试/构建抢 `.next/`）。用**隔离 worktree**：
  `git worktree add --detach /home/rain/ju-preview HEAD` → `CI=true pnpm --dir /home/rain/ju-preview/web install`
  → 写 `/home/rain/ju-preview/web/.env.local`（含 `RATELIMIT_BACKEND=memory`，没 Upstash 时限流退化内存版）
  → 用 **next 二进制**直接起：`/home/rain/ju-preview/web/node_modules/.bin/next dev /home/rain/ju-preview/web -p 3001 -H 127.0.0.1`（`pnpm run dev -- -p` 会错传参）。
- **访问/登录一律用 `localhost:3001`，别用 `127.0.0.1`**（auth 回调用 `request.nextUrl.origin`，dev 下解析成 localhost；cookie 是 host 绑定的，混用会被弹回登录）。
- 登录：magic link 进 Mailpit；或用 service role 一键 `generate_link`（本地 `email:demo-host@partiful.local`）。
- seed：公开 slug `demo-summer-rooftop-bash`、私密 `demo-members-only-tasting`、host 账号 `demo-host@partiful.local`（注：`/u/` 主办主页已删除，旧 `/u/demo_host` 不再存在）。
- 全量门禁（要本地 stack 起着、会 db reset、~14min）：`pnpm --dir web test`（**绝不接 `| tail`**，会吞 vitest 退出码）。护栏：`RUN_DB_CHECKS=1 SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres bash ./check-boundaries.sh`。

### 哪些"不是 bug"（预期占位，别误报）
- **二维码**：`opengraph-image.tsx` 的 `TODO(QR)` 处是占位框 + 明文链接 —— 二维码库还没装（需 `pnpm --dir web add <qr>`，需终端批准）。装了才有真二维码。
- **视觉占位**：局卡 art / 态过渡动画 / 分类局卡模板 / 选局卡 picker / 紧凑发现卡 / PNG 排版 = **Step 10B**（待品牌 PDF）。排查聚焦**功能/交互/数据**，不是视觉打磨。
- **名单/评论/日期投票**在活动页**不显示** = MVP 故意移出（代码保留，非 bug）。

## 四、逐页清单 + 预期行为（对照排查；细节见 `docs/prd/<page>.md`）
1. **登录/落地** `/login` `/` — magic link / OTP / Google；落地页 CTA（建局/浏览）。
2. **建局** `/dashboard/events/new` — 单屏建局；容量字段文案=成局目标"缺X人"（数据仍是 capacity）；**发布必填 = 标题 + 微信 + 时间(或勾TBD) + 城市**（草稿不限）；分类 `<select>`（可选，默认 generic）；card_variant 隐藏默认；发布/存草稿；`?from=<id>` 复用预填（时间 +7 天）。
3. **局卡** `components/events/event-card.tsx` + `app/[slug]/opengraph-image.tsx` — 两态（态1 图=路由 PNG / 态2 个人化：你的状态 + 已N人/缺X人 + 已成局标识）；角色感知（host/guest）；点开展开 children。
4. **活动页** `/[slug]` — 局卡（态2 直显）在顶 + 留位表单在下（姓名/微信必填 + 可选 通用联系/一句话介绍 + going/maybe/not）→ 提交后整页变个人化局卡；成局后地址解锁（轮询）；取消/结束/锁定横幅；密码门。
5. **管理台** `/dashboard/events/[id]` — 局卡(host)hero + 点开展开=管理（统计/名单组/确认成局/编辑/生命周期/成局后联系方式面板/候补提升/复制联系方式）；**满→提示成局**（满且 `locked_at` 空 → "可成局了，确认成局？" → LockEventButton → lock_event）。
6. **仪表盘** `/dashboard` — 顶部当前/最新局的局卡 + "再开一局"(→`/new?from=`)/"管理"链接；我主办 + 我参加列表 + 计数。
7. **设置** `/dashboard/settings` — 单"昵称"(=display_name，必填) + 微信 + 通用联系方式；**无用户名输入、无 /u/**。
8. **发现** `/discover` — 公开活动网格；**未成局-过期 静默隐藏**（`get_public_events` 过滤）；紧凑局卡视觉=Step 10B。

## 五、重点怀疑区（快速实现 + 大重构，最易出 bug）
- 局卡两态切换 / `initialState` / 态2 数据来源（缺X人 = `capacity_remaining`；你的状态 = token + `unlocked` + `is_locked`）。
- 活动页重构后的 **留位 → 保存 → 个人化局卡** 闭环；成局后地址/联系方式解锁的轮询是否仍触发。
- 管理台把整套管理塞进局卡展开后的 **server 组件 + client 子组件** 组合渲染/交互。
- 满→提示成局触发（必须 `locked_at` 判、非 `is_locked`）。
- `?from=` 复用预填（字段映射、时间 +7 天、wechat 从 profile 补、不泄露 id/slug/status/password）。
- 设置删用户名后 `updateProfile` 的 `contact` 写入 + 页面预填 + 不再写 username。
- 发布校验新增（时间/TBD + 城市）是否误伤 **草稿 / 编辑已发布局**。
- 新增 i18n key（`eventCard` / `dashboard` / `settings` 命名空间）是否齐、zh/en 平价。
- 局卡 `<img>` 指向的 `opengraph-image` 路由在各态/各事件下是否 200 出图。

## 六、修复流程（沿用本项目工作模式）
- 修复由**实现 agent** 写、测试由**独立 agent** 写（分层：页面/组件轻量单元 + 安全门控保留 RPC 边界测试）。
- 每修一项 → `pnpm --dir web typecheck`/`lint` 自检 → 全量门禁（vitest + check-boundaries，**不接 `| tail`**）→ commit（规范化信息）→ 记 `docs/prd/IMPLEMENTATION-LOG.md`。
- **安全语义（双盲 / 锁定 / 微信 / 静默隐藏 的 DB 门控）是硬约束，修 bug 不得弱化。**
- 分支 `prelaunch-fixes`（已推 GitHub，到 `cf7bc26`）。

## 七、已知 bug（用户报告 —— 待填）
> 把你发现的 bug 列在这里：**页面 / 现象 / 复现步骤 / 期望**。新对话据此优先修；也会逐页自查补充。
>
> - （示例）页面：xxx；现象：xxx；复现：xxx；期望：xxx。
