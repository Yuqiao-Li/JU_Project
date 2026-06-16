# TASKS.md — Partiful Clone 执行清单(v2 定稿)

> 自上而下逐个完成。每任务**完整做完**(实现 → 过护栏 → commit → 打勾)再下一个。
>
> **agent 分流(由 run-agent.sh 自动识别)**:
> - 标 **[SECURITY]** 的任务 → 跑**两轮独立 agent**:① 实现 agent(写功能,禁改测试)② 独立测试 agent(全新上下文,对抗性写/审测试,目标是找漏洞)。两轮都过才算完成。
> - 普通 🟢 任务 → **同 agent TDD**:先写会失败的测试(红)→ 实现至通过(绿)→ commit。
>
> **护栏(每任务 commit 前)**:① 静态门禁 `check-boundaries.sh` ② 对应断言测试。任一不过 → 写 BLOCKERS + 不打勾 + 该轮停。**全程无人工暂停。**
>
> 标记:`[ ]`待办 `[x]`完成 · 每任务含 **【档位】【禁止】【验收】【测试】**
> 配套:CLAUDE.md(宪法)· SCHEMA.md(数据模型+安全逐字段边界)· DESIGN-TONE.md(前端基调)· TEST-SPEC.md(安全测试断言)。**动手前必读对应文档。**

---

## Phase 0 — 骨架 + 测试框架 + 护栏

- [ ] **0.1 Scaffold Next.js** 【🟢】
  - pnpm create next-app:App Router + TS(strict)+ Tailwind + ESLint。
  - 【禁止】不引入重型 UI 库(Tailwind + 少量 headless 原语)。
  - 【验收】dev 启动;build 通过。 【测试】N/A

- [ ] **0.2 依赖 + Supabase 客户端** 【🟢】
  - 装 supabase-js、@supabase/ssr、zod、@upstash/ratelimit、@upstash/redis。
  - 建 lib/supabase/{client,server,service}.ts(service=受信角色,**仅服务端,绝不进客户端 bundle**)。建 .env.local.example。
  - 【禁止】service-role key 不得出现在任何 NEXT_PUBLIC_* 或客户端可达代码(护栏 grep)。
  - 【验收】三客户端可导入;typecheck 过。 【测试】N/A

- [ ] **0.3 测试框架**(护栏前提)【🟢】
  - 装 Vitest,配置可对测试 DB 跑集成测试(连接串来自 env)。建 web/tests/ 结构 + smoke 测试。
  - 【验收】pnpm test 跑通 smoke。 【测试】smoke 自身

- [ ] **0.4 护栏脚本 check-boundaries.sh** 【🟢】
  - 实现静态门禁:① find 路径黑名单(各 🟡 阶段不该出现的前端文件)② grep 必需(slug 用 gen_random_bytes)③ grep 禁用(slug 禁 random();无 localStorage;service key 不进客户端;不提交 .env)④ 每 create table 配套 enable row level security ⑤ tsc+lint+build。接进 run-agent.sh:每任务 commit 前自动跑。
  - 【验收】脚本可执行;对当前仓库跑通。 【测试】N/A

- [ ] **0.5 Supabase 目录骨架** 【🟢】
  - 建 supabase/migrations/、空 seed.sql、scripts/db-apply.md(migration 应用 + gen types 命令)。
  - 【验收】结构符合 CLAUDE.md。 【测试】N/A

---

## Phase 1 — 数据模型 + 安全(后端,一次建全,不可打桩)

- [ ] **1.1 核心表 migration**(0001)【🟢】
  - 建 profiles(含 username)、events(SCHEMA.md 全部列,含 🟡 留白列)、event_hosts、guests、rsvps。索引 + updated_at 触发器。
  - 【禁止】events 留白列必须全建(护栏 grep 列名)。
  - 【验收】SQL 有效;表/约束/索引齐全。 【测试】集成:可插入 host+event+guest+rsvp。

- [ ] **1.2 扩展表 migration**(0002)【🟡 建表】
  - 建 comments、comment_reactions、event_photos、date_options、date_votes、questions(type 含 social)、answers、scheduled_reminders、broadcasts。FK + 约束(comments guest_id/host_id 恰一非空)。
  - 【禁止】**只建表,不得创建任何对应前端**(护栏 find 黑名单)。
  - 【验收】SQL 有效;FK/约束正确。 【测试】集成:每表插合法行/违约束被拒。

- [ ] **1.3 [SECURITY] 启用 RLS + host 策略**(0003)【🟢】
  - 所有表 enable RLS。profiles 仅本人;events 经 event_hosts owner 全权;子表活动 host 可读全部、可删 guests/comments。
  - 【禁止】无表漏开 RLS(护栏查)。
  - 【验收】每表有策略且 RLS 启用。 【测试】host A 不能读 host B 活动的 guests。

