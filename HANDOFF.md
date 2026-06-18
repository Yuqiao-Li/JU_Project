# JU — 交接文档 (HANDOFF)

> 2026-06-18 重写。这份文档让任何人 / 全新会话能立刻接手并执行「第二轮（Round 2）验收修复」。配套文件：`AUDIT.md`（92 条问题清单 = 原始待办源头）、`DEPLOY.md`（部署填空清单）、`SECURITY.md`（安全审查报告）、`CLAUDE.md`/`SCHEMA.md`/`TASKS.md`（项目宪法 / 数据模型 / 任务）。Claude 记忆目录里另有 `prelaunch-fix-progress`、`running-web-app-locally`、`deployment-is-manual-run-is-local`、`product-review-findings`、`source-grep-tests-and-test-exit-code`、`check-boundaries-literal-token-bans`、`vitest-harness-constraints` 等。

---

## 1. 这是什么

**JU** = 给**北美华人**用户的活动邀请平台（Partiful 的简化、可商用克隆）。核心闭环：主办建活动 → 分享公开链接 → 访客**无需注册**用链接 RSVP（名字 + 可选联系方式）。主办有账号、访客没有。

- **后端**：Supabase（Postgres + RLS + Auth + Storage + RPC），无独立 API server。**数据库是安全边界**：访客读写只经 `SECURITY DEFINER` RPC；anon 对客数据表零直接权限；host 经 RLS（`host_id = auth.uid()`）只碰自己的活动；私密活动只经可信 service-role SSR 读；完整地址 / 客人名单是二级字段（RSVP 解锁后才给）；`contact` 仅主办可见、非身份键；`guest_token` 存 localStorage、绝不进 URL。
- **前端**：Next.js **16.2.9**（App Router，**非标准版，文档在 `web/node_modules/next/dist/docs/`，遇到版本相关问题先查那里**）+ TS strict + Tailwind v4 + next-intl。pnpm。
- 这项目原本由一个无人值守 agent 流水线（`run-agent.sh` + `check-boundaries.sh`）自己写出来的；流水线已跑完（TASKS.md 全 `[x]`），之后进入手动「上线前修复」阶段。

### ⚠️ 受众修正（关键）

本应用面向**北美华人（华人 in North America）**，**不是中国大陆用户**。这条修正**推翻**了早前 Batch-3 的两个决定：

- ❌「全站单一中国时区（Asia/Shanghai）」—— 改为 **Option 3 观看者本地时区**（见 §4）。
- ❌ 中国城市 / 地址占位文案 —— 改回美国城市 / 地址（见 Round-2 第 5 项）。
- ✅ chip-in 用 **Venmo 是正确的**（北美习惯）—— **保留，不要动**。
- ✅ 个人名占位（小雨 / 陈小明）是文化中性的人名、**不是**地理数据 —— **不要动**。

---

## 2. 当前状态（2026-06-18 确认，最重要）

**分支 `prelaunch-fixes`（从 master 切出）上完成了「上线前修复」的全部阻断 + 高危批次。**

- 当前 HEAD：**`0582cbb`**。迁移已到 **0019**。下一个迁移用 **0020**。
- ✅ 全量测试 **491 用例 / 40 文件全绿**。
- ✅ 护栏 `check-boundaries.sh` **8/8** 全过（含 DB 权威 RLS）。
- ✅ 独立多 agent 安全复核：**0 条可利用漏洞**（曾发现 1 条新引入低危 oracle，已用迁移 0019 关闭并复验）。
- ✅ `master` 和 `prelaunch-fixes` 都已推到 GitHub `Yuqiao-Li/JU_Project`。

### 部署现状（已修 vs 待修）

| 状态 | 项 |
|---|---|
| ✅ 已修 | **env 内联 bug**（提交 `a6abb0f`）：`env.ts` 必须用**字面量** `process.env.NEXT_PUBLIC_X` 读取，Next 才会把它内联进客户端 bundle。回归测试 `web/tests/env-client-inlining.test.ts`（含 `0582cbb` 的注释剥离修正）守住它。 |
| ✅ 已修 | `NEXT_PUBLIC_SUPABASE_URL` 现为正确的 base URL（**无 `/rest/v1/`**）。 |
| ✅ 已配 | Resend SMTP 已配，**magic-link 邮件能正常收到**。 |
| ✅ 已验 | **Vercel preview 已上线且为中文**（= 已确认是修好的版本）。 |
| ⚠️ 待修 | Supabase Auth「**Site URL**」目前指向 **production（master）**，导致 magic-link 邮件把用户登入到**未修复的 master 应用**。须把 **Site URL + Redirect URLs** 设到 **preview（及日后 prod）域名**（`.../auth/callback`，外加 `/**`）。 |
| ⚠️ 待修 | 设 **`NEXT_PUBLIC_SITE_URL`**（M49 登录重定向依赖它）。 |
| 🔒 待办 | **轮换 JWT secret**：调试时 service_role key 曾被贴进聊天 → 公开上线前必须在 **Supabase Settings → API** 轮换。 |

**云端验收一键登录（绕过邮件）**：用 service_role 调 `POST {SUPABASE_URL}/auth/v1/admin/generate_link`，body `{type:"magiclink", email, redirect_to:"{preview}/auth/callback"}`，取返回的 `hashed_token`，浏览器开 `{preview}/auth/callback?token_hash=<...>&type=magiclink`（一次性、用完即失效）。

### 工作模式（用户强制要求，务必延续）

**实现由实现 agent 写；测试一律由「独立 agent」写**（全新上下文、把实现当黑盒、只碰 `tests/`、对抗性地按 spec 测）。每批：实现 → 独立测试 agent → **跑全量门禁**（`pnpm --dir web test`，**绝不接 `| tail`**，会吞掉 vitest 退出码、曾误报绿）→ 用规范化提交信息 commit。**orchestrator 永不改 TASKS 的 `[ ]`/`[x]` 标记。** 在 ultracode 下，实质性的多步工作走 **Workflow**。迁移：编号唯一、不可改已应用的、CLI 按**前导数字**去重（别再撞号），下一个是 **0020**。这套机制实战抓到 2 个真 bug（见 §3）。

