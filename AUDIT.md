The code-review skill doesn't fit this task — there's no diff to review. My actual task is to synthesize 241 audit findings into a prioritized Chinese-language markdown report. Let me produce that directly.

Below is the deliverable.

---

# JU 全站审计报告 — 启动前问题清单(中文受众)

## 执行摘要

JU 当前以英文 UI 和 "Partiful" 品牌交付,**对中文受众而言无法上线**:全站零 i18n 架构、字体无 CJK 子集、品牌字标硬编码为 "partiful"。除此之外存在两个会导致活动信息错误/不可用的真实 bug(时区错位、取消流程缺失)。建议把 i18n、品牌替换、无障碍作为三个系统性"一次性扫除"来做,其余为定点修复。

**严重度计数(去重后):** 🔴 Blocker 5 · 🟠 High 24 · 🟡 Medium 33 · ⚪ Low 30 = **92 条**(由 241 条原始发现合并而来)

**标记说明:** `[系统性]` = 最好作为一次扫除统一修复;`[定点]` = 单点修复。

---

## 🔴 Blocker — 不修不能上线

### B1. 全站无 i18n,所有文案为硬编码英文 `[系统性]`
**为什么重要:** 受众是年轻中国用户,但 package.json 无任何 intl/i18n 依赖,无 messages/locales 目录,所有用户可见字符串(页面、Server Component、Client Component、Server Action、API route 的 `message` 字段、lib 纯函数、zod 校验信息、sr-only/aria 标签)都是内联英文字面量。整个产品以英文呈现。
**文件:** `web/`(全局,无 i18n 设施);`package.json`(无 intl 依赖)
**修复方向:** 先决定"纯中文" vs "中英双语"。纯中文:就地把字面量改为简体中文(契合 CLAUDE.md "简单优于花哨")。双语:引入 next-intl(App Router 原生),建 `messages/zh.json`/`en.json`,所有集群(含 `lib/` 和 `api/`)抽取入目录。**不要半成品式地搭一半 locale 系统。**

> 本条聚合了所有 per-surface 的"该界面文案全是英文"发现(landing/auth/dashboard/create-edit/host-detail/settings/event-core/rsvp/dynamic-sections/password/organizer/error 页等),以及 i18n-sweep 的逐面清单。**这些不再单列**,统一在此扫除;下文 i18n 小节仅保留 i18n 中"非纯翻译"的功能性/correctness 子问题。

### B2. 字体仅加载 Latin 子集,中文字形将回退/渲染不一致 `[系统性]`
**为什么重要:** `layout.tsx` 中 Geist、Geist_Mono、Bricolage_Grotesque 均 `subsets:["latin"]`。展示字体 Bricolage_Grotesque 完全无 CJK 字形,标题/字标/数字一旦变中文会静默回退到系统字体,品牌展示型排版在最该出彩的地方(海报 hero、dashboard 问候)崩塌;正文跨设备渲染不一致。只翻译文案而不解决字体 = 视觉上仍是坏掉的中文 UI。
**文件:** `web/app/layout.tsx:6-22`(:8,13,20)
**修复方向:** 加入 CJK 字体(Noto Sans SC / 自托管子集),在 `--font-sans`/`--font-display` 加稳健 CJK 回退链(`'PingFang SC','Microsoft YaHei',sans-serif`)。next/font 的 Google CJK 体积大,优先自托管子集或系统 CJK 回退。

### B3. 字标组件硬编码 "partiful",品牌应为 "JU" `[系统性]`
**为什么重要:** `wordmark.tsx:13` 渲染字面量 "partiful"+珊瑚色星号,被至少 7 个界面复用(homepage、dashboard、login、settings、not-found、error、auth-code-error)。这是产品最显眼的品牌元素,在每个界面向用户展示竞品名,属上线阻断级品牌错误。
**文件:** `web/components/brand/wordmark.tsx:13`
**修复方向:** 把字面量改为 "JU"(或选定的中文字标);决定是否保留星号 flourish。改这一处即修复全部 7 个消费界面。另需处理 3 处**绕过组件的内联字标**(见 B3b)。

### B3b. 三处内联字标 + 文档 title 绕过 Wordmark 组件 `[系统性]`
**为什么重要:** 仅改组件无法覆盖这三处硬编码,均在高流量公开界面:`global-error.tsx:33`(崩溃页)、`u/[username]/page.tsx:108`("made with partiful*" 主办人页脚)、`[slug]/page.tsx:149`(公开活动页页脚——访客核心漏斗)。此外 `layout.tsx:25` 文档 `<title>` = "Partiful — throw something good",是浏览器 tab 与默认分享/SEO 标题。
**文件:** `web/app/global-error.tsx:33`;`web/app/u/[username]/page.tsx:108`;`web/app/[slug]/page.tsx:149`;`web/app/layout.tsx:25`
**修复方向:** 全局搜索替换 `partiful<span className="text-coral">*</span>`;两个页脚重构为共享组件防止漂移;global-error 须自包含但改为 JU;`<title>` 改为 JU 中文标题。

### B4. 活动取消流程完全缺失,且公开页把已取消活动当作正常活动渲染 `[定点]`
**为什么重要:** `status='cancelled'` 是合法 DB 状态且写入侧已强制(`submit_rsvp` 抛 'event is cancelled'),但**无任何 UI 能设置取消**(表单只有 publish/draft,`updateEvent` 把 status 硬编码为 published|draft)。即便设了取消,公开页只对 draft 做 `notFound()`,已取消活动仍渲染完整 live 页和可用 RSVP 表单,访客填完名字提交后才看到英文错误。活动取消是核心主办动作(计划常变),访客必须**提前**看到清晰的"已取消"。
**文件:** `web/app/[slug]/page.tsx:93`;`web/app/dashboard/events/actions.ts:117`;`web/app/dashboard/events/event-form.tsx:420-438`
**修复方向:** host 详情页加"取消活动"动作设 `status='cancelled'`;公开页对 cancelled 像"可见的 draft"处理:渲染海报+醒目"活动已取消"横幅,禁用 RSVP/日历/投票。加载时的活动状态(ended/cancelled)需贯穿 RsvpForm。

---

## 🟠 High — 真实 bug / 重大 UX

### 时区 / 时间正确性

#### H1. datetime-local 无时区存储,活动时间整体偏移 `[定点]` 🔴近 blocker
**为什么重要:** 表单发送裸本地时间串(如 `2026-06-20T19:30`),`parseEventForm` 原样返回,`actions.ts` 直接写入 timestamptz 列。无偏移字面量被 Postgres 按**服务器时区(Supabase 通常 UTC)**解释,而非主办浏览器时区。北京(UTC+8)主办选 19:30 → 存为 19:30 UTC = 北京次日 03:30。**邀请上最重要的"何时"对每个活动都是错的。**
**文件:** `web/app/dashboard/events/event-form.tsx:64-70`;`web/lib/events/schema.ts:91-96`;`web/app/dashboard/events/actions.ts:34-35`
**修复方向:** 持久化前转完整 ISO 带偏移(`new Date(localValue).toISOString()`),或捕获浏览器时区;考虑显式 event timezone 列,使显示时间不随观看者 locale 漂移。