- [ ] **1.4 [SECURITY] 公开读策略 + 私密收敛**(0004)【🟢 不可打桩】
  - anon 仅 SELECT published+public 的 events。**private 不对 anon 开放**(经 Next 受信角色访问)。anon 永不可读 contact。
  - 【禁止】anon 不得直 SELECT 到 private 行;不得读到 contact。
  - 【验收】anon 直查 private 返回空;contact 不可达。
  - 【测试】见 TEST-SPEC §1.4:anon 查 private 断言空;查 guests 断言无 contact。

- [ ] **1.5a guest 侧 RPC 实现**(0005,SECURITY DEFINER)【🟢 不可打桩】
  - 实现 SCHEMA.md 7 个 RPC。get_event_by_slug **严格按三类字段边界返回**(未RSVP不含地址/名单)、私密由受信角色调用、预留密码位;submit_rsvp **token→contact→新建三段去重** + 容量满落 waitlisted;get_guest_list 仅未隐藏时、只露 Going/Maybe、无 contact、需已RSVP;add_comment 写门禁需已RSVP;vote_dates;finalize_date(host-only);promote_guest(host-only)。
  - 【禁止】get_event_by_slug **不得无条件返回全部字段**;slug 禁 random()。
  - 【验收】容量/waitlist 在 SQL 内强制;token 编辑可用;私密凭 slug 可读;contact 不泄露。
  - 【测试】N/A(测试在 1.5b,由独立测试 agent 写)

- [ ] **1.5b [SECURITY] guest RPC 安全测试套件** 【🟢】
  - **独立测试 agent**:对 1.5a 的 RPC 写对抗性测试,严格按 TEST-SPEC §1.5。
  - 【测试】TEST-SPEC §1.5 全部:① 无token调用无地址/有token有地址 ② 灌满容量落waitlisted ③ 同token更新非新建/同contact更新 ④ get_guest_list 无contact、无Can't Go ⑤ 未RSVP调add_comment被拒。**全过才算完成。**

- [ ] **1.6 slug 生成函数 + 单元测试** 【🟢】
  - slugify(title前40)-{10位base62},gen_random_bytes,中文/空标题省可读段,unique 冲突重试一次。
  - 【禁止】禁 random()/时间戳/自增派生(护栏 grep)。
  - 【验收】符合规格;碰撞重试有效。
  - 【测试】单元:① 随机段长=10 ② 纯中文标题输出纯随机段 ③ 同标题多次不重复 ④ 不含禁用字符。

- [ ] **1.7 seed + 类型生成** 【🟢】
  - seed:1 host、2 活动(公开published带容量/私密published)、若干 guests/rsvps、几条 comments、1 日期投票带选项。生成 TS 类型到 types/database.ts。
  - 【验收】seed 无错;类型文件存在且被引用。 【测试】N/A

---

## Phase 2 — 前端核心闭环 + 安全基础设施

> **动手前必读 DESIGN-TONE.md + frontend-design SKILL.md**。功能尽量复刻 Partiful;视觉按基调自定。**承载安全/数据语义的行为必须正确,审美自由但语义不可错。**

- [ ] **2.1 host 认证** 【🟢】
  - magic link(必做)+ Google。首登 upsert profiles。/dashboard 守卫。设计留微信口子(不实现)。
  - 【禁止】不实现微信;guest 无任何登录入口。
  - 【验收】host 登录/登出;profile 自动建;dashboard 守卫。 【测试】集成:首登后 profiles 存在。

- [ ] **2.2a 建/改活动表单 — 核心字段** 【🟢】
  - /dashboard/events/new 与 [id]/edit。字段:标题、描述、日期(+TBD开关)、地点(text+url+city)、可见性、容量、+1开关+上限、**RSVP开关**。create 生成 slug。草稿→发布。zod 校验。
  - 【禁止】问卷/co-host/审核等 🟡 不做 UI(护栏查)。
  - 【验收】host 建活动→发布→得 /{slug} 链接。 【测试】集成:创建生成合法唯一 slug。

- [ ] **2.2b 建/改活动 — 封面 + 主题 + chip_in** 【🟢】
  - 封面上传 Storage;主题色 + 适度特效(按 DESIGN-TONE);chip_in 链接 + 说明。
  - 【禁止】特效不堆砌;chip_in 纯展示不碰钱。
  - 【验收】可传封面、选主题、填 chip_in。 【测试】N/A

- [ ] **2.3 host dashboard** 【🟢】
  - /dashboard 列活动(将来/过往)。/dashboard/events/[id]:公开链接+复制、实时人数、**完整名单(host 见全部含 contact)**、waitlist 单列。
  - 【验收】host 见活动+人数+复制可用。 【测试】集成:dashboard 只返回该 host 活动。

- [ ] **2.3.5 [SECURITY] 限流 + 私密收敛基础设施**(先于核心页)【🟢 MVP 必做】
  - Next 层(middleware/SSR)+ Upstash Redis 滑动窗口,对 slug 读取限流,真实 IP 来自 Vercel 注入。私密活动读取收敛为只走 Next SSR(经受信角色),anon 不可直打 private RPC。
  - 【禁止】限流不得放 Postgres;不得因取不到 IP 形同虚设;private 不得对 anon 裸奔。
  - 【验收】同 IP 超阈值被限;anon 直连 private RPC 被拒。
  - 【测试】见 TEST-SPEC §2.3.5:① 超阈值请求被限(429)② anon 直连 private RPC 被拒。

