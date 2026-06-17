# TASKS.md — Partiful Clone 执行清单(v3 定稿)

> 自上而下逐个完成。每任务**完整做完**(实现 → 过护栏 → commit)再下一个。
>
> **打勾权在编排器,不在 agent(D11/G2)**:agent 只**实现 + 过护栏 + commit**,**绝不自己把 `[ ]` 改成 `[x]`、不声称完成**。
> **由 run-agent.sh 在轮末跑护栏 + 测试,通过才打勾**;失败则回退本轮 commit、记 BLOCKERS;同一任务连续失败 N 次标 `[~]` 跳过。
>
> **agent 分流(run-agent.sh 自动识别)**:
> - 标 **[SECURITY]** → 两轮独立 agent:① 实现 agent(写功能,禁改测试)② 独立测试 agent(全新上下文,对抗性写测试)。测试轮**只准动 `tests/`,碰实现文件即判失败回退**(diff 闸)。两轮都过编排器才打勾。
> - 普通 🟢 → 同 agent TDD(先写会失败的测试 → 实现至通过)。
>
> **护栏(每任务 commit 前)**:静态门禁 `check-boundaries.sh` + 对应断言测试。任一不过 → 写 BLOCKERS + 编排器不打勾。**全程无人工暂停。**
>
> 标记:`[ ]`待办 `[x]`完成(编排器置)`[~]`阻塞/跳过 · 每任务含 **【档位】【禁止】【验收】【测试】**
> 配套:CLAUDE.md(宪法)· SCHEMA.md(数据模型+安全逐字段边界)· DESIGN-TONE.md(前端基调)· TEST-SPEC.md(安全测试断言)。**动手前必读对应文档。**

---

## Phase 0 — 骨架 + 测试框架 + 护栏 + 测试 DB

- [x] **0.1 Scaffold Next.js** 【🟢】
  - pnpm create next-app:App Router + TS(strict)+ Tailwind + ESLint。**加 `typecheck` 脚本(tsc --noEmit)**。
  - 【禁止】不引入重型 UI 库。 【验收】dev 启动;build 通过;`pnpm typecheck` 可跑。 【测试】N/A

- [x] **0.2 依赖 + Supabase 客户端** 【🟢】
  - 装 supabase-js、@supabase/ssr、zod、@upstash/ratelimit、@upstash/redis。建 lib/supabase/{client,server,service}.ts(service=受信角色,**仅服务端**)。建 .env.local.example。
  - 【禁止】service-role key 不得进任何 NEXT_PUBLIC_* 或客户端可达代码。 【验收】三客户端可导入;typecheck 过。 【测试】N/A

- [x] **0.3 测试框架 + 全局 setup** 【🟢】
  - 装 Vitest。**全局 setup**:对测试 DB 跑 `supabase db reset`(apply 全部迁移 + seed)→ 用 **auth admin API(service role)建 ≥2 个已确认 host 用户 + mint 会话**,导出给测试。anon 路径用 anon key;host 路径用会话;受信用 service。
  - 【验收】`pnpm test` 跑通 smoke + 全局 setup 能起 DB/建会话。 【测试】smoke 自身

- [x] **0.4 护栏脚本 check-boundaries.sh** 【🟢】
  - 实现见 TEST-SPEC/SCHEMA 的护栏要求:① 留白前端黑名单(路径段+内容)② slug 密码学随机(函数体内)③ 禁用模式(sessionStorage/service key 进客户端/不提交密钥,git 未 init 判失败)④ **DB 权威 RLS 校验**(apply 到 scratch DB 查 pg_class/pg_policies:每表 RLS 启用+有非全放行策略;**仅 anon 对客数据表无任何读写策略;host(authenticated)经所有权策略读自己活动数据**;storage schema)⑤ **helper grep**(get_event_by_slug/get_guest_list/add_comment 函数体须含 `guest_unlock_status(`)⑥ 测试存在性+关键断言关键字 ⑦ tsc+lint+build(仅 web 触及时)。区分 SKIPPED/PASSED;关键任务"产出物必须存在"。
  - 【验收】脚本可执行;`bash -n` 过;对当前(空)仓库跑输出 SKIPPED 而非误判失败。 【测试】N/A