#### H2. 日期/时间用硬编码 en-US locale 且无 timeZone,跨时区显示错时 `[系统性]`
**为什么重要:** `format.ts`(:6,14,37)与 `comments.ts`(:88)全用 `Intl.DateTimeFormat("en-US",…)`,渲染遍及 dashboard/host-detail/公开 hero/日期投票/主办人页/活动流。中文用户看到 "Sat, Jun 21, 6:00 PM" 而非 "6月21日 周六 18:00"。更严重:未设 `timeZone`,实例按每个观看者浏览器时区格式化——海外/设备时区错的访客看到错误墙钟时间,会在错的小时到场。这是 correctness bug,非仅文案。
**文件:** `web/lib/events/format.ts:6-48`;`web/lib/events/comments.ts:88-100`
**修复方向:** locale 改 `zh-CN`,以稳定显式时区渲染并显示时区标签;统一格式化器供所有界面共用。

### 活动生命周期 / 数据一致性

#### H3. 进行中的活动(已开始未结束)被误判为"已结束" `[定点]`
**为什么重要:** `endMs()` 返回 `ends_at ?? starts_at`。对"有开始无 ends_at"的常见活动,一旦 `starts_at < now` 立即归入 Past——主办在自己派对进行时打开 dashboard 看到它在"已结束"。完全无"正在进行/live"状态。
**文件:** `web/lib/events/feed.ts:54`
**修复方向:** 仅当存在真实 `ends_at` 且早于 now 才算过去,或 ends_at 为 null 时用宽限窗口(starts_at + N 小时);增加"正在进行"分组。

#### H4. 无"活动已结束"概念,过期活动仍可 RSVP 且与未来活动无异 `[定点/系统性]`
**为什么重要:** `get_event_by_slug` 与 `submit_rsvp` 均不比对 now()。公开页对过期活动仍渲染 "Reply to save your spot" 并无限接受 RSVP/评论;RSVP 表单只 gate `rsvpEnabled`/`isFull`,从不看 ends_at/starts_at,过期活动显示完整可用表单和 "You're in 🎉"。
**文件:** `web/app/[slug]/event-view.tsx:95,151-165`;`web/components/events/rsvp-form.tsx:86`;`web/lib/events/feed.ts:75`
**修复方向:** view 层算 `ended` 标志;公开页显示已结束横幅、关闭/相对化 Add-to-Calendar、gate RSVP/投票;理想在 `submit_rsvp` 也拒绝过期活动,使 DB 为权威。

#### H5. 编辑已取消活动会静默"复活";"Move to draft" 会下线已分享的活动 `[定点]`
**为什么重要:** `updateEvent` 总以 `intent==='publish'?'published':'draft'` 覆盖 status。(a)主办打开已取消活动点任一按钮即静默恢复为 published/draft,且无任何按钮能取消;(b)对已分享的已发布活动点 "Move to draft" 会让公开页对所有 draft 返回 `notFound()`,瞬间令所有现存邀请链接 404、孤立现有 RSVP/评论,无确认无警告。
**文件:** `web/app/dashboard/events/actions.ts:114-122,117`;`web/app/dashboard/events/event-form.tsx:94,420-438`
**修复方向:** 已有 RSVP/已发布的活动不提供裸 "Move to draft",或在确认对话框后(说明链接将失效)才允许;编辑默认保留 published;cancelled 须有独立动作且不被 Save 副作用翻转。

### 主办核心循环缺失能力

#### H6. 无删除活动能力 `[定点]`
**为什么重要:** `app/dashboard/events` 与 `lib/events` 全无 delete/cancel/archive 动作。创建了测试/重复/误建活动的主办永远无法清除,杂乱堆在 dashboard。任何 CRUD 产品的基础能力。
**文件:** `web/app/dashboard/events/actions.ts:1-152`
**修复方向:** 加受 RLS 约束(host_id = auth.uid())、确认后的删除(或软删/归档)server action;权衡软/硬删(guests/RSVPs 引用该活动)。

#### H7. host 详情/管理视图无发布/取消/删除等生命周期动作 `[定点]`
**为什么重要:** 详情页渲染 status chip 却无任何动作改变它:只有 "Edit event" 和逐行 "Move to going"。主办无明显发布按钮;需取消派对(通知访客)或删测试活动时毫无控制;`status='cancelled'` 无 UI 可达也无法向访客呈现。
**文件:** `web/app/dashboard/events/[id]/page.tsx:71-96`
**修复方向:** 加 Publish/Unpublish、Cancel event、Delete(server action 命中 host-scoped RPC/RLS);cancelled 时渲染清晰横幅。

#### H8. Draft 活动显示 "Copy link" 却不警告该公开链接为死链(404) `[定点]`
**为什么重要:** 分享区始终渲染公开链接,但公开页对 draft `notFound()`。主办复制/分享尚为 draft 的活动链接,访客落到 404,页面无任何提示链接需发布后才生效——主分享界面上的静默高危陷阱。
**文件:** `web/app/dashboard/events/[id]/page.tsx:98-103`
**修复方向:** `status !== 'published'` 时替换/标注分享卡为"发布后链接才生效"并内联 Publish 按钮;draft 时禁用/置灰复制控件。

#### H9. 主办卡片不显示 RSVP/到场人数 `[定点]`
**为什么重要:** host dashboard 的首要价值是一眼看到响应数("24 going · 3 waitlist · 5 maybe"),但 EventCard 只渲染标题/时间/城市/徽章,`get_my_events` 也不返回聚合计数。主办必须逐个点开才知是否有人来——核心循环重大功能缺口。
**文件:** `web/app/dashboard/page.tsx:158`;migration 0011:327-345
**修复方向:** `get_my_events` 聚合 going/waitlist/maybe 计数,卡片渲染紧凑计数行;参与者卡片可显示自己的 RSVP 状态。

#### H10. host 详情页无"以访客身份预览"/公开页预览 `[定点]`
**为什么重要:** 主办只能复制链接,无法从该视图打开/预览公开活动页(也无法验证它不是 draft 404),须手动粘贴到新标签。邀请类产品的基础能力。
**文件:** `web/app/dashboard/events/[id]/page.tsx:98-103`
**修复方向:** 在复制控件旁加"以访客身份预览"链接 → `/${slug}`(新标签打开)。

#### H11. 主办无法触达访客:访客列表缺联系信息聚合/导出 `[定点]`
**为什么重要:** select 只取 display_name + contact;无 going+plus-ones 的总人头,无导出/复制全部联系人,contact 是裸字符串且无类型标识(email/手机/微信),无 tel:/mailto:/复制动作。中文受众的 contact 很可能是微信号。这阻断了核心 job——联系你的访客。
**文件:** `web/app/dashboard/events/[id]/page.tsx:55,148,194`
**修复方向:** 加"导出访客列表/复制全部联系人";单条联系人可操作(复制/mailto/tel);显式显示总人头(going + plus-ones)。

#### H12. 封面图无法在创建时添加(先有蛋还是先有鸡) `[定点]`
**为什么重要:** 创建模式 `eventId=null`,CoverUploader 显示"先保存活动再加封面"且无上传按钮(storage RLS 按 `<event_id>/` 前缀)。对图片优先的邀请产品,封面是页面主角,把它埋在保存之后会让大量主办发布无封面活动。
**文件:** `web/components/events/cover-uploader.tsx:21-49,68`;`web/app/dashboard/events/event-form.tsx:137`
**修复方向:** 创建模式允许暂存文件(客户端持有或临时/用户域路径),建行后移入 `<event_id>/`;或客户端生成 event id / 预建 draft 行以便内联上传。