---

## 3. 已完成（批次 → 提交）

| 批次 | 内容 | 提交 |
|---|---|---|
| 1/1b | next-intl 双语基建（默认中文、`NEXT_LOCALE` cookie、无 URL 路由）+ 中文字体回退 + 全站可见 UI 中文化 + 语言切换 | `5eaa57c` / `4c5316d` |
| 2 | 改名 Partiful → JU（保留 localStorage 前缀 `partiful:rsvp:` 以免老 token 失效；保留名加 "ju"） | `78b6893` |
| 3 | 时区（**已被受众修正推翻，待 Round-2 重做**）：当时按北京 +08:00 存为 UTC、全站 zh-CN/Asia-Shanghai 显示 | `d37a580` |
| — | 独立测试补全（B3 时区、重写 B4、加强 B1b） | `476d069` |
| 4 | 活动生命周期：取消 / 删除 / 发布动作（RLS 授权）+ updateEvent 不复活已取消 + 公开页「已取消 / 已结束」横幅并禁 RSVP/投票/加日历 + draft 死链提示 + 以访客预览 | `b7556f0` |
| 5 | 主办 UX：`get_my_events` 返回人数计数（迁移 **0017**）→ 仪表盘卡片显示；复制全部联系方式 | `551a37b` |
| 6 | RSVP/解锁：H14 解锁失败给重试反馈；**H16 跨设备账号解锁**（迁移 **0018**：`get_event_by_slug`/`guest_unlock_status` 加可信 `viewer_id`，仅 service_role 认）；M26 候补文案 | `842a68f` |
| 7 | 数据丢失防护 + Auth：登录重发链接 + 冷却（H22）、M49 重定向用 `NEXT_PUBLIC_SITE_URL`、H21 auth 回调错误处理、H19 清空用户名需确认、H20 RPC 错误抛到 error.tsx 而非空态 | `aabcb0a` |
| 安全收口 | 迁移 **0019**：`guest_unlock_status` 也只对 service_role 采信 viewer_id（关闭 anon RSVP-出席 oracle） | `3ce3530` |
| 部署修复 | **env 内联 bug 修复**（`env.ts` 字面量读 `NEXT_PUBLIC_*`）+ 回归测试 | `a6abb0f` / `828a54d` / `0582cbb` |

**独立测试 agent 抓到的真 bug**：① B5 迁移文件名撞 `0016_date_poll`（CLI 按数字前缀去重 → 没生效，已改名 0017）；② 安全复核发现 0018 的 `viewer_id` 在 helper 内无信任校验（已 0019 修）。

---

## 4. 关键决策 / 约定（别推翻）

- **i18n**：中英双语 next-intl，默认中文，cookie `NEXT_LOCALE`，**无 URL 路由**；客户端组件 `useTranslations`、服务端 `getTranslations`；文案在 `web/messages/{zh,en}.json` 按 namespace。
- **时区 = Option 3（观看者本地）**：DB 存**绝对 UTC 瞬时**（已是如此，正确）；显示按**每个观看者自己的浏览器本地时区**，并带清晰时区标签。**注意 SSR 水合陷阱**：服务器不知道观看者时区，朴素切换会造成 React hydration mismatch —— Next 16.2.9 自带解法（`web/node_modules/next/dist/docs/01-app/02-guides/preventing-flash-before-hydration.md`：client `LocalDate` 组件 + InlineScript + `suppressHydrationWarning`）。详见 Round-2 第 4 项。
- **Supabase key**：用 **legacy anon / service_role**（经典 `eyJ...` JWT），**不用**新的 `sb_publishable`/`sb_secret`——代码和测试都只按 legacy 验证过。这与下面 404 BLOCKER 直接相关。
- **迁移**：编号唯一、不可改已应用的；最新 **0019**，下一个用 **0020**。CLI 按**前导数字**去重（别再撞号）。
- **测试坑**：别把 `pnpm test` 接管道（`| tail` 会吞掉 vitest 退出码）；有些测试 grep 源码里的硬编码英文 / 签名 / 文案，改它们会打破测试，需独立 agent 同步更新（保留安全意图）。
- **护栏字面量禁词**：`check-boundaries.sh` 会在所有 web 文件（含注释）里 grep 一批禁词（`sessionStorage`、`service_role`、未上线功能名等）；实现新代码前确认不触发，连提及都别。

---

## 5. 本地怎么跑 / 测（坑都在这）

- `web/.env.local` 默认是**占位符**；真实本地值用 `eval "$(supabase status -o env)"` 取（`API_URL`/`ANON_KEY`/`SERVICE_ROLE_KEY`/`DB_URL`）。本地 API `http://127.0.0.1:54321`，Mailpit（magic-link 邮件）`http://127.0.0.1:54324`。
- **别在主工作树跑 `pnpm dev`**（会和测试 / 构建抢 `.next/`）。用隔离 worktree：`git worktree add --detach /home/rain/ju-preview HEAD` → `CI=true pnpm --dir <wt>/web install` → 写 `.env.local`（含 `RATELIMIT_BACKEND=memory`，没 Upstash 时限流自动退化内存版）→ 用 **next 二进制**直接起：`<wt>/web/node_modules/.bin/next dev <wt>/web -p 3001 -H 127.0.0.1`（`pnpm run dev -- -p` 会错传参数）。
- **本地访问 / 登录一律用 `localhost:3001`，不要 `127.0.0.1`**：auth 回调用 `request.nextUrl.origin`（dev 下解析成 localhost），cookie 是 host 绑定的，混用会被弹回登录。
- 本地登录：magic link 进 Mailpit；或用 service role 一键生成登录链接（同 §2 的 generate_link 思路，本地 `email:demo-host@partiful.local`）。
- seed 演示：公开活动 slug `demo-summer-rooftop-bash`、私密 `demo-members-only-tasting`、主办主页 `/u/demo_host`，host 账号 `demo-host@partiful.local`。
- 全量门禁：`pnpm --dir web test`（要本地 stack 起着、会 db reset，~12 分钟）。护栏：`RUN_DB_CHECKS=1 SUPABASE_DB_URL=... bash ./check-boundaries.sh`。