- [x] **0.5 Supabase 目录骨架 + db 脚本** 【🟢】
  - 建 supabase/migrations/、空 seed.sql、`package.json` 脚本 `db:reset`/`db:apply`(真正 apply,不只文档)。
  - 【验收】结构符合 CLAUDE.md;`db:reset` 可对本地 supabase 跑。 【测试】N/A

- [x] **0.6 provision + bootstrap 测试 DB** 【🟢】
  - **本地 `supabase start`**(Docker + supabase CLI);确保 anon/authenticated/service_role + auth admin + PostgREST 可用。脚本化:迁移 apply + ≥2 host 用户/会话 + seed,接进 0.3 全局 setup。
  - 【禁止】不依赖远端云库做并发测试。 【验收】`supabase start` 起库;全局 setup 能 reset+建会话。 【测试】N/A

---

## Phase 1 — 数据模型 + 安全(后端,一次建对,不可打桩)

- [x] **1.1a 核心表 A migration**(0001a:profiles + events)【🟢】
  - 建 profiles(含 username 唯一索引)、events(**SCHEMA §2 全部列**,含 🟡 留白列与 `view_password_hash`)。**任务体贴 SCHEMA §2 列清单做确定性验收**。
  - 【禁止】events 留白列必须全建(护栏 grep 列名)。 【验收】SQL 有效;列/约束齐。 【测试】集成:可插入 host+event。

- [x] **1.1b 核心表 B migration**(0001b:event_hosts + guests + rsvps + 触发器)【🟢】
  - 建 event_hosts、guests(**含 `user_id`**)、rsvps;索引;updated_at 触发器;**events AFTER INSERT 触发器写 event_hosts owner 行**;**auth.users AFTER INSERT 触发器建 profiles**。
  - 【验收】SQL 有效;触发器生效。 【测试】集成:建 event 自动有 owner 行 + 注册自动建 profiles。

- [x] **1.2 扩展表 migration**(0002)【🟡 建表 + rate_limits】
  - 建 comments、comment_reactions、event_photos、date_options、date_votes、questions(type 含 social)、answers、scheduled_reminders、broadcasts、**rate_limits(D14)**。FK + 约束(comments guest_id/host_id 恰一非空;rate_limits unique(bucket_key,window_start))。
  - 【禁止】**只建表,不得创建任何对应前端**(护栏黑名单)。 【验收】SQL 有效。 【测试】集成:每表插合法/违约束被拒。

- [x] **1.3 [SECURITY] 启用 RLS + 策略**(0003)【🟢】
  - 所有表 enable RLS。**events 策略键于 `host_id=auth.uid()`(D9)**;子表 host(经所有权)可读全部;**🟡 表仅 host SELECT、anon/guest deny(answers 正向 host 读)**;**rate_limits 显式 deny 策略 `for all to authenticated using(false) with check(false)`(M3,非"无策略",DEFINER RPC 以 owner 绕 RLS 访问)**;**storage.objects RLS(封面 host 写/公开读、相册私有,D16)**;profiles `id=auth.uid()`。**所有客数据表的 host 读写策略必须 `to authenticated`(I1,不得默认 public)。**
  - 【禁止】无表漏开 RLS;无 `using(true)`/`with check(true)`;**客数据表上不得有授予 anon/public 角色的策略**(G1/I1)。 【验收】每表 RLS+策略;护栏 DB 权威校验过。 【测试】见 TEST-SPEC §1.3。

- [x] **1.4 [SECURITY] anon 读写收敛**(0004)【🟢 不可打桩】
  - **REVOKE / 从不 GRANT(仅 anon)**:**anon** 对 events/guests/rsvps/comments/date_votes/answers 等客数据表**既无 SELECT 也无 INSERT/UPDATE/DELETE 策略/授权**(读写全经 RPC,D2/G1)。**host(authenticated)经所有权策略直接读自己活动数据(dashboard)——这些策略必须 `to authenticated`(I1,不得默认 public,否则护栏按 anon 策略拦)**。anon 永不可读 contact。
  - 【禁止】anon 不得直 SELECT 到任何客数据表(含 public events 行);客数据表上不得有授予 anon/public 角色的策略。 【验收】anon 直查这些表返回空/被拒;host 能读自己活动的 guests。 【测试】见 TEST-SPEC §1.4 / §1.3(host 自读)。

