# TEST-SPEC.md — 安全门禁测试断言清单(v2)

> 给**独立测试 agent**的对抗性测试规格。每个 [SECURITY] 任务对应一节。
> 以"假设实现有漏洞"的怀疑心态写,逐条覆盖,并可补更狠的边界用例。
> **任一断言不通过 → 编排器不打勾**,失败断言记入 BLOCKERS.md。
> Vitest,对**本地 supabase 测试 DB**(0.6,连接串/会话来自全局 setup)。anon 用 anon key;host 用 admin 建的会话;受信用 service 角色。

## §1.3 — RLS host 隔离 + 正向自读 + 🟡 表 + Storage
- host A 用自己会话查 host B 的 events/guests/rsvps → **断言返回空/被拒**。
- host A 不能 UPDATE/DELETE host B 的 events 行 → **断言被拒**。
- 未登录 anon 查任意 host 的 dashboard 类数据 → **断言被拒**。
- **正向(D9)**:host 在自己会话里 `insert events` 后**立刻 SELECT 回自己那行 → 断言 1 行**(防自锁);触发器已写 event_hosts owner 行。
- **正向 host 自读客数据表(M1)**:owner host 用自己会话**直接 SELECT 自己活动的 guests(含 contact)/rsvps → 断言可读、含 contact**;非 owner host / anon 对同一行 → **断言空/被拒**(host 经 `to authenticated` 所有权策略读;anon 无策略)。
- **🟡 表参数化 deny(D8)**:对 comment_reactions/event_photos/questions/answers/scheduled_reminders/broadcasts **循环**断言 anon + 带 token 的 anon **SELECT 空 / 写被拒**。
- **answers host-isolation(单独)**:owner host 可读自己活动的 answers;非 owner host / anon / guest **断言空**。
- **Storage**:非 host 用户上传到 `event-covers/<别人event>/` → **断言被拒**;超 `file_size_limit` / 非允许 mime → **断言被拒**;`event-photos`(私有)anon 公开读 → **断言不可读**。

## §1.4 — anon 读写收敛 + contact 不泄露(G1)
- anon 直接 `select * from events where slug=eq.X`(经 anon key,**含 public+published**)→ **断言空/被拒**(读全经 RPC)。
- anon 直接 SELECT guests/rsvps/comments/date_votes/answers → **断言空/被拒**。
- anon 直接 INSERT/UPDATE/DELETE 上述任一表 → **断言被拒**(写全经 RPC)。
- anon 经 `get_event_by_slug` 读一个 public+published 活动 → **断言可读第一类、断言不含 location_text/location_url**。
- 任意 anon 可达路径取到的 guests 数据 → **断言不含 contact 字段**。

## §1.5(helper)— guest_unlock_status 单测(D5)
- token 命中且 status='going' → **unlocked=true**;status='maybe'/'waitlisted' → **true**;status='not_going' → **false**。
- 已登录、guests.user_id=auth.uid() 命中 → **true**(换设备凭账号认回)。
- 用**事件 A 的 token 查事件 B** → **断言未命中(unlocked=false)**(event_id scope)。
- 无 token 无登录 → **false**。

## §1.5a — get_event_by_slug(分级 / 私密 / 密码)
- **无 token / 伪造 token / 跨活动 token** 调用 → **断言不含 location_text、不含名单**(伪造/跨活动不得解锁)。
- **带有效已解锁 token** → **断言含 location_text 与名单入口**。
- **anon 用 anon key 直调一个 private slug 的 get_event_by_slug → 断言被拒(函数自身返回 null)**(D3,**不是靠 SSR 不去调**)。
- **service_role 调 private slug → 断言可读**(SSR 路径)。
- **hide_guest_count=true 或 private 未解锁** → **断言返回体不含 going_count/capacity_remaining 键**(省略而非置0,D7②)。
- **密码**:活动设了 view_password_hash,无正确密码/无凭证 → **断言只得最小锁定响应(title/cover),不含第二类**;持正确密码/凭证 → 正常分级。

## §1.5b — submit_rsvp(容量 / 去重 / 限流)
- capacity=N,串行灌 N 个 going 后再 submit going → **断言 status='waitlisted'**;未满 → **'going'**。
- **并发(D7①)**:capacity=N,**并行**发 N+5 个 submit going → **断言恰好 N 个 going、其余 waitlisted**(无超卖)。
- 同一 guest_token 二次 submit(改状态)→ **断言更新原 guest/rsvp,不新建**(guests 行数不增)。
- 已登录用户换设备(无 token、但同 user_id)二次 submit → **断言更新既有(凭 user_id),不新建**。
- **裸 contact(无 token、无登录,contact 与既有 guest 相同)→ 断言新建独立行;断言不改既有行;断言返回体不含既有 guest 的 token**(D1,反向钉死劫持)。
- submit 成功 → **断言返回体含本人 token + 确认态**。
- **写侧限流(D14)**:anon 用 anon key 直调 submit_rsvp 超阈值 → **断言被 DB 限**(rate_limits 生效,绕 Next 也拦)。