---

## 6. 🔴 当前优先级 #1：Round-2「404 BLOCKER」最可能根因 + 必跑诊断

> **症状**：一个**已发布（published）**的活动，在「公开链接」和主办的「以访客身份预览」两个链接上**都 404**（不是 500）。

### 最可能根因（high confidence）

**Vercel preview 部署上的 `SUPABASE_SERVICE_ROLE_KEY` 环境变量是错的 / 过期的 / 格式不对**，导致公开页 SSR 用 service-role 调 `get_event_by_slug` 失败，`readEventBySlug` 返回 `null` → `notFound()` → 对**每个**活动页（两个链接都）404、且**无 500**。

为什么是这条：

- 公开页（`web/app/[slug]/page.tsx`）只有两处会 `notFound()`：`if (!event)`（RPC 返回 null）和 `status === "draft"`。主办仪表盘**只有在 `status==='published'` 时**才渲染「以访客身份预览」链接，所以该行**确为 published**，draft 闸门排除 → 只剩 `event === null` 一条路。
- `readEventBySlug`（`web/lib/events/read-event.ts:61-70`）走 **service-role 客户端**（`createServiceClient()` → `SUPABASE_SERVICE_ROLE_KEY`），在 `if (error || data == null) return null`（**第 70 行**）把 auth 错误**静默吞成 null**。主办仪表盘自己的读用的是**用户 RLS 客户端**（anon key + 用户 JWT，**不同凭证**）—— 这正解释了为何主办能发布、能在仪表盘看到活动，但每个 `/{slug}` 公开渲染都 404。
- **缺失** key 会在 `env.ts` 的 `missing()` 抛错（→ 表现为 500），所以观察到的 404 = key **存在但值错**，不是没设。

两个具体触发器都记录在本仓库里：
1. service_role key 曾被贴进聊天，被要求**上线前轮换 JWT secret**（§2）—— 轮换会让旧 service_role JWT 失效，部署上的旧值就会开始失败。
2. 代码只对 **legacy `eyJ...` JWT** 验证过、**不对**新的 `sb_secret` key（§4）；而 `DEPLOY.md` 只说「从 Settings → API 复制」，现代 dashboard 默认露出的是新版 `sb_secret` key —— 很可能贴成了 `supabase-js` 拒绝的 `sb_secret` 值。

### 必跑诊断（先跑这个）

**第 0 步（最快、最权威，先跑这个）**：Supabase Dashboard → **SQL Editor** 跑
`select slug, status, visibility from public.events order by created_at desc;`，直接看那条活动的**真实 status**——这一步一刀切开「发布流程 bug」与「key 错」两条根因：

- 若 `status` **不是** `published`（仍是 `draft`）→ 根因是**发布流程没真正 flip 状态**（活动其实是草稿，公开页按设计 404），**与 key 无关**。去查发布动作（`app/dashboard/events/actions.ts` 的 `setEventStatus` + 仪表盘发布按钮是否真把 status 改成 `published`），本节其余 key 诊断可跳过。
- 若 `status` **是** `published` → 排除发布流程，根因大概率是 service-role key，按下面 (A)/(B) 继续。

然后用**当前设在 Vercel preview 上的那把 key**、配真实已发布 slug，对云端 DB 跑两个 RPC 探针：

```bash
# (A) 用 anon key —— 用户已见它返回 200，确认行存在且 published
curl -s 'https://<PROJECT>.supabase.co/rest/v1/rpc/get_event_by_slug' \
  -H 'apikey: <ANON_KEY>' -H 'Authorization: Bearer <ANON_KEY>' \
  -H 'Content-Type: application/json' -d '{"slug":"<REAL_SLUG>"}'
# 期望：一个含 "status":"published" 的 JSON 对象

# (B) 用 Vercel 上那把 SERVICE_ROLE key（原样复制）
curl -s -w '\nHTTP %{http_code}\n' 'https://<PROJECT>.supabase.co/rest/v1/rpc/get_event_by_slug' \
  -H 'apikey: <SERVICE_ROLE_KEY>' -H 'Authorization: Bearer <SERVICE_ROLE_KEY>' \
  -H 'Content-Type: application/json' -d '{"slug":"<REAL_SLUG>"}'
```

- 若 **(A) 返回行、(B) 返回 401 / "Invalid API key" / null** → Vercel 上的 service-role key 错 / 过期，**根因确认**。
- 解码这把 key：`<KEY 的第二段> | base64 -d`，核对 `"role":"service_role"` 且 `"ref"` 匹配项目。若它**不是** 3 段式 `eyJ` JWT 而是 `sb_secret...` → 新旧 key 格式弄错，确认无疑。
- 同时在 Vercel：Settings → Environment Variables → 确认 `SUPABASE_SERVICE_ROLE_KEY` **对 Preview 环境作用域**存在（Vercel 按环境分作用域，只设给 Production 的不会进 preview build）。

### 修复

1. 在 Vercel **PREVIEW** 部署上，把 `SUPABASE_SERVICE_ROLE_KEY` 重设为项目的 **legacy service_role JWT**（Settings → API →「JWT-based / Legacy keys」里那串长 `eyJ...`，**不是** `sb_secret`、**不是** anon），且对应 `NEXT_PUBLIC_SUPABASE_URL` 指向的同一项目。
2. 若 JWT secret 已按 §2 轮换，则复制**轮换后新发的** legacy service_role key。
3. 确认值设给 **Preview** 作用域。
4. **重新部署**（env 改动不会作用于已存在的 build）。重部署后同一 `/{slug}`（分享链接 + 以访客预览）应正常渲染。
5. 硬化（**已完成 ✅，提交 `5623eb4`**；不修也能解 404，但能让任何环境下的复发自带诊断）：`read-event.ts` 现已区分「RPC/auth 错误」与「确实不存在」——遇到真正的 RPC 错误或 schema 漂移**大声失败（throw → 500 / `app/error.tsx`）**，只有 `data == null`（无 error）才返回 null（保留「私密 vs 不存在」不可区分性）。纯分类逻辑抽到新文件 `read-event-core.ts` 便于测试（独立 agent 写了 11 条黑盒测试钉住）。仿照仓库既有的 `read-public-events.ts`「ERROR vs EMPTY (H20)」模式。**这把旧的静默 404 变成会指明根因（service-role key 错/过期）的显式报错，但不替代上面 1–4 步的 Vercel env 修复。** 仍待办：`DEPLOY.md` 明确写「用 legacy service_role JWT，别用 sb_secret」。