- [ ] **2.4 [SECURITY] 公开活动页 + RSVP(核心)** 【🟢 语义不可降】
  - /{slug}:**SSR 经受信角色调 get_event_by_slug**。**严格分级呈现**:未RSVP只见标题/封面/描述/城市/日期/人数/剩余位;RSVP后解锁完整地址+名单。RSVP 组件(name+状态+可选+1+可选contact)调 submit_rsvp。token 存 localStorage,复访预填+可改。容量满显示"已在等待名单"。私密只走 SSR。
  - 【禁止】未RSVP页面**绝不渲染完整地址/名单**;token **绝不进 URL**;无 localStorage 外违规浏览器存储。
  - 【验收】登出用户开链接→RSVP→确认→复访可改;容量满落 waitlist;私密经 SSR 正常、anon 直打被拒。
  - 【测试】见 TEST-SPEC §2.4:① 未RSVP响应体不含地址 ② RSVP后含地址 ③ 容量满落waitlist ④ 私密 anon 直连被拒。

- [ ] **2.6 加入日历** 【🟢】
  - "加入日历"按钮:Google Calendar template URL + .ics 下载。**不依赖 contact,人人可用。**
  - 【验收】可加 Google 日历/下载 .ics,含标题/时间/地点。
  - 【测试】单元:.ics 含正确 DTSTART/SUMMARY/LOCATION。

---

## Phase 3 — 名单展示 + 容量/waitlist UI

- [ ] **3.1 [SECURITY] 公开页名单** 【🟢】
  - /{slug} 经 get_guest_list 渲染(遵守 hide_guest_list/hide_guest_count)。按 Going/Maybe 分组,显 +1 数。Realtime 实时。**只对已RSVP可见。**
  - 【禁止】不展示 Can't Go;不展示 contact;对未RSVP不可见。
  - 【验收】已RSVP访客见名单(未隐藏时),实时更新。
  - 【测试】见 TEST-SPEC §3.1:名单不含 Can't Go、不含 contact、未RSVP不可见。

- [ ] **3.2 容量 + waitlist UX** 【🟢】
  - 显"还剩 X 位"/"已满—等待名单"。waitlist 访客明确标注。host dashboard 单列 waitlist + 手动 promote(promote_guest)。
  - 【验收】容量正确反映;host 可提升。 【测试】集成:promote_guest 改 going 且尊重容量。

---

## Phase 4 — Activity Feed

- [ ] **4.1 [SECURITY] 评论 UI**(RPC 已在 1.5a)【🟢】
  - /{slug} 评论流(时间正序)。**读开放**:未RSVP可读。**写门禁**:仅已RSVP(有token)和 host 可发,未RSVP点发提示"先RSVP才能评"。可选 GIF(URL,不接 Giphy)。Realtime。
  - 【禁止】未RSVP不得能发;不接外部 GIF API。
  - 【验收】guest/host 可发并实时;未RSVP可读但被引导。
  - 【测试】见 TEST-SPEC §4.1:未RSVP发评论被拒;有token可发。

---

## Phase 5 — 日期投票

- [ ] **5.1 日期投票 UI**(RPC 已在 1.5a)【🟢】
  - 公开页:有候选且无最终日期时显示投票,多选(复用 token),实时计票。host 改活动页:增删候选 + 每候选"敲定"(finalize_date 写回 starts_at,**保留投票记录**)。
  - 【禁止】敲定后不得删投票记录。
  - 【验收】投票闭环+实时计票+敲定生效。
  - 【测试】集成:vote_dates 多选 upsert;finalize_date 设 starts_at 且 votes 仍存。

---

## Phase 6 — 个人页 + 收尾

- [ ] **6.1 Organizer Profile** 【🟢】
  - /u/[username] 聚合该 host 公开活动。username 唯一 + 设置入口 + 唯一校验。
  - 【禁止】不暴露私密活动。
  - 【验收】/u/[username] 见该 host 的 public 活动。 【测试】集成:个人页查询不含 private。

- [ ] **6.3 [SECURITY] OG meta + 分享预览** 【🟢】
  - 活动页 OG(标题+封面)。**私密活动 OG 只暴露第一类字段(标题/封面/描述),不含地址。**
  - 【禁止】OG 不得泄露完整地址/名单。
  - 【验收】分享预览显示标题+封面。 【测试】单元:OG 不含 location_text。

- [ ] **6.4 空/加载/错误态 + 移动端** 【🟢】
  - 全页面空/加载/错误态齐全;移动端可用。
  - 【验收】关键页窄屏可用、各态有处理。 【测试】N/A

- [ ] **6.5 README + 最终安全过一遍** 【🟢】
  - README:setup/env/migration/部署(Vercel+Supabase+Upstash)。对照 CLAUDE.md 安全清单逐条核。
  - 【验收】README 完整;安全清单全过或记 BLOCKERS。 【测试】跑全量套件全绿。
