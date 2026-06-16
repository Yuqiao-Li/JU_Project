# SCHEMA.md — Partiful Clone 数据库全貌(定稿设计 v2)

> 本文件是数据模型 + 安全的单一事实来源,反映所有已锁定的设计决策(含复核决议 D1–D16 / G1–G8)。
> 标记说明:🟢 MVP 做全 · 🟡 表/列建好但逻辑或 UI 留白 · 🔴 暂不建(此处不出现)
> 原则(C 路线):**数据模型与安全从第一天做对;功能可延后,表结构不将就。**

## 安全模型总纲(读这几条再读细节)

1. **单一读路径**:guest 侧**一切读都经 SECURITY DEFINER RPC**(分级在 RPC 内一处强制)。
   **anon 对 events / guests / rsvps / comments / date_votes / answers 等"客数据表"无直接 SELECT/写**——只经 DEFINER RPC 到达;**host(authenticated,经 events.host_id 所有权策略)**直接读自己活动的数据(dashboard)。迁移侧**不给 anon 任何策略/`GRANT`**,RLS deny。这是私密收敛与地址分级的**物理保证**,由护栏 DB 权威校验断言(G1:客数据表无 anon 策略、无 `using(true)`)。
2. **单一写路径**:guest 侧一切写经 SECURITY DEFINER RPC,函数自校验输入。
3. **私密活动**:`get_event_by_slug` 内 `visibility='private' 且 auth.role()<>'service_role' → 返回 null`;私密只经 Next SSR 受信角色读(D3)。
4. **身份**:host 走账号(`auth.uid()`);guest 走 `guest_token`(localStorage);登录用户 RSVP 时顺手关联 `guests.user_id=auth.uid()`。**`contact` 永远只是 host 可见的联系方式,绝不参与写/身份判定**(D1)。
5. **MVP 不接 Realtime**:名单/评论/投票靠轮询经分级 RPC 重取(D4)。

---

## 表清单总览