#### H13. 已发布活动改期/改址/取消不会触达已 RSVP 的访客 `[定点]`
**为什么重要:** 编辑已发布活动只写行;schema 有 scheduled_reminders/broadcasts 但无调度/发送 UI;轮询只刷新当前开着标签的访客。主办无任何产品内方式告诉已 RSVP 访客"日期变了/已取消"。叠加日历功能(访客已把旧时间加入日历),改期后访客持有陈旧日历项且无信号。
**文件:** `web/app/dashboard/events/actions.ts:114`;`web/components/events/add-to-calendar.tsx:24`
**修复方向:** 至少加 updated_at 驱动的"活动已更新"提示;鉴于改期/改址的核心性,上线前考虑轻量 broadcasts"通知访客"流。

### RSVP / 解锁

#### H14. RSVP 成功后解锁重读静默失败,访客零反馈 `[定点]`
**为什么重要:** 提交成功后 `fetchSnapshot` 在任何网络错误/非 ok/locked 时返回 null,`applySnapshot` 静默忽略 null。访客看到 "You're in 🎉" 但承诺的解锁(详细地址、谁来)永不出现,无 spinner 无重试无解释。对核心卖点为"RSVP 看确切地址"的产品,这是死胡同:访客做对了一切而页面看似坏掉。
**文件:** `web/app/[slug]/event-client.tsx:147`(81-86,218-228)
**修复方向:** 区分"解锁失败"与"解锁进行中";重读期间显示加载态,null 时给重试入口("刷新查看活动详情")而非静默冻结。

#### H15. 已取消活动从表单不可达,提交后才报错 `[定点]`
**为什么重要:** `event.status` 在 view schema 可得,但 RsvpForm 未收到 status prop。已取消活动的访客看到正常诱导性表单,填完提交才得英文 409 错误,且错误路径表单仍完全可交互可反复重试注定失败的提交。
**文件:** `web/app/[slug]/event-client.tsx:158`
**修复方向:** 把 event.status(及 ended)透传入 RsvpForm,渲染输入前短路为清晰"活动已取消"提示(同 `!rsvpEnabled` 处理)。

#### H16. 账号跨设备认回(guests.user_id)在 UI 中是死的 `[定点]`
**为什么重要:** SCHEMA D1 明确设计 user_id 支持"跨设备认回 + 我参加的局",`guest_unlock_status` 在 `auth.uid()=g.user_id` 时解锁。但公开读路径用 `createServiceClient()` 只转发 guest_token,从不传 auth user;service role 下 `auth.uid()` 为 NULL,user_id 分支永不触发。已登录用户在手机 RSVP 后用笔记本打开同活动看到全锁页面,须重新 RSVP(易产生重复 guest)。
**文件:** `web/lib/events/read-event.ts:51`;`web/app/api/events/[slug]/route.ts:58`;`web/app/[slug]/page.tsx:88`
**修复方向:** 有已认证会话时,用用户自己的认证客户端(或传可信 user_id 给 DEFINER 读)解锁,使 user_id 分支无需 localStorage token 即可生效。

### 主办身份 / 主办人页

#### H17. 主办人页只显示 @handle + 字母 monogram,忽略 display_name/avatar_url `[定点]`
**为什么重要:** profiles 表有 display_name 和 avatar_url,但 `get_public_events_by_host` 只返回活动行,页面只渲染 "@handle" + 单字母渐变块。对"主办人主页"而言身份极贫瘠——访客无法识别/信任一个陌生主办。
**文件:** `web/app/u/[username]/page.tsx:71-85`
**修复方向:** 扩展 RPC 返回 display_name 与 avatar_url,zod schema 加字段,渲染头像(handle 为回退)与 display_name 为 H1、@handle 为副行;monogram 仅作头像缺失回退。

#### H18. 无头像设置 UI(数据模型已有 avatar_url) `[定点]`
**为什么重要:** profiles.avatar_url 已存在且注册时填充,但 settings 表单只编辑 display_name/username,全应用无头像上传/预览。对面向年轻中国社交受众的产品是真实功能缺口。
**文件:** `web/app/dashboard/settings/profile-form.tsx`;`supabase/migrations/0001_core_tables_a.sql:26`
**修复方向:** 加头像上传字段(Supabase Storage)+预览+校验+移除;在公开主办人页展示;复用 avatar_url 列。

### 数据丢失 / 静默错误

#### H19. 清空 username 字段会静默删除公开 handle `[定点]`
**为什么重要:** `unchanged` 在 `trimmed===""` 时为 true,清空字段只显示无害默认提示;提交时空值被当作 `username=null` 写入,静默移除公开 handle,`/u/<username>` 与所有已分享链接立即失效,反馈仅 "Saved."。普通编辑手势(清空再重打)+ 误提交触发的不可逆数据丢失。
**文件:** `web/app/dashboard/settings/profile-form.tsx:32,64`;`web/app/dashboard/settings/actions.ts:40-48`
**修复方向:** 设置后禁止清空,或检测 `initialUsername!=="" && trimmed===""` 显式警告("将移除你在 /u/<old> 的公开主页")+确认步骤;成功提示应说明改了什么。

#### H20. RPC 错误被静默吞掉,失败与"无活动"完全相同 `[定点]`
**为什么重要:** dashboard 在 RPC 错误时设 `events=[]` 并渲染欢快的空态"No events yet…"。有活动但遇瞬时 DB/网络错误的主办被告知没有活动,无重试无错误信息,可能以为活动消失了。settings 与主办人页同样把 fetch 错误塌缩为空态。
**文件:** `web/app/dashboard/page.tsx:36`;`web/app/dashboard/settings/page.tsx:16-20`;`web/lib/events/read-public-events.ts:29`
**修复方向:** 错误时渲染带重试的独立错误态(而非空态)并记录上报;reader 返回可辨别结果或对硬 RPC 错误抛出让 error.tsx 接管。

### Auth

#### H21. Auth 回调忽略 provider/OTP 错误参数,掩盖真实失败 `[定点]`
**为什么重要:** 回调只读 code/token_hash/type。Google OAuth 或 Supabase 拒绝时重定向带 `?error=…&error_description=…`(常无 code),落到通用 error 页,其文案声称"链接已过期且只能用一次"——对 OAuth access_denied/取消授权/配置错误是错误信息。取消 Google 授权的用户被告知链接过期,且丢失全部诊断信号。
**文件:** `web/app/auth/callback/route.ts:24-44`
**修复方向:** 读 error/error_description,存在则带原因码重定向并渲染对应信息(取消 vs 过期 vs 服务器错误);服务端记录 error_description。

#### H22. 魔法链接发送后无重发/冷却,收不到邮件即死胡同 `[定点]`
**为什么重要:** "已发送"态只提供 "Use a different email",无重发、无倒计时、无"检查垃圾箱"提示。邮件延迟/丢失(很常见)时用户唯一选择是重打同地址盲目重提。真实 auth 产品需带冷却的重发,否则投递抖动变成漏斗硬流失。
**文件:** `web/components/auth/login-form.tsx:45-61`
**修复方向:** 加"重新发送"按钮 + 30-60s 冷却倒计时,保留已输入邮箱,加垃圾箱提示。

---

## 🟡 Medium

### i18n 功能性子问题(非纯翻译)`[系统性,但需逐点处理]`

#### M1. 日期投票选项标签丢失多日候选的结束"日期" `[定点]`
`formatOptionWhen` 的结束只格式化 `{hour,minute}`。跨午夜/多日候选(周五–周日)渲染为 "Sat, Jun 17, 10:00 PM – 2:00 AM" 无日期提示,访客无法区分单夜与多日——这正是日期投票要传达的信息。公开 DatePoll 与 host DatePollManager 双侧都误导。
**文件:** `web/lib/events/format.ts:37-48` → 结束日期与开始不同日时用完整日期格式化。