### 还需排除的开放问题

- JWT secret 是否真的在 key 被贴进聊天后轮换过？若是，轮换前发的任何 service_role key 现已失效，须重新复制。
- 用户是否复制了新格式 `sb_secret...` 而非 legacy `eyJ...`？解码部署上的 key 即可判定。
- 云端迁移是否已推到 0019？（**较低优先**：未应用的 0018 只会破坏「已登录观看者 viewer_id」分支，不影响匿名公开链接，**无法解释两个 404 都出现** —— 但仍值得确认 schema 已到 0019 以彻底排除。）

---

## 7. Round-2 完整修复清单（下一会话执行）

> 优先级：BLOCKER > HIGH > MEDIUM > FUTURE。每项给了根因（file:line）、修复方向、爆炸半径、必要的「先确认」诊断。**实现走实现 agent、测试走独立 agent、每批跑全量门禁。**

### 1. 🔴 [BLOCKER] 已发布活动的公开链接 + 「以访客预览」→ 404（真 bug）

- **根因**：Vercel preview 上 `SUPABASE_SERVICE_ROLE_KEY` 错 / 过期 / 用了新格式 sb_secret；SSR service-role 读 `get_event_by_slug` 失败 →（**修前**）`read-event.ts:70` 静默返回 null → `[slug]/page.tsx` `notFound()`。详见 **§6**（含必跑诊断与修复步骤）。
- **⚠️ 状态更新（提交 `5623eb4`）**：`read-event.ts` 已硬化为**大声失败**——RPC/auth 错误现在 throw（→ 500 / `error.tsx`）而非静默 404，旧的「:70 吞 null」路径**已不存在**（纯分类逻辑在新 `read-event-core.ts`，11 条黑盒测试）。**但 BLOCKER 本体仍未解：真正要改的是 Vercel preview 的 `SUPABASE_SERVICE_ROLE_KEY`**（legacy `eyJ…` JWT、Preview 作用域、重部署）——硬化只是把症状从「静默 404」变成「会报根因的 500」。
- **爆炸半径**：`web/lib/supabase/service.ts`（createServiceClient）、`web/lib/supabase/env.ts`（supabaseServiceRoleKey）、`web/lib/events/read-event.ts` + 新 `web/lib/events/read-event-core.ts`（**已硬化：大声失败，提交 `5623eb4`**）、`web/app/[slug]/page.tsx`（null→notFound）、**Vercel env `SUPABASE_SERVICE_ROLE_KEY`（Preview 作用域）= 真正要改的东西**、`DEPLOY.md`（legacy vs sb_secret 说明）。
- **先确认**：跑 §6 的 (A)/(B) curl 探针 + 解码 key（先跑 §6 第 0 步 SQL 看 status）。

### 2. 🟠 [HIGH] 主题色 + 特效在活动页不渲染

两个不同问题：

- **特效（真「根本不生效」）**：`events.effect` 被存盘、被 `get_event_by_slug` 返回、被 zod（`lib/events/view.ts:26`）round-trip 进编辑表单，但**没有任何组件读 `event.effect` / 渲染 confetti/glow/balloons**。`theme.ts:42` 的 `EFFECT_PRESETS` 只在表单里被「定义」；`globals.css` 只有 `aurora-breathe`/`guest-enter`，**没有任何特效的 @keyframes**。这是渲染层的设计缺口（已用 grep 确认：`event.effect` 仅出现在 `edit/page.tsx:74` 与 `event-form.tsx`，无任何 render 组件引用）。
- **主题色（能用但被压制）**：theme color 是端到端通的（存 `events.theme` jsonb `{color}`、`event-view.tsx:60` 读为 `accent`、内联 style 上色），但它最显眼的用处 hero 渐变在 **`event-view.tsx:211-216` 设了封面图时被整段替换**；其余 accent 用法（小圆点 :100-104、when 文字 :239、按钮淡色）很细微，所以带封面图的主办感觉「没效果」。theme 走内联 style **不是** Tailwind class，**无 v4 safelist 问题**。
- **根因**：①effect 是 render-time dead feature；②theme color 被封面图遮盖。
- **修复方向**：①新建 `web/components/events/event-effect.tsx`（client，按 `confetti|glow|balloons` 渲染 `absolute inset-0 pointer-events-none` 覆盖层，**带 `prefers-reduced-motion` 守卫**），在 `event-view.tsx` 读 `event.effect` 并在 hero/article 渲染；在 `globals.css` 加对应 @keyframes（仿 `aurora-breathe`，reduced-motion 守卫）。②产品决策：封面图存在时是否仍让 accent 可见（如 hero 上保留 accent ring/scrim 淡色 `event-view.tsx:218-224`），至少别让封面把所有 accent 线索抹掉。
- **爆炸半径**：`web/components/events/event-effect.tsx`（新）、`web/app/[slug]/event-view.tsx`（渲染 + 可选 accent-over-cover）、`web/app/globals.css`（@keyframes）、可选 `web/app/[slug]/event-client.tsx`（若改在此处下传 effect）。
- **先确认**：`cd web && grep -rn "event.effect" app components lib --include=*.tsx --include=*.ts | grep -viE "useEffect|effectiveEnded|schema|actions.ts|view.ts|edit/page.tsx"` → 应**为空**，即证明 effect 存而不渲染。
- **开放问题**：每种特效是全屏覆盖还是仅 hero；`glow` 是否复用 / 扩展现有 accent 渐变而非新动画；封面图存在时主题色是否仍 tint hero。