## §1.5c — get_guest_list
- 返回结果 → **断言不含 contact、不含 guest_id、不含 token、不含 status='not_going'**;只含 going/maybe。
- hide_guest_list=true → **断言返回空/被拒**。
- 调用者未解锁(无有效 token/未 RSVP)→ **断言不返回名单**。
- **用事件 A 的 token 调事件 B 的 get_guest_list → 断言被拒**(跨活动 scope)。

## §1.5d — add_comment / get_comments(读开放 / 写门禁 / 作者绑定)
- 未 RSVP(无有效 token)调 **get_comments** → **断言可读评论列表**(读开放)。
- 未 RSVP 调 **add_comment** → **断言被拒**。
- 有有效已解锁 token 调 add_comment → **断言成功插入**。
- **作者伪造**:guest 调 add_comment 试图传 guest_id=他人 / host_id=任意 → **断言作者被强制为 token 解析出的 guest_id,host_id 忽略**(不能冒充)。
- **用事件 A 的 token 调事件 B 的 add_comment → 断言被拒**。
- **私密评论**:anon 直接 SELECT comments 原表 / 对 private 活动经无权路径读 → **断言不可读**(私密评论不泄露)。
- **rsvp_enabled=false**:guest 调 add_comment → **断言被拒**(host-only);host 可发。

## §1.5e — vote / finalize / promote / 聚合读
- 非 host 调 finalize_date / promote_guest → **断言被拒**;**以 service-role(无 auth 上下文)调 → 断言被拒**(D7③)。
- host 调 finalize_date → starts_at 写回且 **votes 仍存**;promote_guest → going 且尊重容量。
- vote_dates 多选 upsert;改选集去掉未选项。
- **get_my_events**:用户 X 调 → **断言只返回 X 主办(host_id)+ X 参加(guests.user_id)的活动,不串他人**。
- **get_public_events_by_host**:**断言只含 public+published,不含 private**。

## §2.3.5 — 限流 + 私密收敛 + 密码尝试
- 同一 IP 在窗口内对 slug 读取超阈值 → **断言被限(429)**;阈值内 → **放行**。
- 已 RSVP/受信轮询(更宽松配额)在正常轮询频率下 → **断言不被误限**(D4 对齐)。
- anon 尝试绕过 Next 直连 private 活动的 get_event_by_slug RPC → **断言被拒**。
- anon 直调写 RPC(submit_rsvp/add_comment)超阈值 → **断言被 DB 限**(rate_limits,绕 Next 也拦)。
- **密码尝试**:对同一活动连续错误密码超阈值 → **断言被限**(防爆破/bcrypt-DoS)。

## §2.4 — 公开活动页 + RSVP(端到端语义)
- **结构断言**:未解锁时 get_event_by_slug 返回对象 → **断言无 `location_text` 键**(而非对 HTML grep 地址串)。
- **sentinel**:seed 的 location_text 设唯一 sentinel 串;未RSVP 加载 /{slug} SSR 响应体 → **断言不含该 sentinel**;完成 RSVP 后 → **断言含**。
- submit 在容量满 → **断言页面显示 waitlist 且记录 waitlisted**。
- 页面任何**可分享处(URL / 初始 SSR HTML)** → **断言不出现 guest_token**(token 仅在 RPC 返回值/localStorage,合法)。
- anon 直连 private 活动 RPC(绕过 SSR)→ **断言被拒**。

## §3.1 — 公开页名单呈现
- get_guest_list 渲染数据 → **断言无 Can't Go、无 contact、无 guest_id/token**。
- 未解锁访客视角 → **断言名单不可见**。
- hide_guest_count=true → **断言人数不显示**(且 RPC 返回体无 count 键)。
- 名单靠轮询更新,**断言客户端不订阅/不直 SELECT guests 原表**。

## §4.1 — 评论读开放 / 写门禁
- 未 RSVP 访客 → **断言可读评论列表(经 get_comments)**。
- 未 RSVP 访客发评论 → **断言被拒**并提示先 RSVP。
- 已解锁(有 token)发评论 → **断言成功并(下次轮询)出现**。
- rsvp_enabled=false 活动 → **断言 guest 无发布入口、add_comment 被拒;host 可发**。

## §6.2 — OG meta 不泄露
- 私密/密码活动的 OG 输出 → **断言含 title/cover/description,不含 location_text**。