#### M2. icsFilename 剥除所有非 [a-z0-9],中文标题活动全下载为 'event.ics' `[定点]`
`.replace(/[^a-z0-9]+/g,'-')` 后纯中文标题塌缩为空,返回字面量 'event.ics'。每个中文活动下载同名无意义日历文件。
**文件:** `web/lib/events/calendar.ts:159-170` → 用 `/[^\p{L}\p{N}]+/gu` 保留 CJK,或音译/短哈希 + "活动.ics"。

#### M3. Supabase 原始 error.message 直接展示,未翻译未映射 `[定点]`
登录两路径把 `error.message` 原样塞入 alert。"Email rate limit exceeded" 等英文技术信息泄露后端措辞且永不本地化。
**文件:** `web/components/auth/login-form.tsx:31,42,108-110` → 把已知 Supabase 错误码映射为友好中文,未知回退"出错了,请稍后再试"。

#### M4. API route / server action 的 `message` 字段为英文且直接渲染 `[系统性]`
RSVP/comments/vote route 与 events/promote/date 的 server action 返回的 message 被客户端原样显示。位于 `app/api` 与 actions 中,易在 i18n 扫除时遗漏。
**文件:** `web/app/api/events/[slug]/{rsvp,vote,comments}/route.ts`;`web/app/dashboard/events/actions.ts`、`[id]/actions.ts`、`[id]/date-actions.ts`;`web/lib/events/schema.ts:71-203` → 全部翻译,或返回 code 由客户端映射。

#### M5. zod 校验信息为英文且直达用户 `[系统性]`
schema.ts/rsvp.ts/comments.ts/username.ts 的 zod 信息经 `issues[0].message` 直接 setError 显示。本地化必须覆盖 schema 层,非仅组件。
**文件:** 上述 lib 模块 → 翻译并集中。

#### M6. 示例数据美国化(Venmo / Brooklyn / $) `[定点]`
chip-in 占位 'https://venmo.com/u/you'、备注 '$10 covers drinks…'、schema 错误提示也指向 venmo。中文用户用微信/支付宝/¥。
**文件:** `web/app/dashboard/events/event-form.tsx:320-353`;`web/lib/events/schema.ts:85` → 本地化为微信/支付宝/¥与中国城市占位。

### 无障碍(a11y)`[系统性 — 一次扫除]`

#### M7. 多处 role=radio/radiogroup 无键盘契约(箭头键/roving tabindex 缺失) `[定点但模式性]`
RSVP 状态选择器声明 radio 角色却无 onKeyDown、无 tabIndex 管理:三个 button 都在 tab 序、箭头键无效,宣告角色与实际行为矛盾(WCAG 2.1.1/4.1.2)。这是公开访客页的主交互。
**文件:** `web/components/events/rsvp-form.tsx:180-201` → 实现 roving tabindex + 箭头键,或改原生 radio,或降级为 aria-pressed 切换按钮组。

#### M8. 直播轮询的评论流/访客列表/投票计数无 aria-live,屏幕阅读器静默 `[系统性]`
CommentsFeed/GuestList/DatePoll 每 15s 更新但容器无 aria-live/role=log/status。新评论、新到访客、票数变化对 AT 用户不可知——"看着 yes 滚进来"的核心体验对 AT 不可用。
**文件:** `comments-feed.tsx:155-185`;`guest-list.tsx:101-118`;`date-poll.tsx:121-148` → 列表包 aria-live="polite"(聊天流用 role=log)。

#### M9. 表单错误/成功消息未与字段关联且不可靠播报 `[系统性]`
auth、create-edit、settings、password、rsvp 多处:错误未通过 aria-describedby 绑定输入、无 aria-invalid、状态切换不移焦点;成功面板替换整个表单后焦点遗留在被移除的按钮上。
**文件:** `login-form.tsx:107-111`;`event-form.tsx:439-448`;`profile-form.tsx:109-123`;`password-gate.tsx:134-141`;`rsvp-form.tsx:166` → 加 aria-describedby/aria-invalid 接线,状态变更后移焦点至标题或 aria-live 区。

#### M10. 主题色/状态仅以颜色传达(无文本/勾选/对比保证) `[系统性]`
主题色 radio 仅为色圈+ring;dashboard 状态 pill 用 /15 极低透明度填充疑似不达 AA;hero "when" 用 `style={{color:accent}}` 任意主题色无对比保证;RSVP 选中态/Host 徽章/+1 徽章用 host 自选 accent + 固定 text-ink,深 accent 上深字不可读。
**文件:** `event-form.tsx:139-162`;`dashboard/page.tsx:167`;`event-view.tsx:206-208`;`rsvp-form.tsx:192-195`;`comments-feed.tsx:166-171`;`guest-list.tsx:109-114` → 选中态加可见勾选/文本;按亮度推导前景色或约束 accent 调色板至对比安全。

#### M11. helper/hint 文本用 text-muted/60,对比约 3.4-3.8:1 不达 AA `[系统性]`
`#b3a9c9` @60% 混合后约 #786f8c,承载非装饰内容(封面约束行、各字段 (optional)/限定语)。低视力用户可能漏读"哪些必填、字段含义"。
**文件:** `cover-uploader.tsx:70`;`event-form.tsx:166,207,226,240,254,…`;`date-poll-manager.tsx:88` → 去 /60 用纯 text-muted,或新增 ≥4.5:1 的 --color-faint。

#### M12. CopyLinkButton 的 aria-live 放在标签自变的按钮上(播报不可靠) `[定点]`
aria-live 置于文本在 "Copy link"↔"Copied" 切换的按钮本身,跨 SR 播报不一致;prompt() 回退路径无播报。
**文件:** `web/components/events/copy-link-button.tsx:35-43` → 按钮标签保持稳定,单独 sr-only `role=status aria-live=polite` 节点承载"链接已复制"。

### 移动端 `[系统性]`

#### M13. 访客可点目标偏小(h-9=36px / 裸文本链接 ~20px) `[系统性]`
公开 Add-to-calendar、Lock in/Remove/Move-to-going 仅 36px;面包屑、页脚、Settings 等裸文本链接 ~18-20px 无命中内边距。公开活动页页脚是唯一导航却最难点。
**文件:** `add-to-calendar.tsx:46`;`date-poll-manager.tsx:148,161`;`promote-button.tsx:27`;多处面包屑/页脚 → 主触控控件升至 h-11(44px);文本链接加 py-2/min-h-11。

#### M14. RSVP 状态按钮固定 grid-cols-3,窄屏中文标签易裁切/换行 `[定点]`
固定三列,320px 下每格 ~90px;"Join waitlist" 与本地化中文标签更长易换行破坏对齐。页面最重要控件。
**文件:** `web/components/events/rsvp-form.tsx:180-201` → 窄屏降级单列/auto-fit;用 min-h 替固定 h-11 让换行优雅。

### create-edit 功能性

#### M15. 发布无完整性校验,可发布无日期无地点的活动 `[定点]`
只有 title 必填,publish intent 无视一切写 published。可发布公开、开启 RSVP、无日期(date_tbd 未勾)、无城市、无地址的活动。公开页将显示无时无地的邀请。
**文件:** `web/lib/events/schema.ts:71-128`;`actions.ts:76,117` → publish 时要求至少日期(或 date_tbd)与 location_city,或警告关键信息缺失;draft 保持宽松。