### 3. 🟠 [HIGH] 日期格式「yyyy/mm/日」混杂 → 清理为统一格式

- **根因**：zh-CN Intl 格式产物。长「When」/评论格式化器吐中文「月/日/周」部件，而带年份的 `en-CA` day-key 格式化器吐「yyyy/mm/dd」斜杠，二者在同一 UI 里碰撞（`format.ts:15-46` 的 `WHEN_FMT`/`DAY_FMT`/`END_TIME_FMT` 用 `zh-CN`，`DAY_KEY_FMT` 用 `en-CA`）。
- **修复方向**：与第 4 项一起做（时区重做时统一一套 Intl option set，去掉混杂）。落到**一套**显示格式（如 `Sat, Jun 20, 7:00 PM EDT` 或 viewer 的 next-intl locale + tz 标签），并把 `DAY_KEY` 同区计算同日折叠。
- **爆炸半径**：与第 4 项重叠（`web/lib/events/format.ts`、`comments.ts`），见下。
- **开放问题**：统一格式用英文、viewer locale、还是显式双语行 —— 与第 4 项合并决策。

### 4. 🟠 [HIGH] 时区重做为 Option-3 观看者本地（含主办输入转换 + 水合处理 + 日历/ics + 测试重写）

- **根因**：错误的「受众=中国大陆」假设把单一固定区（`timezone.ts:11-39` `EVENT_TIME_ZONE='Asia/Shanghai'`、`EVENT_UTC_OFFSET='+08:00'`）和 zh-CN locale 烤进了每个格式化器和主办 `datetime-local` 转换。**DB 里的 UTC 瞬时是对的**，只有展示 / 输入层错。
- **现状关键文件**：
  - `web/lib/events/timezone.ts:11-39` —— `EVENT_TIME_ZONE`/`EVENT_UTC_OFFSET`；`localInputToISO()` 给主办裸输入补**固定 +08:00**；`isoToLocalInput()` 按 Asia/Shanghai 回填。两者都要改成**浏览器本地偏移**。
  - `web/lib/events/format.ts:15-94` —— 四个 Intl 格式化器（pin 在 zh-CN + Asia/Shanghai）；`isEventEnded`（**纯瞬时比较、tz 无关、不用改**）、`formatEventWhen`/`formatEventDay`/`formatOptionWhen` 是要重做的显示面。
  - `web/lib/events/comments.ts:90-104` —— `TIME_FMT` 同样 pin；`formatCommentTime` 在 `web/components/events/comments-feed.tsx:176-177` 的 `<time>` 内渲染（水合风险）。
  - `web/lib/events/calendar.ts:120-160` —— **已正确**（emit UTC-basic `Z` 瞬时），**不要改、不要加 TZID**。
- **SSR 水合风险点**（server 不知 viewer tz）：`event-view.tsx:61`（被 client shell `event-client.tsx` SSR）、`dashboard/page.tsx:193`、`dashboard/events/[id]/page.tsx:98`、`u/[username]/page.tsx:141`（均 server 组件，`formatEventWhen` per card）。
- **主办输入 / 投票输入**：`event-form.tsx:65-67`（`isoToLocalInput` 预填）、`schema.ts:96-101`（`parseDateTime` 调 `localInputToISO`）；**另有真 bug** `web/app/dashboard/events/[id]/date-actions.ts:22-27`：`addDateOption` 的 `parseDateTime` **不调 `localInputToISO`、把裸 datetime-local 串原样返回**给 RPC（与活动 start 的处理不一致），Option-3 下也要走相同的浏览器偏移→UTC 转换。
- **修复方向（一次成型，沿用 Next 16.2.9 LocalDate pattern）**：
  - **显示**：重写 `format.ts` 去掉 hardcode zh-CN+Asia/Shanghai，定义**一套**带 `timeZoneName:'short'`、无固定 timeZone（取 runtime）的 option set；把 `format*` 改成接收 `(instant, locale?, timeZone?)` 的**纯函数**便于测试，UI label 在 **client** 生成。
  - **水合安全渲染**：新建 `web/components/events/inline-script.tsx` + `web/components/events/local-when.tsx`（照 `preventing-flash-before-hydration.md`）：`LocalWhen`（client）渲染 `<time dateTime={iso} suppressHydrationWarning>{server fallback}</time>` + InlineScript 在首帧前用 `new Intl.DateTimeFormat(undefined,opts).format(new Date(iso))` 改 textContent；处理 `date_tbd`。把上面所有显示调用点换成 `<LocalWhen .../>`。
  - **主办输入**：`localInputToISO` 改读浏览器本地（`new Date(naive).toISOString()`）、`isoToLocalInput` 用本地 getters；因依赖浏览器，转换放 **client**（`event-form.tsx` 提交前转好，再让 `schema.ts` 校验 ISO）。
  - **投票输入一致性**：修 `web/app/dashboard/events/[id]/date-actions.ts:22-27`，poll start/end 走与活动 start 相同的转换（在 `date-poll-manager.tsx` client 端转好再 `addAction`）。
  - **评论**：`web/components/events/comments-feed.tsx:176-177` 改用 `LocalWhen`/LocalTime。
  - **测试重写（独立 agent）**：`tests/task-3-timezone.test.ts` 当前断言旧北京契约（`localInputToISO('...19:30')==='...11:30Z'`、`EVENT_TIME_ZONE==='Asia/Shanghai'`、`formatEventWhen` 出「6月20日周六 19:30」），**全部重写**为 Option-3 契约（纯函数瞬时；输入测试 pin `process.env.TZ` 求确定性，如 `TZ=America/New_York`）。核对 `task-2.6-calendar`/`task-4.1-comments`/`task-4-lifecycle` 不受影响（应保持通过）。
  - 改掉 `timezone.ts`/`format.ts`/`comments.ts`/`schema.ts`/`event-form.tsx` 里仍写「北京 / Beijing / +08:00」的文件头注释。