| 表 | 档位 | 作用 |
|---|---|---|
| `profiles` | 🟢 | host 账号信息(+ username 用于 Organizer Profile) |
| `events` | 🟢 | 活动核心实体(含多个 🟡 留白列) |
| `event_hosts` | 🟡 | co-host 关联表(MVP 由触发器写创建者一行,RLS 不依赖它) |
| `guests` | 🟢 | 无账号访客(guest_token 身份;可选 user_id 关联账号) |
| `rsvps` | 🟢 | 回复(Going/Maybe/Can't Go/Waitlisted) |
| `comments` | 🟢 | Activity Feed 评论(MVP 纯文本) |
| `comment_reactions` | 🟡 | 评论 emoji 反应(表建好,UI 留白) |
| `event_photos` | 🟡 | Photo Album(表建好,上传 UI 留白) |
| `date_options` | 🟢 | 日期投票候选 |
| `date_votes` | 🟢 | 日期投票记录 |
| `questions` | 🟡 | 问卷题目(表建好,UI 留白) |
| `answers` | 🟡 | 问卷答案(表建好,UI 留白;仅 host 可读) |
| `scheduled_reminders` | 🟡 | 自动提醒队列(表建好,调度/发送留白) |
| `broadcasts` | 🟡 | Text Blast 群发记录(表建好,渠道留白) |
| `rate_limits` | 🟢 | **写侧 DB 纵深限流计数(D14/G7)**;仅 SECURITY DEFINER RPC 内部访问(owner 绕 RLS);**RLS 启用 + 显式 deny 策略 `to authenticated using(false)`**(满足护栏"每表有策略",M3) |

---

## 1. profiles 🟢

host 账号镜像(对应 Supabase auth.users)。

| 列 | 类型 | 档位 | 说明 |
|---|---|---|---|
| id | uuid PK = auth.users.id | 🟢 | |
| display_name | text | 🟢 | |
| avatar_url | text | 🟢 | |
| **username** | text unique nullable | 🟢 | Organizer Profile 的 `/u/[username]`;**唯一性由 DB 唯一索引强制**(UI 查仅提示) |
| created_at | timestamptz | 🟢 | |

> **建档(D7④)**:由 `auth.users` 的 **AFTER INSERT 触发器**在注册时创建 profiles 行(`id = new.id`),**client 永不传 id**。RLS:`using(id=auth.uid()) with check(id=auth.uid())`,仅本人 CRUD 自己那行。

## 2. events 🟢(核心,含最多留白列)

| 列 | 类型 | 档位 | 说明 |
|---|---|---|---|
| id | uuid PK | 🟢 | |
| host_id | uuid → profiles | 🟢 | 创建者;**RLS 权威键**(D9) |
| slug | text unique | 🟢 | **人类可读段 + 10 位密码学随机后缀**(硬安全要求,见下) |
| title | text | 🟢 | |
| description | text | 🟢 | |
| cover_image_url | text | 🟢 | 上传到 Storage `event-covers` 桶(D16) |
| theme | jsonb | 🟢 | 主题配置 |
| effect | text | 🟢 | 特效(MVP 少量预设) |
| starts_at | timestamptz nullable | 🟢 | 待定时为空 |
| ends_at | timestamptz nullable | 🟢 | |
| date_tbd | boolean | 🟢 | true=待定+走 date_options 投票 |
| location_text | text nullable | 🟢 | **完整地址,第二类(RSVP 后才返回)** |
| location_url | text nullable | 🟢 | 可选地图/场地链接,**第二类** |
| location_city | text nullable | 🟢 | **城市级,第一类(未RSVP可见)** |
| **lat** | double nullable | 🟡 | 预留,MVP 永远空 |
| **lng** | double nullable | 🟡 | 同上 |
| visibility | text check(public/private) | 🟢 | private = link-private + DB 角色闸(D3) |
| **view_password_hash** | text nullable | 🟢 | **密码保护已实现(D7⑤)**:bcrypt(`crypt`/`gen_salt('bf',12)`) |
| capacity | int nullable | 🟢 | 容量上限 |
| allow_plus_ones | boolean | 🟢 | |
| max_plus_ones | int default 1 | 🟢 | 每人 +N 上限 |
| rsvp_enabled | boolean default true | 🟢 | 关了只发信息不收回复(评论降级 host-only,D6) |
| hide_guest_list | boolean | 🟢 | 隐藏名单 |
| hide_guest_count | boolean | 🟢 | 隐藏人数(隐藏时 count 字段**从返回体省略**,D7②) |
| hide_feed_timestamps | boolean | 🟢 | 隐藏 feed 时间戳(纯渲染) |
| **anonymize_guest_list** | boolean | 🟡 | 匿名名单,渲染逻辑留白 |
| **allow_photo_upload** | boolean | 🟡 | 相册开关,配合 event_photos + `event-photos` 桶 |
| **guest_approval_enabled** | boolean default false | 🟡 | 审核开关,配合 rsvps.approval_status |
| **chip_in_url** | text nullable | 🟢 | AA 收款链接(纯展示) |
| **chip_in_note** | text nullable | 🟢 | 收款说明 |
| status | text check(draft/published/cancelled) | 🟢 | |
| created_at / updated_at | timestamptz | 🟢 | updated_at 触发器 |

## 3. event_hosts 🟡(co-host 留白)

> **D9**:RLS **不依赖**此表;events 权威键是 `host_id=auth.uid()`。
> 此表 owner 行由 events 的 **AFTER INSERT 触发器**顺手写入(为未来 co-host 备数据)。
> 未来 co-host = 往表里加行 + 放宽 events 策略(用 host_id 集合或 SECURITY DEFINER helper,**不反向 join events 避免 RLS 递归**)。

| 列 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| event_id | uuid → events | |
| user_id | uuid → profiles | |
| role | text check(owner/cohost) default 'owner' | MVP 只有 owner |
| created_at | timestamptz | |
| | unique(event_id, user_id) | |

## 4. guests 🟢

无账号访客。**身份凭证是 guest_token**;登录用户 RSVP 时顺手填 `user_id`。

| 列 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| event_id | uuid → events | |
| guest_token | uuid unique default gen_random_uuid() | localStorage 保存,身份凭证 |
| **user_id** | uuid → profiles **nullable** | **D1**:调用者已登录时由 submit_rsvp **服务端**写 `auth.uid()`,client 不可传;用于跨设备认回 + "我参加的局" |
| display_name | text not null | |
| contact | text nullable | 邮箱/手机,**仅 host 可见**;可选;**永不参与写/身份判定**(D1) |
| created_at | timestamptz | |

> **去重逻辑(D1,写在 submit_rsvp RPC)**:**token 命中 → 更新该 guest;否则(调用者已登录且本活动已有 `user_id=auth.uid()` 行)→ 更新该行;否则新建**。
> **`contact` 不再参与去重/身份**。无 token 的 contact 碰撞**一律新建独立行,绝不静默合并、绝不回带既有 token**。名单去重留给 host 侧(已认证)后期功能。

## 5. rsvps 🟢

| 列 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| event_id | uuid → events | |
| guest_id | uuid → guests | |
| status | text check(going/maybe/not_going/waitlisted) | |
| plus_ones | int default 0 check >=0 | |
| **approval_status** | text check(pending/approved/rejected) default 'approved' | 🟡 MVP 永远 approved |
| created_at / updated_at | timestamptz | |
| | unique(event_id, guest_id) | |

> **容量逻辑(submit_rsvp,D7①)**:函数开头 `pg_advisory_xact_lock(hashtext(event_id::text))`(或对 events 行 `FOR UPDATE`),**锁内**统计 `going` 的 `1+plus_ones` 占用;`>= capacity` 时新 RSVP 落 `waitlisted`。锁保证并发不超卖。

## 6. comments 🟢(Activity Feed,MVP 纯文本)

| 列 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| event_id | uuid → events | |
| guest_id | uuid → guests nullable | guest 评论时填,**取自验证后的 token,不接受 client 传**(D6) |
| host_id | uuid → profiles nullable | host 评论时填,**取自 auth.uid()**(D6) |
| body | text | |
| gif_url | text nullable | **MVP 不开 UI、add_comment 不写**(D6;砍 GIF 移除 XSS 面);列保留,将来加回须 https+域名白名单 |
| created_at | timestamptz | |
| | check: guest_id/host_id 恰有一个非空 | |

## 7. comment_reactions 🟡 / 8. event_photos 🟡(留白)

> 表建好,MVP 不做 UI。RLS:仅 host(经 event 所有权)可 SELECT,anon/guest deny(D8)。
> event_photos 受 events.allow_photo_upload 控制,复用 Storage `event-photos`(私有桶,D16)。

**comment_reactions**:id PK / comment_id → comments / guest_id → guests / emoji text / created_at / unique(comment_id, guest_id, emoji)
**event_photos**:id PK / event_id → events / guest_id → guests nullable / host_id → profiles nullable / image_url text(`event-photos` 桶)/ created_at

## 9. date_options 🟢 / 10. date_votes 🟢(日期投票)

**date_options**:id PK / event_id → events / starts_at / ends_at nullable / created_at
**date_votes**:id PK / date_option_id → date_options / guest_id → guests / created_at / unique(date_option_id, guest_id)

> 敲定日期:写 events.starts_at + date_tbd=false,**投票记录保留不删**。vote_dates 多选 upsert(去掉未选项)。

## 11. questions 🟡 / 12. answers 🟡(问卷留白)

**questions**:id PK / event_id → events / prompt text / type check(text/single/multi/**social**) / options jsonb nullable / required bool / position int
**answers**:id PK / question_id → questions / guest_id → guests / value jsonb / created_at / unique(question_id, guest_id)

> **answers 仅 host 可见(D8)**:正向 host(经 event 所有权)SELECT 策略;**anon/guest 永不可读**(测试断言)。CSV 导出后期加。

## 13. scheduled_reminders 🟡 / 14. broadcasts 🟡(留白)

> 表建好,调度/发送渠道后期接。依赖 guest.contact。RLS:仅 host 可读自己活动的;anon/guest deny。
**scheduled_reminders**:id PK / event_id / guest_id nullable(空=全体)/ remind_at / channel check(email/sms) / status check(pending/sent/failed) default pending / sent_at nullable / created_at
**broadcasts**:id PK / event_id / body / channel check(email/sms) / sent_at nullable / created_at

## 15. rate_limits 🟢(写侧 DB 纵深限流,D14/G7)

> 给写 RPC(submit_rsvp / add_comment / verify_event_password)做"每活动/每标识每窗口"计数上限,**绕开 Next/Upstash 也兜得住**。
> **RLS 启用 + 显式 deny 策略**(`create policy rl_deny on rate_limits for all to authenticated using(false) with check(false)`;anon 无策略)——**既满足护栏"每表必须有非全放行策略",又对所有非 owner 调用者全拒**(M3)。**DEFINER RPC 以 owner 身份绕 RLS** 读写它。纳入护栏每表 RLS 检查(D8/D12b)。

| 列 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| bucket_key | text | 形如 `submit:{event_id}:{ip_or_fingerprint}` |
| window_start | timestamptz | 当前窗口起点 |
| count | int default 0 | 窗口内计数 |
| | unique(bucket_key, window_start) | 原子 upsert + 自增 |

---

## SLUG 生成规格(不可打桩)

- **结构**:`{slugify(title 前40字符)}-{10位 base62 随机段}`,例 `rains-birthday-x7k2m9qpvw`。
- **随机段**:10 位 base62(~60 bits 熵),**必须 `gen_random_bytes()`**;**严禁** `random()` / 时间戳 / 自增派生。
- **纯中文/空标题**:slugify 为空 → 只用纯随机段(不音译)。**private 活动可读前缀不放可推断信息**(D15)。
- **唯一性 + fail-closed(D15)**:`unique` 兜底;冲突 → **重新生成全新随机段重试一次**;**重试仍冲突 → raise(fail closed),绝不退回弱随机源**。
- **URL 边界**:slug 进 URL;**guest_token 永不进 URL**,只在 RPC 返回值 + localStorage。

## 限流规格(D14)

- **读侧**:Next.js 层(Vercel)+ Upstash Redis 滑动窗口,真实 IP 由 Vercel 注入。**针对"新 slug 访问",已RSVP/受信的轮询重取走更宽松配额(或独立 key),间隔与窗口对齐**,避免正常用户自轮询被 429(配合 D4)。
- **写侧纵深(选项1)**:submit_rsvp / add_comment / verify_event_password 内用 `rate_limits` 做每活动/每标识每窗口上限——**anon 绕开 Next 直打写 RPC 也被 DB 限**。
- **私密读取收敛**:私密活动 `get_event_by_slug` 只对 service_role 返回数据(D3),由 Next SSR 受信角色调用;读侧绕过只能拿第一类门面字段。

---

## RPC 函数(SECURITY DEFINER,guest 侧读写的唯一边界)

| 函数 | 档位 | 说明 |
|---|---|---|
| `guest_unlock_status(event_id, token)` | 🟢 | **共享门禁 helper(D5/D13)**,见下;**三处 RPC 必须复用,不得自行实现门禁**(护栏 grep 强制,G4) |
| `get_event_by_slug(slug, guest_token?, password?)` | 🟢 | 三类字段边界返回;**private 非 service_role → null**(D3);密码保护;count 受 hide_guest_count/私密约束 |
| `get_public_events_by_host(username)` | 🟢 | **D2**:Organizer Profile 公开活动列表(不走 anon 直查表);只 public+published |
| `get_my_events()` | 🟢 | **D1**:按 `auth.uid()` 经 host_id(我主办)+ guests.user_id(我参加)聚合;只返回自己的 |
| `submit_rsvp(...)` | 🟢 | token→user_id→新建去重(D1);容量 advisory lock(D7①);写侧 DB 限流(D14);**返回 token + 确认态**(D15) |
| `get_guest_list(slug, guest_token?)` | 🟢 | 仅 hide_guest_list=false;**只露 Going/Maybe**(不含 Can't Go);**只返回 display_name/status/plus_ones**(不含 guest_id/contact/token,D15);调用者需"已解锁"(helper) |
| `get_comments(slug, guest_token?)` | 🟢 | **D6 读路径**:读开放(不要求 RSVP),沿用 D3 可见性闸;只返回 body/作者 display_name/created_at |
| `add_comment(slug, guest_token, body)` | 🟢 | 写门禁=helper 已解锁;**作者服务端绑定**(D6);rsvp_enabled=false → 仅 host;不写 gif |
| `vote_dates(slug, guest_token, option_ids[])` | 🟢 | 多选 upsert(去掉未选项) |
| `finalize_date(event_id, option_id)` | 🟢 | host-only:函数内 `auth.uid()=host_id` 否则 raise;须 host auth 上下文调用(非 service-role,D7③);保留投票记录 |
| `promote_guest(rsvp_id)` | 🟢 | host-only(同上);waitlist→going(尊重容量) |
| `verify_event_password(slug, password)` | 🟢 | **D7⑤/amend**:bcrypt 校验;**独立、按 IP/活动限流(rate_limits)**;通过发**短时签名凭证(cookie)**,后续读/轮询不再重跑 bcrypt |

### `guest_unlock_status(event_id, token)` 共享门禁 helper(D5/D13)

`STABLE`(被 DEFINER RPC 调用继承权限读表,`auth.uid()` 可读)。返回 `{guest_id, unlocked bool, status}`:
```
select g.id, (r.status in ('going','maybe','waitlisted')) as unlocked, r.status
from guests g join rsvps r on r.guest_id = g.id
where g.event_id = $event_id
  and ( g.guest_token = $token  or  (auth.uid() is not null and g.user_id = auth.uid()) )
```
- **解锁集 = {going, maybe, waitlisted}**;**not_going 不解锁**。
- token 必须按 `event_id` scope(跨活动 token 复用无效)。
- 命中返回 guest_id 供 add_comment 作者绑定(免二次查)。

### `get_event_by_slug` 字段边界(逐字段钉死)

**第一类 — 未解锁也返回(公开门面)**:
title, cover_image_url, description, theme, effect, **location_city**(仅城市级),
starts_at, ends_at, date_tbd, host display_name, rsvp_enabled,
**going_count**、**capacity_remaining** —— **当 hide_guest_count=true,或 visibility='private' 且调用者未解锁/非受信时,这两个字段从返回体省略**(非置0,D7②)。

**第二类 — 解锁(helper unlocked)后才返回(敏感细节)**:
**location_text(完整地址)**、location_url、guest list(经 get_guest_list)、评论**发布权**(读开放、写门禁)。

**第三类 — 永不返回给任何 guest(仅 host)**:
guests.contact、其他 guest 的 guest_token/user_id、view_password_hash 原始值、**Can't Go 名单**、问卷答案。

**私密 + 密码闸顺序**:① `visibility='private' 且 auth.role()<>'service_role' → null`(D3)② `view_password_hash` 非空且未持有效凭证/密码不符 → 只返回**最小锁定响应**(title + cover,够渲染密码框/分享预览)③ 否则正常分级。

---

## RLS 安全总则(每张表都启用 + 有非全放行策略;护栏 DB 权威校验,D12b/G1)

1. **profiles**:`using/with check(id=auth.uid())`,仅本人;触发器建档(D7④)。
2. **events(D9)**:INSERT `with check(host_id=auth.uid())`;SELECT/UPDATE/DELETE `using(host_id=auth.uid())`。**anon 无任何 events 直读策略**——公开活动经 `get_event_by_slug`(DEFINER)读;私密经 SSR 受信角色 + 函数内角色闸(D3)。event_hosts owner 行由触发器写。
3. **guests/rsvps/comments/date_votes/answers/…**:活动的 host(**authenticated,经 events.host_id 所有权策略**)可读自己活动的全部;**anon 对这些"客数据表"无任何策略/授权**(G1,只经 DEFINER RPC 到达);guest 侧(anon)读写一律走 DEFINER RPC。policy 谓词必须按所有权 scope,**禁 `using(true)`**;**所有客数据表的 host 策略必须显式 `to authenticated`(I1)——不得默认 `public` 角色,否则护栏(查 `roles && {anon,public}`)会按 anon 策略拦下**。
4. **🟡 表(comment_reactions/event_photos/questions/answers/scheduled_reminders/broadcasts)**:MVP 仅 host(经 event 所有权)SELECT,anon/guest deny;**answers/broadcasts/scheduled_reminders 显式"anon/guest 永不可达"**(测试断言)。
5. **rate_limits**:RLS 启用 + **显式 deny 策略** `for all to authenticated using(false) with check(false)`(anon 无策略);DEFINER RPC(owner)绕 RLS 访问(M3)。
6. **contact / 其他 guest 的 token/user_id / Can't Go 名单 / 问卷答案 永不暴露给 anon/guest。**
7. **slug 随机段密码学安全(gen_random_bytes),≥10 位,冲突 fail-closed;guest_token 永不进 URL。**
8. 限流:读侧 Next+Upstash + 写侧 DB 纵深(D14)。

---

## Storage(D16)

**两个 bucket(现在就定结构,相册 ready)**:
- `event-covers`:**公开读 / 仅 host 写**;对象名 `<event_id>/<uuid>.<ext>`(随机防枚举)。封面是第一类门面(OG 也用)。
- `event-photos`(相册 🟡,无 UI):**私有 bucket**;将来读经签名 URL / 受信门禁;现仅建结构。

**storage.objects RLS**:
- 写(INSERT/UPDATE/DELETE):`authenticated` 且 **`auth.uid() = events.host_id`(拥有该 event)且对象路径前缀 = `<event_id>/`**;**不写这条 = 任意登录用户覆盖他人封面 / anon 可传**。
- 读:`event-covers` 公开;`event-photos` 私有(无公开读策略)。

**上传校验(服务端强制,非只前端)**:bucket 级 `allowed_mime_types`(image/png, image/jpeg, image/webp)+ `file_size_limit`(封面 ~5MB)。
**相册将来强制剥 EXIF**(GPS 会泄露地点,与私密地址模型冲突)。
护栏:**D12b DB 权威校验扩到 `storage` schema**,断言 storage.objects 策略正确、anon 不能越权写(G8)。

---

## 未来产品线(Cards)

主题/特效/Storage/链接分享这套基建保持通用,不做任何会堵死它的设计。