#### M16. 无未保存更改保护;封面 Remove 不删存储对象致孤儿文件 `[定点]`
长表单无 beforeunload/dirty 守卫,点面包屑/返回静默丢弃所有编辑。更糟:CoverUploader 选图即上传,Remove 只清本地 url state 不删已上传对象,移除/替换的封面在 bucket 累积孤儿,导航离开后字节仍存而表单看似空。
**文件:** `cover-uploader.tsx:41-54`;`event-form.tsx`(表单级) → 加未保存提示;Remove/Replace 时删旧对象或延迟上传至保存。

#### M17. date_tbd / 日期投票 / 固定日期三态未协调,易陷"无日期 limbo" `[定点]`
取消 date_tbd 且 starts_at 留空 → 非 TBD 活动既无开始时间也无投票 UI(showPoll false),已发布活动无任何日期且无入口添加。
**文件:** `web/app/dashboard/events/[id]/edit/page.tsx:46-50,100-105`;`schema.ts:115-128` → date_tbd 为 false 时(至少发布时)要求开始时间;始终提供添加日期入口。

#### M18. 密码 RPC 错误路径致表单不一致无恢复 `[定点]`
先写列再单独跑密码 RPC,失败返回"详情已保存但密码未更新",但密码字段状态不受控、clear_password 仍勾选,主办无法判断是否重输,重试会重提整个表单。
**文件:** `web/app/dashboard/events/actions.ts:127-149` → 密码更新与行更新原子化(单 RPC/事务),或给密码单独定向重试。

#### M19. 主办无法配置已存在的隐私列(hide_guest_list/count/feed_timestamps) `[定点]`
events 表定义了这些非 deferred 隐私列,但创建/编辑表单不暴露任一,能力静默不可用。
**文件:** `event-form.tsx:356-418`;`0001_core_tables_a.sql:65-70` → 在隐私区暴露非 deferred 隐私开关。

### host-detail 功能性

#### M20. "Spots left" 会陈旧:页面无 dynamic/no-store,人头可被缓存 `[定点]`
这是 RLS 实时 RSVP 计数读,却无 `dynamic='force-dynamic'`/`revalidate=0`。App Router 默认缓存下管理视图(Going 计数、Spots left/Full)在访客 RSVP 后可渲染陈旧数。
**文件:** `web/app/dashboard/events/[id]/page.tsx:1-10,67-69` → 加 force-dynamic 或接 Realtime。

#### M21. host 无反向操作:可 waitlist→going 却不能降级/移除/挪回 waitlist `[定点]`
PromoteButton 只能 waitlisted→going,无法腾出座位;文案却暗示主办管理容量。超卖或有人退出时主办被卡住。
**文件:** `web/app/dashboard/events/[id]/page.tsx:114-119,127-129` → going/maybe 行加 host 动作(移除、挪 waitlist),命中受同容量锁的 host-only RPC。

#### M22. 容量 stat 含义二义,"Full" 分支隐藏真实数字 `[定点]`
设容量时第三 stat 为 "Spots left"/"Full"(remaining=0),丢失 50/50 实数,超卖也只读 "Full";容量为 null 时同一格变 "Capacity"/"No limit",一格两义。
**文件:** `web/app/dashboard/events/[id]/page.tsx:108-111` → 一致显示 "X/容量 · 已满",goingCount>capacity 时显式警告。

#### M23. host 详情页不显示富内容(描述/封面/地点/结束时间/投票状态) `[定点]`
表只 surface 标题+时间+状态;主办看不到访客所见,date-poll 活动无"日期未定"提示,须进 Edit 才能看。
**文件:** `web/app/dashboard/events/[id]/page.tsx:45-50,86-87` → 加紧凑摘要卡;date-poll 显示"日期未定 — N 票"链接到 finalize。

### RSVP 功能性

#### M24. plus_ones 在切离 "going" 后静默保留并随更新提交 `[定点]`
+1 下拉仅 going 时渲染,但切到 maybe/not_going 不重置 plusOnes,onSubmit 不按 status 条件发送 → maybe 携带幻影 +2,服务端不为非 going 清零,存储不连贯。
**文件:** `web/components/events/rsvp-form.tsx:105` → `plus_ones: allowPlusOnes && status==='going' ? plusOnes : 0`;服务端可防御性清零。

#### M25. +1 下拉提供超出剩余容量的数量且无警告,访客被静默 waitlist `[定点]`
下拉总提供 0..maxPlusOnes 无视 capacity_remaining;近满活动选 +3 时整组降级 waitlisted,唯一信号是提交后确认行。
**文件:** `web/components/events/rsvp-form.tsx:234` → 有限剩余时在 +1 控件旁显示剩余座位并禁用超额选项,文案说明大团队入 waitlist。

#### M26. isFull "Join waitlist" 框架误标已持座访客自己的 going 按钮 `[定点]`
isFull 纯活动级,已持 going 座的回访客看到自己的再确认按钮标 "Join waitlist" 并提示"满了入 waitlist",暗示编辑会丢座——而 `submit_rsvp` 排除调用者自身行,UI 在撒谎。
**文件:** `web/components/events/rsvp-form.tsx:197` → 派生有效 isFull,viewer 已持 going 时为 false。

#### M27. 访客无法撤回/删除自己的 RSVP(only not_going) `[定点]`
只能设 not_going(仍保留 display_name+contact 行)。处理个人联系信息的产品(PIPL 下中国受众对数据删除敏感)应有删除自身数据途径;token 已授权编辑该行。
**文件:** `web/components/events/rsvp-form.tsx:159` → 加"取消我的回复/删除我的信息"调 token-scoped 删除 RPC 并清 localStorage。

#### M28. 404(已删活动)产生空消息 + 误导性"Try again"重试循环 `[定点]`
404 返回 `{ok:false,error:"not_found"}` 无 message,表单回退"Couldn't save your RSVP. Try again.",让访客重试永不存在的活动。任何无 message 的错误同陷此阱。
**文件:** `web/app/api/events/[slug]/rsvp/route.ts:87` → not_found 返回用户可见消息("该活动不存在或已被删除"),终态错误隐藏重试控件。

#### M29. not_going 保存 token+记录却不解锁页面,产生矛盾死胡同 `[定点]`
unlock 集为 {going,maybe,waitlisted},not_going 不解锁。访客选 "Can't go" 后,确认行说"已不去"但页面仍显示城市级"RSVP 看确切地址",表单与页面对"是否已回复"不一致。
**文件:** `web/components/events/rsvp-form.tsx:30`;`web/app/[slug]/event-client.tsx:81` → not_going 时渲染明确"已婉拒 — 可在下方改变主意"并抑制解锁提示。

### password-gate

#### M30. 429 限流无倒计时无恢复,丢弃服务端 retry_after `[定点]`
服务端返回 retry_after 与 Retry-After 头,客户端忽略只显示静态"稍后再试",按钮立即重启用,再点直奔下一个 429(8 次/5 分易触发)。
**文件:** `web/app/[slug]/password-gate.tsx:75-78` → 读 Retry-After/retry_after 显示本地化倒计时并禁用提交直到窗口过去。