- [x] **1.5.0 [SECURITY] 共享门禁 helper guest_unlock_status**(0005a)【🟢 前置】
  - 实现 SCHEMA 的 `guest_unlock_status(event_id, token)`(token 或 user_id 命中 + status∈{going,maybe,waitlisted} + event_id scope)。后面 RPC **必须复用**。
  - 【禁止】门禁逻辑只此一处。 【验收】helper 存在且被引用。 【测试】**独立测试 agent**按 TEST-SPEC §1.5(helper 单测:token/user_id 命中、not_going 不解锁、跨活动 token、waitlisted 解锁)。

- [x] **1.5a [SECURITY] get_event_by_slug + 分级 + 私密闸 + 密码**(0005b)【🟢 不可打桩】
  - 三类字段边界;**private 非 service_role → null**(D3);密码:`verify_event_password`(bcrypt)+ 锁定最小响应;count 受 hide_guest_count/私密约束(D7②);**必须调用 guest_unlock_status**。
  - 【禁止】不得无条件返回全字段;private 不得对 anon 裸奔;密码不得是桩;slug 禁 random()。 【验收】见 TEST-SPEC §1.5a。 【测试】§1.5a(独立测试 agent)。

- [x] **1.5b [SECURITY] submit_rsvp**(0005c)【🟢 不可打桩】
  - token→user_id→新建去重(D1,**contact 不参与**);容量 `pg_advisory_xact_lock` 锁内判 going/waitlisted(D7①);写侧 rate_limits 限流(D14);**返回 token + 确认态**(D15)。
  - 【禁止】裸 contact 不得改写/接管既有行、不得回带既有 token;容量不得无锁。 【测试】§1.5b。

- [x] **1.5c [SECURITY] get_guest_list**(0005d)【🟢】
  - 仅 hide_guest_list=false;只 Going/Maybe;**只返回 display_name/status/plus_ones**(脱敏,D15);**调用者需 helper 已解锁**。
  - 【禁止】不含 Can't Go/contact/guest_id/token;未解锁不返回。 【测试】§1.5c。

- [x] **1.5d [SECURITY] add_comment + get_comments**(0005e)【🟢】
  - get_comments 读开放(沿用 D3 可见性闸);add_comment 写门禁=helper、**作者服务端绑定**、rsvp_enabled=false → 仅 host、不写 gif(D6)。
  - 【禁止】未解锁不得发;不得信 client 传 author id;不接外部 GIF。 【测试】§1.5d / §4.1。

- [x] **1.5e [SECURITY] vote/finalize/promote + 聚合读**(0005f)【🟢】
  - vote_dates(多选 upsert);finalize_date/promote_guest(**host-only:auth.uid()=host_id 否则 raise,须 host auth 上下文**,D7③);get_my_events(D1)、get_public_events_by_host(D2)。
  - 【禁止】非 host 不得 finalize/promote;聚合读只返回应公开的。 【测试】§1.5e。

- [x] **1.6 slug 生成函数 + 单元测试** 【🟢】
  - slugify(前40)-{10位base62},gen_random_bytes,中文/空标题纯随机段,**冲突重试一次、再冲突 fail-closed raise**(D15)。
  - 【禁止】禁 random()/时间戳/自增。 【测试】单元:随机段长=10、纯中文输出纯随机段、不重复、不含禁用字符、二次冲突 raise。

- [x] **1.7 Storage buckets + RLS** 【🟢】
  - 建 `event-covers`(公开读/host 写)、`event-photos`(私有);storage.objects RLS(写=authenticated 且拥有 event 且路径前缀);bucket `allowed_mime_types` + `file_size_limit`(D16)。
  - 【禁止】anon 不得写;相册不得公开读。 【验收】桶建好、RLS 生效。 【测试】见 TEST-SPEC(Storage 授权)。

- [x] **1.8 seed + 类型生成** 【🟢】
  - seed:1 host、公开/私密各 1 活动(**location_text 用 sentinel 串**,D15)、若干 guests/rsvps、几条 comments、1 日期投票。生成 TS 类型到 types/database.ts。
  - 【验收】seed 无错;类型文件存在且被引用。 【测试】N/A

---