- **爆炸半径**：`timezone.ts`、`format.ts`（`isEventEnded` 不变）、`comments.ts`、新 `inline-script.tsx`/`local-when.tsx`、`event-view.tsx:61`、`dashboard/page.tsx:193`、`dashboard/events/[id]/page.tsx:98`、`u/[username]/page.tsx:141`、`date-poll.tsx:140`、`date-poll-manager.tsx:135`+`78-96`、`web/components/events/comments-feed.tsx:176-177`、`event-form.tsx:65-67`、`schema.ts:96-101`、`web/app/dashboard/events/[id]/date-actions.ts:22-27`、`tests/task-3-timezone.test.ts`（重写）；**`calendar.ts`/`add-to-calendar.tsx` 不变**。
- **先确认**：`cd web && grep -rn "Asia/Shanghai\|EVENT_TIME_ZONE\|+08:00\|zh-CN" lib app components | grep -v node_modules`（枚举所有 hardcode-北京点）；并用 `TZ=America/New_York npx vitest run tests/task-3-timezone.test.ts` 看旧契约基线。
- **开放问题**：统一 label 用英文 / viewer locale / 双语；是否**现在**加 `events.time_zone` 列（让主办也能看活动地本地时区）还是纯 viewer-local 上线；新 tz-label 字符串别触发护栏禁词；`date-actions.ts` 既有裸串行为若被已有 poll 数据 / 测试依赖，确认迁移故事。

### 5. 🟠 [HIGH] 还原中国城市占位 → 美国城市 / 地址（完整清单）

- **根因**：早前 i18n 批次把中国城市 / 地址 / 币种占位写进了 **`web/messages/zh.json`（仅此文件；`en.json` 已是美国正确）**。
- **要改（仅 `zh.json`）**：`cityPlaceholder`（**第 111 行**）`"上海·徐汇"` → 美国城市（参 en 的 `Brooklyn, NY`，如「纽约·布鲁克林」）；`addressPlaceholder`（**第 114 行**）`"天台路 123 号 5 室"` → 美式地址（如「123 Rooftop Ave, Apt 5」或中字美式格式）；`chipInNotePlaceholder`（**第 127 行**）`"每人 10 元，包酒水和零食"` → **USD**（如「每人 10 美元，包酒水和零食」）。
- **不要动**：`namePlaceholder`（小雨 / 陈小明，人名、文化中性）；`en.json`（已美国化，对应键在 111/114/127 行已是 `Brooklyn, NY` / `123 Rooftop Ave, Apt 5` / `$10 covers…`）；`seed.sql`（已是 Brooklyn, NY，无中国占位）；**Venmo（北美正确，不要 flag；注意它不在 messages 文件里，只在 `event-form.tsx`/`lib/events/schema.ts` 源码 — 本项爆炸半径之外）**。
- **爆炸半径**：仅 `web/messages/zh.json`（111/114/127 行）。
- **先确认**：`grep -nE "上海|徐汇|天台路|10 元|10元|￥|人民币" web/messages/zh.json`（预期命中 111/114/127）。
- **开放问题**：具体选哪个美国城市（布鲁克林 / 湾区 / 洛杉矶）以匹配北美华人聚集地；zh 地址占位是保留中字 + 美式还是直接复用英文。

### 6. 🟡 [MEDIUM] 把「外观 / appearance」段移到创建表单末尾 + 让「添加封面」在创建模式可用（H12）

- **根因**：封面在创建模式被**设计性地**禁用：封面客户端直传公共 `event-covers` bucket，唯一安全边界是 storage RLS（迁移 0013）要求对象路径首段 = 主办拥有的 event id —— 而该 id 要等 events 行插入后才有，故 `CoverUploader` 在创建时收到 `eventId=null` 并隐藏整个上传块（`cover-uploader.tsx:84` `{eventId && (...)}`；`event-form.tsx:140` 传 `eventId={mode === "edit" ? d.id : null}`）。但 `createEvent` 已在插入后重定向到编辑页（`actions.ts:95` `/dashboard/events/${created.id}/edit?created=1`），**save-first 流已就绪**，缺的只是：①外观段不在最后；②空态文案 `saveFirstThenCover` 没指向那个已存在的重定向。
- **修复方向**：①在 `event-form.tsx` 把整个「外观」`<section>`（**137-179 行**）移到提交栏（421 行）之前的最后；②在 `cover-uploader.tsx` 把被动的 `saveFirstThenCover` 空态换成可操作提示（「保存一次即可解锁封面上传」，靠 `?created=1` 重定向后 uploader 立即可用），en/zh 两个 messages 的 `addCover`/`saveFirstThenCover` 同步改文案。（**不建议**现在做真正的「创建中暂存 File 再插入后上传」——要穿过 useActionState/Server Action 序列化 + 插入后客户端上传，复杂度大。）
- **爆炸半径**：`web/app/dashboard/events/event-form.tsx`（移段）、`web/components/events/cover-uploader.tsx`（创建态可操作空态）、`web/messages/{en,zh}.json`（addCover/saveFirstThenCover 文案）。
- **先确认**：`grep -n "eventId &&" web/components/events/cover-uploader.tsx`（确认 84 行闸门）；`grep -n 'mode === "edit" ? d.id : null' web/app/dashboard/events/event-form.tsx`（确认 140 行）。

### 7. ⚪ [FUTURE] 封面预设（可扩展）+ 局卡（生成的可分享卡片）+ Google Maps 横向嵌入（替换地图链接）