#### M31. 空白密码被客户端守卫接受并浪费一次限流尝试 `[定点]`
提交守卫与禁用检查只测真值,' '(空格)通过,触发 POST + bcrypt 校验消耗 8/5min 之一(移动端粘贴/自动更正常带前导空格)。
**文件:** `web/app/[slug]/password-gate.tsx:64,144` → 守卫用 `password.trim().length`,空白时本地拦截不发网络。

#### M32. 通用错误吞掉服务器 500 与网络失败的区别 `[定点]`
route 可返回 500 'verify_failed',客户端任何非 429 非 ok 落到"密码不匹配"——DB 故障时正确密码用户被告知密码错,可能误烧尝试。
**文件:** `password-gate.tsx:80-95`;`route.ts:66-68` → 按状态分支:仅 200 ok:false 显"密码不正确",4xx/5xx 显"服务暂时不可用"。

#### M33. 成功后就地解锁但 feed/poll 为空且无加载态 `[定点]`
成功后换 `EventClient initialComments={[]} initialPoll={null}`,首轮轮询前显示空 Activity/无投票,可见"先空后弹"。
**文件:** `password-gate.tsx:50-60` → feed/poll 区显示加载态,或密码端点返回种子数据。

### 数据模型一致性

#### M34. 容量仅对新 going RSVP 强制,going 改 maybe/not_going 或下调容量时不调和 `[定点]`
无自动晋升 waitlist(主办须手动);主办下调容量低于当前 going 数无任何守卫,活动超额无 UI 提示无 waitlisting。
**文件:** `actions.ts:118`;`[id]/page.tsx:134` → going→maybe/not_going 时 surface/自动晋升;下调容量低于占用时警告/阻止;至少显示"超额 X"。

#### M35. Add-to-Calendar 用旧/TBD/锁定层数据且无重同步;对未 gate 的 cancelled 也渲染 `[定点]`
锁定观看者的日历 LOCATION 仅城市,RSVP 前加入日历捕获城市非地址且无重加提示;改期无版本/重同步;cancelled 活动也照加。
**文件:** `add-to-calendar.tsx:24`;`event-view.tsx:95` → 解锁后提示"地址已更新,重新加入日历";cancelled/ended 抑制日历;.ics 含 UID 使重下更新而非重复。

### UX(其他)

#### M36. 公开页地图链接仅在有 location_url 时出现,纯文本地址无地图回退 `[定点]`
只填文本地址(常见)的访客拿到地址却无法导航。中文受众更明显:期望"高德/百度地图"而非主办粘贴的 Google Maps URL。
**文件:** `web/app/[slug]/event-view.tsx:103-116` → 无 location_url 但有 location_text 时合成地图搜索链接(中文地图提供商)。

#### M37. chip-in 区无支付上下文且打开任意外链 `[定点]`
中文用户的 chip-in 自然是微信/支付宝(常为二维码非链接),裸 target=_blank 外链既反习惯又有轻微信任/安全顾虑,无金额/币种提示。
**文件:** `web/app/[slug]/event-view.tsx:136-149` → 支持二维码/图片 chip-in 并本地化;标注目标 host。

#### M38. 日期投票候选未排序;Lock in/Remove 破坏性操作无确认 `[定点]`
公开与 host 侧均按返回顺序渲染(非时间序);"Lock in" 不可逆 finalize、"Remove" 静默丢弃带票候选,均单击即生效无确认。误点为所有访客锁定错误日期。
**文件:** `date-poll.tsx:122`、`date-poll-manager.tsx:63,140-165` → 按 starts_at 排序;finalize 与删带票候选加确认/撤销窗口。

#### M39. 公开访客列表完全省略 Can't-Go/Waitlist 且无总数 `[定点]`
设计只显示 Going/Maybe(隐私正确),但 waitlist 访客无任何确认其处境的界面,主办在公开页也无 waitlist 信号;"No replies yet" 空态在全员婉拒时误导。
**文件:** `web/components/events/guest-list.tsx:50-73` → 加聚合 waitlist/婉拒计数行(仅数字保隐私);空态区分"无响应"与"无人参加"。

#### M40. settings 页缺登出与账号级操作 `[定点]`
dashboard 头有 Settings 与 Sign out,settings 页头只有 "Back to events"。用户自然在 Settings 找账号操作(登出、改邮箱、删账号),全无。
**文件:** `web/app/dashboard/settings/page.tsx:24-29` → 加 Account 区:显示已登录邮箱、登出、删账号流程。

#### M41. 主办人页无分享/复制链接(整页存在意义就是被分享) `[定点]`
`/u/[username]` 是主办发放的虚荣 URL 却无任何复制/分享按钮。
**文件:** `web/app/u/[username]/page.tsx:71-101` → handle 旁加复制/分享按钮 + "已复制" 提示。

#### M42. 主办人页过期活动可 RSVP 且仅以 opacity-80 区分 `[定点]`
过期活动在 Past 区仅 80% 透明,仍链向 /[slug] 如 live 活动,无 "已结束" 徽章。
**文件:** `web/app/u/[username]/page.tsx:98,139-166` → 过期卡加显式 "已结束" 徽章,不仅靠 opacity。

#### M43. 主办人页空态无法区分"存在但无公开活动"与"handle 不存在" `[定点]`
按 D2(无存在性 oracle)未知 username 与无活动主办渲染相同屏,但会为任意输入造出自信的 monogram+H1。安全选择正确但 UX 后果未处理。
**文件:** `web/app/u/[username]/page.tsx:87-94` → 保持不泄露行为但软化文案;零活动时不渲染自信 monogram/H1。

#### M44. 主办人页/settings 无错误态,失败塌缩为空态 `[定点]`
见 H20(已合并);此处为同一系统性问题的 organizer surface 实例。

#### M45. 用户名可用性 hint/成功提示状态陈旧致误导 `[定点]`
保存后再编辑 username,绿色 "Saved." 仍与新未保存输入并存,暗示已保存;Save 按钮不在 invalid/taken 时禁用,允许已知必败的提交。
**文件:** `profile-form.tsx:126-144,127-133` → 编辑任意字段后清除提示;hint.kind 为 invalid/taken/checking 时禁用 Save。

#### M46. Google 登录无"发送中"反馈;未配置时留静默禁用按钮 `[定点]`
魔法链接按钮会变 "One sec…",Google 按钮标签不变仅 opacity 变暗;若 OAuth 未配置 `signInWithOAuth` 可能不重定向,用户盯着暗按钮无 spinner 无信息。
**文件:** `web/components/auth/login-form.tsx:34-43,98-105` → Google 按钮加 loading 标签/spinner;未配置/无重定向时明确提示。

#### M47. landing 缺次级入口(样例活动/工作原理/访客入口) `[定点]`
只有单一 "Start hosting" CTA。缺:预览邀请样例建立主办信心、how-it-works、访客落到 '/' 的去向/说明。页面假设每个访客都是潜在主办。
**文件:** `web/app/page.tsx:30-38` → 加"查看样例邀请"次级链接 + how-it-works + 访客导向行。

#### M48. landing SEO 元数据极简(无 OG/Twitter/canonical/locale) `[定点]`
只有 title+description。对以"分享一个链接"为核心的产品,缺 openGraph/twitter/metadataBase/og:locale 意味着分享链接预览为裸卡。og:locale 应为 zh_CN。
**文件:** `web/app/layout.tsx:24-28` → 加 openGraph+twitter+metadataBase+og:locale='zh_CN' 与品牌默认分享图。