## Phase 2 — 前端核心闭环 + 安全基础设施

> **动手前必读 DESIGN-TONE.md + frontend-design SKILL.md**。承载安全/数据语义的行为必须正确。

- [x] **2.1 host 认证** 【🟢】
  - magic link(必做)+ Google。**profiles 由触发器建档**(非 client upsert);**username 唯一靠 DB 索引**,设置 UI 查仅提示。/dashboard 守卫。
  - 【禁止】不实现微信;guest 无任何登录入口;client 不得传 profiles.id。 【验收】登录/登出;profile 自动建;守卫生效。 【测试】集成(admin 会话):首登后 profiles 存在;不能为 id≠auth.uid() 写 profiles;并发抢同名只一个胜。

- [x] **2.2a 建/改活动表单 — 核心字段** 【🟢】
  - /dashboard/events/new 与 [id]/edit。字段:标题、描述、日期(+TBD)、地点(text+url+city)、可见性、容量、+1、RSVP开关、**密码(可选,设/清)**。create 生成 slug(event_hosts owner 行由触发器自动)。草稿→发布。zod 校验。
  - 【禁止】问卷/co-host/审核等 🟡 不做 UI。 【验收】建活动→发布→得 /{slug};host 立刻能读自己刚建的活动。 【测试】集成:生成合法唯一 slug;host 读回自己活动。

- [x] **2.2b 建/改活动 — 封面 + 主题 + chip_in** 【🟢】
  - 封面上传 **event-covers 桶**(经 storage RLS);主题色 + 适度特效;chip_in 链接 + 说明。
  - 【禁止】特效不堆砌;chip_in 纯展示;封面上传走桶 RLS。 【验收】可传封面、选主题、填 chip_in。 【测试】见 Storage 授权断言。

- [ ] **2.3 统一首页 / dashboard(我主办 + 我参加)** 【🟢】
  - **按 Partiful**:/dashboard 是统一"你的活动"feed —— **我主办(host_id)+ 我参加(经 get_my_events,guests.user_id)**,upcoming/past 分组,host/going 视觉区分。活动详情页:公开链接+复制、实时人数、**完整名单(host 见全部含 contact)**、waitlist 单列。
  - 【禁止】不串其他 host 的活动。 【验收】host 见自己主办+参加的活动+人数+复制。 【测试】集成:get_my_events 只返回自己的;dashboard 只返回该 host 主办活动。

- [ ] **2.3.5 [SECURITY] 限流 + 私密收敛基础设施**(先于核心页)【🟢 MVP 必做】
  - Next 层 + Upstash 读侧限流(真实 IP 来自 Vercel);**已RSVP/受信轮询走更宽松配额、间隔对齐窗口**(D4/D14)。私密读取只走 Next SSR(受信角色),anon 不可直打 private RPC。**密码尝试独立限流**(D7amend)。
  - 【禁止】限流不得放 Postgres 读侧;不得因取不到 IP 形同虚设;private 不得对 anon 裸奔。 【验收】见 TEST-SPEC §2.3.5。 【测试】§2.3.5。

- [ ] **2.4a [SECURITY] 公开活动页 SSR + 分级 + 私密收敛** 【🟢 语义不可降】
  - /{slug}:**SSR 经受信角色调 get_event_by_slug**。**严格分级**:未解锁只见第一类;解锁后第二类(完整地址)。私密只走 SSR;密码活动显示密码框(verify_event_password,验过发短时凭证)。
  - 【禁止】未解锁页**绝不渲染完整地址/名单**(数据层就不返回);anon 直打 private RPC 被拒。 【验收/测试】见 TEST-SPEC §2.4。

- [ ] **2.4b [SECURITY] RSVP 组件 + token + waitlist** 【🟢】
  - RSVP 组件(name+状态+可选+1+可选 contact)调 submit_rsvp;**token 存 localStorage,绝不进 URL**;成功后重调 get_event_by_slug(token) 渲染解锁视图(D15);复访预填+可改;容量满显示 waitlist。
  - 【禁止】token 绝不进 URL/可分享处;无 localStorage 外违规存储。 【验收/测试】见 TEST-SPEC §2.4。