- **封面预设**：在 `web/lib/events/theme.ts`（或同级 `cover-presets.ts`）加 `COVER_PRESETS` 数组（形如 `THEME_SWATCHES`：`{key,label,url|gradient}`）+ fail-closed 的 `parseCoverPreset` 守卫（仿 `parseThemeColor`），在（移到末尾后的）外观段渲染预设网格，点击即设现有隐藏 `cover_image_url` 输入。这是与 `THEME_SWATCHES`/`EFFECT_PRESETS` 同样干净的「加一个数组即扩展」点。
- **局卡（生成的可分享卡片）**：服务端生成、写入迁移 0013 已建的 `event-covers`（或 `event-photos`）bucket，在 `event-view.tsx:211-216` 的 hero 呈现。
- **Google Maps 横向嵌入**：把 `event-view.tsx:135-144` 的 `openMap` `<a>` 链接换成 embed `<iframe>`，保持「解锁才显示」闸门（`mapUrl` 在 `event.unlocked` 前为 null，:71）。
- **爆炸半径**：`theme.ts`（+ COVER_PRESETS/parseCoverPreset）、`event-form.tsx`（预设网格 UI）、可能 `schema.ts:173-179`（若预设提交 key 而非 URL 需加校验）、`event-view.tsx`（hero 局卡 + Where 地图 embed）。
- **开放问题**：预设是托管图片资源（需 bucket / `/public` URL）还是 CSS 渐变 / 内建（需 key 存进 theme jsonb + 渲染逻辑）——决定 `schema.ts` 是否要预设 key 校验。

---

## 8. 还剩什么（上线后迭代，中 / 低优先；源头 AUDIT.md，仍 pending）

- **服务端报错文案 i18n（M3–M6）**：zod 校验信息、server action 返回 message、API route message、Supabase 原始错误、lib 里的「Date TBD」——目前这些仍是英文。
- **无障碍扫除（M7–M12）**：radio 键盘契约、直播区 aria-live、错误关联 + 焦点管理、对比度 token、封面改 `<img>`+alt、触控目标。
- **B6 遗留**：无 token 的「账号解锁」访客只通过 SSR 拿到解锁门面，**不含实时轮询的客人名单**（`get_guest_list` 是 token-scoped）——要扩展得改 `get_guest_list`。
- 其余中 / 低打磨见 `AUDIT.md`。

---

## 9. 上线路径（建议顺序）

1. **修 Round-2 BLOCKER（§6 第 1 项）**：跑诊断 → 改 Vercel preview 的 `SUPABASE_SERVICE_ROLE_KEY`（legacy JWT、Preview 作用域）→ 重部署 → 确认两个 `/{slug}` 链接都渲染。
2. 修 Auth 配置：Supabase **Site URL + Redirect URLs** 指向 preview（含 `/auth/callback` 和 `/**`）；Vercel 设 `NEXT_PUBLIC_SITE_URL`。
3. 做 Round-2 HIGH（特效 / 主题色、日期格式、时区 Option-3、美国占位）—— 走「实现 agent + 独立测试 agent + 全量门禁」。
4. 验收 preview（中文化 / 改名 / 时区 / 取消 / 人数 / 登录重发 / 特效 / 封面 全点一遍），或本地 worktree 预览。
5. 满意后 `prelaunch-fixes` → `master`（PR 或本地 merge），Vercel production 自动部署；确认 `supabase db push` 把云端 schema 推到 0019（之后是 Round-2 的 0020）。
6. 公开上线前：**轮换 service_role / JWT secret**（§2，且轮换后把新 legacy key 回填 Vercel）；Auth URL 加正式域名。
7. 上线后按 §8 优先级做迭代项（仍用独立测试 agent 模式）。

---

## 10. Round-3 待办（2026-06-18 新增；用户在生产验收后提出，决策已定）

> Round-2 已全部完成并合并 master（HEAD `37ae246`，迁移仍 0019，下一个 **0020**）。以下 6 项在本轮逐项修（实现 agent + 独立测试 agent + 全量门禁）。**关键插曲**：用户在 IDE 内置浏览器看生产 dashboard 卡在骨架屏 —— 那是 IDE 的 iframe sandbox 禁脚本（Next 流式 Suspense 的换页脚本被拦），**非应用 bug**，真浏览器正常；我们代码无任何 CSP/sandbox 头。

**已定决策**：
- **时区**：保留 §7.4「观看者本地时间」，但标签改**友好命名时区（不要裸 GMT）**——美国区显示 美东/美西/美中/美山（或 ET/PT 类），非美国友好回退。（用户原话「用户在哪里就显示哪里的时间」+「不要 GMT」；他先前看到的 GMT 部分是 IDE-sandbox 回退态 UTC。）
- **发现页**：做**全站公开发现页**——任何人（未登录）可浏览所有**已发布的 public 活动**；页面带「新建活动」按钮,但点进创建流程才**强制登录**。（注意隐私含义：public 活动从前只「凭链接可见」,现在变成全站可发现——可能日后需要 unlisted 第三档可见性，先记着。）

| # | 项 | 根因 / 现状（file:line） | 修复方向 |
|---|---|---|---|
| 1 | **magic-link 登录跳转** | 点登录→邮件链接在**新标签**打开→`app/auth/callback/route.ts` 换 code 后 redirect 到 dashboard；**原标签**（`app/login` 的「查收邮件」态）不动。 | 原标签监听 auth（`onAuthStateChange`/storage 事件,同浏览器跨标签可感知）→ 出现 session 即跳 dashboard；callback 页改成「已登录,可关掉/返回原页」确认页（而非直接进 dashboard）。跨设备无共享存储则退化为原行为。 |
| 2 | **验证码（OTP）第二方式** | 现只有 magic-link（`signInWithOtp`，`app/login`）。 | 加邮箱 OTP：UI 输 6 位码 → `supabase.auth.verifyOtp({type:'email',email,token})`；magic-link 邮件模板里带 `{{ .Token }}`。作为保险路径。 |
| 3 | **magic-link 邮件太丑** | Supabase Auth 默认模板（「Your sign-in link」纯文本）。 | 自定义 HTML 模板：`supabase/config.toml` 的 `[auth.email.template.magic_link]` + 模板文件（本地生效）；**云端要手动**粘进 Supabase 后台 Auth→Email Templates。品牌化（JU、暗色、coral）。 |
| 4 | **用户名输入框 bug** | `app/dashboard/settings/profile-form.tsx:115-133`：容器 `focus-within:border-iris` + input 又吃到全局 `:focus-visible` outline（globals.css:79，不同圆角/offset）→ **双重错位焦点环**。 | input 加 `focus-visible:outline-none`（或统一聚焦指示到容器），消除双环；核对 `/u/` 前缀对齐。 |
| 5 | **时区友好命名** | `lib/events/when-format.ts:34/42/52` 三处 `timeZoneName:"short"` → 美国出 EDT/PST、其它出 GMT+N。 | 改成友好命名（`shortGeneric`/`longGeneric` 或小 US→美东/美西/美中/美山 映射）；保留观看者本地 + 水合机制不变。 |
| 6 | **公开发现页（大）** | 无全站发现入口；`app/page.tsx` 登录用户 redirect→dashboard、未登录只给 CTA。`/u/[username]` 已公开但只单主办。 | 新 `get_public_events` SECURITY DEFINER RPC（**迁移 0020**，只返 public+published 的一级字段:标题/主办/时间/城市/封面，**绝不含地址/名单**）+ 发现页 UI（任何人可看）+「新建活动」按钮 login-gated。 |