#### M49. magic-link 重定向用 window.location.origin,代理/自定义域下失效 `[定点]`
`callbackUrl()` 用 `window.location.origin` 构建重定向,预览部署/CDN/www-vs-apex 下指向非允许列表 origin,Supabase 静默失败。
**文件:** `web/components/auth/login-form.tsx:18-21` → 用 NEXT_PUBLIC_SITE_URL 派生,dev 才回退 origin;确保在 Supabase 允许列表。

#### M50. 同一活动多评论流/投票后台轮询可覆盖进行中状态 `[定点]`
DatePoll 每 15s 收新 poll prop;早期 race 下 SSR/空种子的 my_option_ids 可瞬时清空用户已记录选择;'Saved.' 可被后台重种静默失效。
**文件:** `web/components/events/date-poll.tsx:55-61,108-110,168`;`event-client.tsx:81-86` → 仅在有 token 后才喂 token-bearing 快照,'Saved.' gate 在不可被后台重种推翻的保存成功标志上。

#### M51. 评论/投票错误为死胡同无重试;失败轮询静默冻结 `[定点]`
fetchComments/fetchSnapshot 失败返回 null 保留旧内容,但 offline/匿名读 429 时 feed 静默陈旧无信号;未 RSVP 匿名读用严格 event_read 配额,15s 轮询易被限流。
**文件:** `comments-feed.tsx:256-269`;`comments/route.ts:43-48`;`event-client.tsx:212-231` → 追踪连续失败显示"更新已暂停 — 重试";重审对匿名读 feed 用严格配额。

#### M52. 日期投票候选未排序(重复条目,见 M38)`[定点]`
已并入 M38。

---

## ⚪ Low — 打磨

> 以下为低优先打磨项,按主题归并;均 `[定点]` 除非标注。

### 品牌残留(非用户可见 / 标识符) `[系统性,谨慎]`
- **L1.** localStorage key `partiful:rsvp:`(`rsvp-storage.ts:27`)——存 guest_token 凭证。**建议保持不变**(不可见,改名会让所有回访客丢 token);若必须改,在 loadRsvpRecord 加旧 key 回退迁移。
- **L2.** ICS `PRODID:-//Partiful Clone//`(`calendar.ts:124`)可自由改为 JU;UID 后缀 `@partiful-clone`(:52)是稳定标识,改动致日历重复条目——建议保留或一次性改并接受重复成本。
- **L3.** 保留用户名集含 "partiful"(`username.ts:24`)——**添加** "ju" 防抢注,"partiful" 保留防冒充。
- **L4.** 设计 token/源码注释引用 Partiful(`globals.css:4,5,21,49-57`;`dashboard/page.tsx:13`;`wordmark.tsx:4`)——仅文档,无功能/UX 风险,编辑相关文件时顺手更新即可。
- **L5.** favicon 为通用图标,无 JU mark、无 manifest/OG image/PWA icons;public 仅默认 Next SVG(`web/app/favicon.ico`)——加 JU favicon/app icons/默认 OG 图。
- **L6.** OG `SITE_NAME='Partiful'` 与 `DEFAULT_DESCRIPTION` 英文(`og.ts:22,28`)——已在 B3b/M4 系统性覆盖品牌+翻译。

### i18n 杂项 `[系统性]`
- **L7.** sr-only/aria-label 为英文(rsvp-form/date-poll/comments-feed/各 loading.tsx/theme 色名)——随 catalog 翻译。
- **L8.** 主题色/effect 下拉 .label 英文(`theme.ts:21-47`)——翻译 label,key 保持不变。
- **L9.** OG `DEFAULT_DESCRIPTION` / icsFilename 假设 ASCII(`og.ts:28`)——已并入 M2/M4。
- **L10.** 手打弯引号 + emoji 散落(`rsvp-form.tsx`),信号文案内联未集中——i18n 时统一入 strings 模块,刻意决定 emoji。
- **L11.** 用户名正则禁非 ASCII(`username.ts:35`),中文受众或期望中文/拼音 handle——产品决策:是否支持 Unicode handle(NFC),或文档说明 ASCII-only + 拼音引导。

### 无障碍打磨 `[系统性]`
- **L12.** prefers-reduced-motion 规则全局 `*{transition:0.001ms}` 误杀 CTA hover 等有用反馈(`globals.css:86-89`)——仅抑制 transform/opacity 动画,保留 color/brightness。
- **L13.** 字标在自身页面自链接(`page.tsx:22`)——home 上渲染为纯文本或 aria-current。
- **L14.** 无 skip-link / landmark 结构;公开页/landing 缺 `<main>`/`<header>`(`page.tsx:16-22`、`[slug]/page.tsx`、`event-view.tsx`)——包语义 landmark + skip link。
- **L15.** 封面图为 CSS background-image,无 alt(`event-view.tsx:180-191`、`u/[username]:148-159`、`cover-uploader.tsx:61-76`、`password-gate.tsx:110-115`)——用 `<img>`/Next Image 带 alt(并修 background-image url() 未 CSS 转义的 L18)。
- **L16.** login 页无 h1(`login/page.tsx:23-47`);host-detail 访客分组用 `<p>` 非真标题破坏大纲(`[id]/page.tsx:182-185`)——加 h1 / 用真标题。
- **L17.** focus:outline-none 依赖未分层全局 focus-visible 规则取胜级联,脆弱(多输入)——删 outline-none 或改 focus-visible:outline-none + 自含 ring。
- **L18.** hero backgroundImage 经 JSON.stringify 注入未 CSS 转义,URL 含引号/括号可破坏/注入(`event-view.tsx:181-185`)——改 `<img>` 或 CSS.escape/允许列表。
- **L19.** password-gate 输入无 autoFocus、无 show-password/caps-lock、无 reduced-motion 守卫(`password-gate.tsx:126,130,146`)——加 autoFocus、显示密码切换、motion-safe。
- **L20.** monogram 深 ink 字在 coral→iris 渐变 iris 端对比临界(`u/[username]:74-78`)——用 paper 字或限制渐变范围。