- [ ] **2.5 密码保护 UI** 【🟢】
  - host 端设/清活动密码(服务端 bcrypt hash);公开页密码框 → verify_event_password → 短时签名凭证 cookie → 读/轮询不再重哈希(D7⑤/amend)。
  - 【禁止】密码不得明文存/传;不得每次读重跑 bcrypt。 【验收】设密码后无正确密码看不到第二类。 【测试】见 TEST-SPEC(密码)。

- [ ] **2.6 加入日历** 【🟢】
  - "加入日历":Google Calendar template URL + .ics 下载。**不依赖 contact。**
  - 【验收】可加 Google 日历/下载 .ics。 【测试】单元:.ics 含正确 DTSTART/SUMMARY/LOCATION。

---

## Phase 3 — 名单展示 + 容量/waitlist UI

- [ ] **3.1 [SECURITY] 公开页名单** 【🟢】
  - /{slug} 经 get_guest_list 渲染(遵守 hide_guest_list/hide_guest_count)。Going/Maybe 分组,显 +1。**轮询/重取(非 Realtime,D4)**:可见性感知轮询,只调分级 RPC。**只对已解锁可见。**
  - 【禁止】不展示 Can't Go/contact;未解锁不可见;不给 anon 开原表 SELECT。 【验收/测试】见 TEST-SPEC §3.1。

- [ ] **3.2 容量 + waitlist UX** 【🟢】
  - 显"还剩 X 位"/"已满—等待名单"。waitlist 访客明确标注。host 单列 waitlist + 手动 promote(promote_guest)。
  - 【验收】容量正确;host 可提升。 【测试】集成:promote_guest 改 going 且尊重容量。

---

## Phase 4 — Activity Feed

- [ ] **4.1 [SECURITY] 评论 UI**(RPC 在 1.5d)【🟢】
  - /{slug} 评论流(时间正序),经 **get_comments**。**读开放**:未RSVP可读。**写门禁**:仅已解锁(token/账号)和 host;未解锁点发提示"先RSVP才能评"。**rsvp_enabled=false → host-only**(guest 隐藏输入框)。**轮询(非 Realtime)**。MVP 纯文本(无 GIF)。
  - 【禁止】未解锁不得发;不接外部 GIF;不给 anon 开 comments 原表。 【验收/测试】见 TEST-SPEC §4.1。

---

## Phase 5 — 日期投票

- [ ] **5.1 日期投票 UI**(RPC 在 1.5e)【🟢】
  - 公开页:有候选且无最终日期时显示投票,多选(复用 token),**轮询计票**。host 改活动页:增删候选 + 每候选"敲定"(finalize_date 写回 starts_at,**保留投票记录**)。
  - 【禁止】敲定后不得删投票记录。 【验收】投票闭环+计票+敲定生效。 【测试】集成:vote_dates 多选 upsert;finalize_date 设 starts_at 且 votes 仍存。

---

## Phase 6 — 个人页 + 收尾

- [ ] **6.1 Organizer Profile** 【🟢】
  - /u/[username] 经 **get_public_events_by_host** 聚合该 host 公开活动(**不 anon 直查表**,D2)。username 设置入口 + 唯一校验。
  - 【禁止】不暴露私密活动。 【验收】/u/[username] 见该 host 的 public 活动。 【测试】集成:不含 private;走 RPC 非直查表。

- [ ] **6.2 [SECURITY] OG meta + 分享预览** 【🟢】
  - 活动页 OG(标题+封面)。**私密/密码活动 OG 只暴露第一类(标题/封面/描述),不含地址。**
  - 【禁止】OG 不得泄露完整地址/名单。 【验收】预览显示标题+封面。 【测试】单元:OG 不含 location_text。

- [ ] **6.3 空/加载/错误态 + 移动端** 【🟢】
  - 全页面空/加载/错误态齐全;移动端可用;reduced-motion/键盘焦点/对比度达标。
  - 【验收】关键页窄屏可用、各态有处理。 【测试】N/A

- [ ] **6.4 README + 最终安全过一遍** 【🟢】
  - README:setup/env/migration/部署(Vercel+Supabase+Upstash)。对照 CLAUDE.md 安全清单 + 本报告 D1–D16/G1–G8 逐条核。
  - 【验收】README 完整;安全清单全过或记 BLOCKERS。 【测试】跑全量套件全绿。