**完成后**：写正式 Round-3 交接文档（本节即雏形），用户新开对话继续。

---

## 11. Round-3 完成（2026-06-18）+ 交接

**Round-3 六项全部完成，合并入 master。** 每项走「实现 agent + 独立测试 agent + 全量门禁」。最终 **vitest 650/650、50 文件全绿**，check-boundaries **8/8**（含 DB 权威 RLS，迁移已到 **0020**，下一个 **0021**）。

| # | 项 | 提交 | 决策 / 要点 |
|---|---|---|---|
| 4 | 用户名输入框双焦点环 | `a109269` | input 加 `focus-visible:outline-none`，容器 `focus-within:border-iris` 为唯一焦点指示 |
| 5 | 时区友好命名标签 | `a109269` | 保留 §7.4 观看者本地；`when-format.ts` 三处 `timeZoneName:"short"`→`"shortGeneric"`：美国出 `ET/PT/CT/MT`（zh：`纽约时间/洛杉矶时间`），**不再裸 GMT**。SSR 回退态读 `GMT`（UTC 正名），内联脚本上线前改成本地名 |
| 1 | magic-link 原页跳转 | `893677f` | 原标签**轮询** `getSession`（cookie 版 SSR 客户端跨标签靠共享 cookie，非 onAuthStateChange）→ 跳 dashboard；链接打开的标签落 `/auth/signed-in` 确认页；email 链接打 `flow=email` 标记，OAuth 不打（仍直进） |
| 2 | OTP 验证码第二方式 | `893677f` | 「查收邮件」态加 6 位码输入 → `verifyOtp({type:"email"})` → 原标签内登录 |
| 3 | magic-link 邮件美化 | `893677f` | `supabase/templates/magic_link.html`（JU 品牌、暗色、coral、含 `{{ .ConfirmationURL }}`+`{{ .Token }}`）+ config.toml。**云端需手动粘贴** |
| 6 | 公开发现页 | `c1eb3fc` | `/discover`（任何人可看所有 public+published）+ `get_public_events()` RPC（迁移 **0020**，一级字段+host 名，绝不泄地址/名单）；「新建活动」按钮 login-gated（未登录→`/login?next=/dashboard/events/new`）。抽出共享 `<PublicEventCard>`，`/u/` 复用 |

### 🔴 上线/生产生效前必做的手动步骤（我做不了）

1. **`supabase db push`**——把**迁移 0020** 应用到云端。**否则生产 `/discover` 会报错**（`get_public_events` 不存在；与 §6 的「云端 schema 落后」同类）。这是合并 master、production 重部署后**必须立刻做**的。
2. **粘贴邮件模板**：Supabase Dashboard → Authentication → Email Templates → **Magic Link**，贴入 `supabase/templates/magic_link.html` 的 HTML，主题 `你的 JU 登录链接 / Your JU sign-in link`。**这样 OTP 验证码（#2）才有 `{{ .Token }}` 可用、邮件才是品牌化的。**
3. （已记于 §2/§9）Supabase Auth **Site URL + Redirect URLs** 指向正式/preview 域名（含 `/auth/callback` 和 `/**`）；Vercel 设 `NEXT_PUBLIC_SITE_URL`。
4. （上线前）轮换 service_role/JWT secret（§2），轮换后把新 legacy key 回填 Vercel。

### 浏览器验收清单（Round-3）

- **时区**（真浏览器，非 IDE 内置）：活动时间显示成**你本地时区 + 友好名**（如 `7:30 PM ET` / `纽约时间`），无裸 GMT，刷新不闪。
- **登录**：发链接 → 原标签自动跳 dashboard；邮件链接打开的标签显示「你已登录」；或在原标签输入邮件里的 6 位码也能登录。
- **`/discover`**：未登录可浏览所有公开活动；点「新建活动」→ 未登录跳登录、已登录直接进创建。
- **用户名输入框**：单一焦点环（不再双环错位）。

### ⚠️ 注记 / 取舍

- **IDE sandbox 卡骨架屏**：在 IDE 内置浏览器看生产页会卡 loading.tsx（iframe 禁脚本拦了 Next 流式换页脚本）——**非 bug**，真浏览器正常；我们无任何 CSP/sandbox 头。
- **隐私**：`visibility=public` 活动**现在全站可发现**（从前仅「凭链接」）。若日后要「可凭链接、但不全站列出」，加第三档 `unlisted` 可见性 + RPC 过滤。
- **跨设备 magic-link**：原页自动跳转只在**同浏览器**生效（共享 cookie）；跨设备退化为原行为（链接标签登录、原页不动）。
- **时区友好名是城市名**（`纽约时间/洛杉矶时间`）而非区域名（美东/美西）——更贴合「显示用户所在地」；若想要区域名，加一张 US-zone→中文名小映射即可。

### 还剩（上线后迭代，源头 AUDIT.md / §7.7 / §8）

- §7.7 FUTURE：封面预设、生成式局卡、Google Maps 横向嵌入。
- AUDIT 中/低：服务端报错文案 i18n（M3–M6）、无障碍扫除（M7–M12）、B6 账号解锁不含实时名单。
- 可选硬化：发现页加分页/搜索；`unlisted` 第三档可见性。