### 其他 UX 打磨
- **L21.** 问候回退到 email 前缀或字面 "host"(`dashboard/page.tsx:33`)——优先 username,本地化回退或省略。
- **L22.** Past 区无分页/归档,历史无限堆积(`dashboard/page.tsx:94`)——分页/限制 + "查看全部"归档路由 + 过滤/搜索。
- **L23.** groupEventsByTime 对未定/TBD 排序不稳定无次级键(`feed.ts:89`)——加 created_at desc/title 次级排序键。
- **L24.** 参与者卡片状态徽章排除访客,隐藏取消/私密细微差别(`dashboard/page.tsx:147`)——在参与者卡片也 surface cancelled/ended。
- **L25.** 容量下调低于已确认 going 数无 UI 警告(`event-form.tsx:272-286`)——编辑时容量字段旁显示当前 going 数并警告。
- **L26.** "Saved."/"Posted." 短暂文本无持久/无突出/不自动消失(`event-form.tsx:439-443`、`comments-feed.tsx:217`、`date-poll.tsx:168`)——改简短持久 toast 并滚入视图/自动消失。
- **L27.** 评论 composer maxLength=2000 无计数器/近限警告(`comments-feed.tsx:194-211`)——显示实时剩余字数并自适应高度。
- **L28.** 活动流无分页/虚拟化,每 15s 重渲整列,新评论在底部需滚动(`comments-feed.tsx:80-98,151-185`)——分页 + 锚定新消息。
- **L29.** 评论提交在确认重读成功前清空文本框(`comments-feed.tsx:134-139`)——乐观追加 POST 返回的评论而非依赖重读。
- **L30.** 缓存 localStorage 记录驱动预填,可覆盖更新的跨设备编辑(last-write-wins)(`rsvp-storage.ts:11`)——可变字段从服务端读自身当前行预填,缓存仅 token + 离线回退。
- **L31.** 提交进行中输入仍可编辑,确认可反映陈旧值(`rsvp-form.tsx:176,269`)——busy 时禁用 fieldset。
- **L32.** contact 字段无格式校验/无 inputMode/autoComplete=off 阻止填充(`rsvp-form.tsx:248`)——加 inputMode/宽松 autoComplete + 软校验。
- **L33.** "go home"/品牌逃生仅在父页脚(错误品牌)(`password-gate.tsx`)——gate 卡片内/下提供 JU home 链接。
- **L34.** window.location.reload() 回退丢弃已输入态可能循环(`password-gate.tsx:88-90`)——显示可恢复错误而非盲目 reload。
- **L35.** password 字段无 maxLength/无 zod 边界校验(bcrypt 72 字节截断)(`password-gate.tsx:126`、`password/route.ts:49-62`)——加 maxLength + 客户端与 route zod 校验。
- **L36.** guest-enter 进场动画对已显示项每次轮询重放;GuestList 用 index key 不稳定(`guest-list.tsx:104-105`)——仅对新项应用动画,用服务端稳定 id 作 key。
- **L37.** Promote 成功静默无 toast/无焦点管理(`promote-button.tsx:31-35`)——显示瞬时成功 + 晋升后移焦点。
- **L38.** 婉拒("Can't go")访客与主列表等权重混排(`[id]/page.tsx:123-130`)——弱化/折叠婉拒组,空态/标题计数仅基于参与者。
- **L39.** guest_approval_enabled 无 host UI(`[id]/page.tsx:45-63`)——approval 开启时 surface 待审队列或至少提示。
- **L40.** 日期投票无总响应人数上下文,票数不可解读(`date-poll.tsx:121-148`)——显示总响应数/比例条/标记领先。
- **L41.** 公开日期投票无空候选引导;finalize 后陈旧投票窗口(`date-poll.ts:59-61`、`event-client.tsx:169-180`)——TBD 无候选显示"日期待定";投票被 finalize 拒绝后立即刷新快照。
- **L42.** 无法删除/编辑自己的评论或投票;无 clear-vote(`comments-feed.tsx:155-185`、`date-poll.tsx:63-105`)——加自评论删除 + host 审核 + 显式撤票。
- **L43.** +1 徽章/分组人头无可访问文本(`guest-list.tsx:96-115`)——加 aria-label。
- **L44.** Hero 不显示 ends_at;"going" 计数缺名词(`event-view.tsx:74-92,206-208`)——有 ends_at 时显示起止区间;"N 人参加"。
- **L45.** 单 CTA 移动端非全宽(`page.tsx:30-37`)——CTA 加 `w-full sm:w-auto`。
- **L46.** Home 对已登录主办重定向无加载态;公开页每次命中付 auth 往返(`page.tsx:9-13`)——中间件处理或加 root loading.tsx。
- **L47.** Hero 重复"no app"且"访客不登录"在两屏重复 3 次(`page.tsx:38`)——精简措辞。
- **L48.** "One sec…" 非正式且无 aria-busy(`login-form.tsx:88`)——用中性本地化"发送中…" + aria-busy。
- **L49.** "Open it on this device" 对 PKCE 误导且 error 页只归因过期(`login-form.tsx:51-52`、`auth-code-error/page.tsx:11-13`)——强调同浏览器要求 + error 页加"不同浏览器?"解释。
- **L50.** auth-code-error 仅 "Back to sign in" 丢失原 next 目标(`callback/route.ts:44`、`auth-code-error/page.tsx:15-16`)——转发净化后的 next。
- **L51.** 登录屏无条款/隐私披露(`login/page.tsx:31-45`)——auth 按钮下加本地化条款/隐私链接(中国市场常需)。
- **L52.** 用户名可用性端点可被已登录用户枚举已用 handle(`api/username-check/route.ts:16-45`)——加每用户/IP 服务端限流(已有 rate_limits 表)。
- **L53.** 用户名输入缺 inputMode;iOS 可能首字母大写显示与保存不一致(`profile-form.tsx:109-121`)——onChange 即小写 + inputMode。
- **L54.** settings helper 引用 /u/<username> 但无链接/复制(`settings/page.tsx:35-37`)——username 已设时渲染解析后 URL + 复制按钮。
- **L55.** 无"无更改"守卫,空提交仍写库+revalidate(`settings/actions.ts:52-66`)——追踪 dirty 态禁用 Save 或短路 action。
- **L56.** 主办人页 fetched description/event count 未用(`u/[username]:160-166`)——card 加 1 行描述截断 + "共 N 场公开活动"。
- **L57.** loading skeleton 与真实分节布局不符致重排(`u/[username]/loading.tsx:26-30`)——加分节标题占位。
- **L58.** 头部 nav 无响应式处理,窄屏拥挤(`dashboard/page.tsx:42`)——320px 验证;次级 nav 折叠为菜单。
- **L59.** 复制成功仅瞬时 timeout 反馈,SR 不可靠确认(`copy-link-button.tsx:27`)——配 status live-region(并入 M12)。
- **L60.** 返回主办无更显眼"创建下一个"CTA(`dashboard/page.tsx:93`)——upcoming 空态加明确 CTA 并本地化。
- **L61.** 两并排提交按钮窄屏拥挤,长表单无 sticky 保存条(`event-form.tsx:420-449`)——移动端 sticky 底部动作条。
- **L62.** 封面预览为 background-image 无文本替代(并入 L15)。
- **L63.** 数据模型 deferred 占位表/列(event_photos、reactions、questions/answers、reminders、broadcasts;anonymize_guest_list 等)——确认刻意 deferred,**绝不上线无写路径的 host 表单开关**(避免无效复选框);为年轻社交受众优先排期照片相册/reactions。
- **L64.** anonymize_guest_list 列存在但访客列表总显真名,开关无效(`guest-list.tsx:107`)——实现匿名化或明确文档为 MVP 外,避免暗示未兑现的隐私承诺。
- **L65.** plus_ones max 在禁用 plus-ones 时静默丢失(`schema.ts:152-158`)——禁用时保留最后值,或字段始终可编辑由复选框仅 gate 强制。

---

## 修复策略建议

**作为三大系统性扫除一次性完成(覆盖约 60% 条目):**
1. **i18n 扫除** [B1, B2, H2, M1–M6, L7–L11 及所有 per-surface 翻译]:先定纯中文/双语;字体先行(B2);抽取含 lib/ 与 api/ 的所有字符串;`html lang="zh-CN"`;Intl locale 改 zh-CN。
2. **品牌替换扫除** [B3, B3b, M4(siteName), L1–L6]:改 Wordmark 组件 + 3 处内联 + title + OG siteName + ICS PRODID;标识符(localStorage/UID)谨慎保留或带迁移。
3. **a11y 扫除** [M7–M12, L12–L20, L43, L59]:radio 键盘契约、aria-live 直播区、错误关联+焦点管理、颜色对比 token、封面改 `<img>`+alt、触控目标。

**关键定点修复(上线前必做):** B4(取消流程)、H1(时区)、H3–H8(生命周期)、H14–H16(解锁/认回)、H19–H20(数据丢失/静默错误)、H21(auth 回调)。