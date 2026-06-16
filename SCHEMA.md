# SCHEMA.md — Partiful Clone 数据库全貌(定稿设计)

> 本文件是数据模型的单一事实来源,反映所有已锁定的设计决策。
> 标记说明:🟢 MVP 做全 · 🟡 表/列建好但逻辑或 UI 留白 · 🔴 暂不建(此处不出现,仅记录于范围文档)
> 原则(C 路线):**数据模型与安全从第一天做对;功能可延后,表结构不将就。**

---

## 表清单总览

| 表 | 档位 | 作用 |
|---|---|---|
| `profiles` | 🟢 | host 账号信息(+ 🟡 username 用于 Organizer Profile) |
| `events` | 🟢 | 活动核心实体(含多个 🟡 留白列) |
| `event_hosts` | 🟡 | co-host 关联表(MVP 只放创建者一行) |
| `guests` | 🟢 | 无账号访客(guest_token 身份) |
| `rsvps` | 🟢 | 回复(Going/Maybe/Can't Go/Waitlisted) |
| `comments` | 🟢 | Activity Feed 评论(含 GIF URL) |
| `comment_reactions` | 🟡 | 评论 emoji 反应(表建好,UI 留白) |
| `event_photos` | 🟡 | Photo Album(表建好,上传 UI 留白) |
| `date_options` | 🟢 | 日期投票候选 |
| `date_votes` | 🟢 | 日期投票记录 |
| `questions` | 🟡 | 问卷题目(表建好,UI 留白) |
| `answers` | 🟡 | 问卷答案(表建好,UI 留白) |
| `scheduled_reminders` | 🟡 | 自动提醒队列(表+查询建好,调度/发送留白) |
| `broadcasts` | 🟡 | Text Blast 群发记录(表建好,发送渠道留白) |

---

## 1. profiles 🟢

host 账号镜像(对应 Supabase auth.users)。

| 列 | 类型 | 档位 | 说明 |
|---|---|---|---|
| id | uuid PK = auth.users.id | 🟢 | |
| display_name | text | 🟢 | |
| avatar_url | text | 🟢 | |
| **username** | text unique nullable | 🟡→🟢 | Organizer Profile 的 `/u/[username]`。**因为个人页提到🟢,username 列做全**;但唯一性校验/设置 UI 跟个人页一起 |
| created_at | timestamptz | 🟢 | |

## 2. events 🟢(核心,含最多留白列)

| 列 | 类型 | 档位 | 说明 |
|---|---|---|---|
| id | uuid PK | 🟢 | |
| host_id | uuid → profiles | 🟢 | 创建者。co-host 走 event_hosts 表,但 host_id 保留为"主创建者"指针 |
| slug | text unique | 🟢 | **人类可读段 + ≥8 位密码学随机后缀**(硬安全要求) |
| title | text | 🟢 | |
| description | text | 🟢 | |
| cover_image_url | text | 🟢 | 上传到 Supabase Storage |
| theme | jsonb | 🟢 | 主题配置(MVP 简单版:背景色等) |
| effect | text | 🟢 | 特效(MVP 少量预设) |
| starts_at | timestamptz nullable | 🟢 | 日期已定时有值;待定时为空(问题4) |
| ends_at | timestamptz nullable | 🟢 | |
| date_tbd | boolean | 🟢 | true=待定+走 date_options 投票(问题4) |
| location_text | text nullable | 🟢 | 自由文字,支持"我家"/TBD(问题5) |
| location_url | text nullable | 🟢 | 可选地图/场地链接 |
| location_city | text nullable | 🟢 | **城市级地点**,RSVP 前可见(问题6甲:未RSVP只看到城市) |
| **lat** | double nullable | 🟡 | 预留经纬度,MVP 永远空,未来接 Places API(问题5) |
| **lng** | double nullable | 🟡 | 同上 |
| visibility | text check(public/private) | 🟢 | private = link-private(问题6) |
| **view_password_hash** | text nullable | 🟡 | 密码保护,MVP 留空,RPC 预留验证位 |
| capacity | int nullable | 🟢 | 容量上限 |
| allow_plus_ones | boolean | 🟢 | |
| max_plus_ones | int default 1 | 🟢 | 每人 +N 上限(Partiful 有此设置) |
| rsvp_enabled | boolean default true | 🟢 | **RSVP 开关**(本轮新增,关了只发信息不收回复) |
| hide_guest_list | boolean | 🟢 | 隐藏名单 |
| hide_guest_count | boolean | 🟢 | 隐藏人数 |
| hide_feed_timestamps | boolean | 🟢 | 隐藏 feed 时间戳(顺手,纯渲染开关) |
| **anonymize_guest_list** | boolean | 🟡 | 匿名名单,列建好,渲染逻辑留白 |
| **allow_photo_upload** | boolean | 🟡 | 相册开关,配合 event_photos 表,UI 留白 |
| **guest_approval_enabled** | boolean default false | 🟡 | 审核开关,配合 rsvps.approval_status,流程留白 |
| **chip_in_url** | text nullable | 🟢 | **AA 收款链接**(顺手做,纯展示不碰钱) |
| **chip_in_note** | text nullable | 🟢 | 收款说明文字 |
| status | text check(draft/published/cancelled) | 🟢 | |
| created_at / updated_at | timestamptz | 🟢 | updated_at 触发器 |

## 3. event_hosts 🟡(co-host 留白)

> MVP 只在建活动时插入创建者一行;不做添加 co-host 的 UI。RLS 先只认创建者。
> 未来加 co-host = 往表里加行 + 放宽 RLS,**不动 events 结构**。

| 列 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| event_id | uuid → events | |
| user_id | uuid → profiles | |
| role | text check(owner/cohost) default 'owner' | MVP 只有 owner |
| created_at | timestamptz | |
| | unique(event_id, user_id) | |

## 4. guests 🟢

无账号访客。guest_token 是编辑自己 RSVP/评论/投票的凭证(问题2:token为主,contact可选)。

| 列 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| event_id | uuid → events | |
| guest_token | uuid unique default gen_random_uuid() | localStorage 保存,身份凭证 |
| display_name | text not null | |
| contact | text nullable | 邮箱/手机,**仅 host 可见**;可选;留了才能收主动推送(问题2 C) |
| created_at | timestamptz | |

> **去重逻辑(问题2 C,写在 submit_rsvp RPC)**:token 命中→更新该 guest;否则若 contact 命中同活动→更新;都没有→新建。

## 5. rsvps 🟢

| 列 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| event_id | uuid → events | |
| guest_id | uuid → guests | |
| status | text check(going/maybe/not_going/waitlisted) | |
| plus_ones | int default 0 check >=0 | |
| **approval_status** | text check(pending/approved/rejected) default 'approved' | 🟡 MVP 永远 approved;开审核才用 |
| created_at / updated_at | timestamptz | |
| | unique(event_id, guest_id) | |

> 容量逻辑(RPC):going+plus_ones 占用 >= capacity 时,新 RSVP 落 waitlisted。

## 6. comments 🟢(Activity Feed)

| 列 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| event_id | uuid → events | |
| guest_id | uuid → guests nullable | guest 评论时填 |
| host_id | uuid → profiles nullable | host 评论时填 |
| body | text | |
| gif_url | text nullable | 🟢 仅存 URL,不接 Giphy API |
| created_at | timestamptz | |
| | check: guest_id/host_id 恰有一个非空 | |

## 7. comment_reactions 🟡(留白)

> 表建好,MVP 不做反应 UI。

| 列 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| comment_id | uuid → comments | |
| guest_id | uuid → guests | |
| emoji | text | |
| created_at | timestamptz | |
| | unique(comment_id, guest_id, emoji) | |

## 8. event_photos 🟡(Photo Album 留白)

> 表建好 + 复用 Storage,MVP 不做上传/相册 UI。受 events.allow_photo_upload 控制。

| 列 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| event_id | uuid → events | |
| guest_id | uuid → guests nullable | |
| host_id | uuid → profiles nullable | |
| image_url | text | Supabase Storage |
| created_at | timestamptz | |

## 9. date_options 🟢 / 10. date_votes 🟢(日期投票)

**date_options**
| 列 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| event_id | uuid → events | |
| starts_at | timestamptz | 候选时间 |
| ends_at | timestamptz nullable | |
| created_at | timestamptz | |

**date_votes**
| 列 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| date_option_id | uuid → date_options | |
| guest_id | uuid → guests | |
| created_at | timestamptz | |
| | unique(date_option_id, guest_id) | |

> 敲定日期:写 events.starts_at + date_tbd=false,**投票记录保留不删**(问题4)。

## 11. questions 🟡 / 12. answers 🟡(问卷留白)

> Phase 1 建表,前端表单 UI 后期做。

**questions**
| 列 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| event_id | uuid → events | |
| prompt | text | |
| type | text check(text/single/multi/**social**) | social=填社交账号(本轮新增) |
| options | jsonb nullable | single/multi 的选项 |
| required | boolean | |
| position | int | 排序 |

**answers**
| 列 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| question_id | uuid → questions | |
| guest_id | uuid → guests | |
| value | jsonb | |
| created_at | timestamptz | |
| | unique(question_id, guest_id) | |

> CSV 导出(host 拉名单+答案)= 🟡 后期加一个导出端点,数据已在表里。

## 13. scheduled_reminders 🟡(Auto-Reminders 留白)

> Phase 1 建表 + 写"选出待发记录"的 SQL;pg_cron 调度 + Edge Function 发送 + 短信/邮件服务商**全部后期接通**(问题3 A)。**依赖 guest.contact 存在才有意义。**

| 列 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| event_id | uuid → events | |
| guest_id | uuid → guests nullable | 空=发给全体 |
| remind_at | timestamptz | 该发的时间点(基于 events.starts_at 算) |
| channel | text check(email/sms) | |
| status | text check(pending/sent/failed) default 'pending' | |
| sent_at | timestamptz nullable | |
| created_at | timestamptz | |

## 14. broadcasts 🟡(Text Blast 留白)

> host 立即群发。表建好,发送渠道后期接。依赖 guest.contact。

| 列 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| event_id | uuid → events | |
| body | text | |
| channel | text check(email/sms) | |
| sent_at | timestamptz nullable | |
| created_at | timestamptz | |

---

## SLUG 生成规格(问题7,不可打桩)

> slug 是私密模型的物理地基。以下为硬要求,agent 无自由发挥空间。

- **结构**:`{slugify(title 前40字符)}-{10位 base62 随机段}`,例:`rains-birthday-x7k2m9qpvw`
- **随机段**:**10 位 base62**(~60 bits 熵),**必须用 `gen_random_bytes()` 等密码学安全随机源**。
  - **严禁** `random()`、时间戳派生、自增 ID 派生等可预测来源。
- **纯中文/空标题**:slugify 结果为空时,**省略可读段,只用纯随机段**(如 `x7k2m9qpvw`)。不音译中文。
- **唯一性**:`unique` 约束兜底;插入遇唯一冲突时**重新生成随机段重试一次**。
- **URL 边界**:slug 进 URL(它是活动公开地址);**guest_token 永不进 URL**,只存在于 RPC 返回值 + localStorage。

## 限流规格(问题8,MVP 必做)

- **位置**:**Next.js 层(Vercel)+ Upstash Redis 滑动窗口**(`@upstash/ratelimit`)。不放 Postgres(拿不到真实 IP)。
- **真实 IP**:由 Next 服务端 / Vercel 注入获取。
- **私密读取收敛**:私密活动的 slug 读取**只走 Next SSR**;`get_event_by_slug` 对 private 活动**不对 anon 裸奔**——由 **Next 服务端用受信角色(service-role)调用**,限流在它前面的 Next 层把关。
- **公开活动**:可保留一条 anon 可直接读的宽松路径(本就该被发现),仍建议经 Next 以统一限流。

---

## RPC 函数(SECURITY DEFINER,guest 侧写入的安全边界)

| 函数 | 档位 | 说明 |
|---|---|---|
| `get_event_by_slug(slug, guest_token?)` | 🟢 | **按是否已RSVP返回两档**(见下方字段边界)。**私密活动由 Next 服务端受信角色调用,不对 anon 裸奔。** 预留密码验证位 |
| `submit_rsvp(...)` | 🟢 | token/contact/新建三段去重(问题2);容量满落 waitlist |
| `get_guest_list(slug, guest_token?)` | 🟢 | 仅 hide_guest_list=false 时返回;**只露 Going/Maybe(不含 Can't Go)**;不含 contact;**调用者需已RSVP** |
| `add_comment(slug, guest_token, body, gif_url)` | 🟢 | 校验 token 属于该活动(**写门禁:必须已RSVP**) |
| `vote_dates(slug, guest_token, option_ids[])` | 🟢 | 多选投票 upsert |
| `finalize_date(event_id, option_id)` | 🟢 | host-only,写回 starts_at |
| `promote_guest(rsvp_id)` | 🟢 | host-only,waitlist→going |

### `get_event_by_slug` 字段边界(问题9,逐字段钉死)

**第一类 — 未 RSVP 也返回(公开门面):**
title, cover_image_url, description, theme, effect, **location_city**(仅城市级),
starts_at, ends_at, date_tbd, host display_name, rsvp_enabled,
**going_count**(除非 hide_guest_count;**显示精确数字,不模糊化**),
**capacity_remaining**(除非 hidden)。

**第二类 — RSVP 后才解锁(敏感细节):**
**location_text(完整地址)**, location_url,
**guest list(Going/Maybe)** — 经 get_guest_list,受 hide_guest_list 控制,
**评论发布权** — 评论**读开放、写门禁**:未RSVP可读评论,读后提示"先RSVP才能评"。

**第三类 — 永不返回给任何 guest(仅 host):**
guests.contact、其他 guest 的 guest_token、view_password_hash 等设置原始值、
**Can't Go 名单**、问卷答案(answers)。

---

## RLS 安全总则(每张表都启用)

1. **profiles**:仅本人 CRUD 自己那行。
2. **events**:创建者(经 event_hosts owner)全权;anon 仅能 SELECT `published`+`public` 的行;**private 不对 anon 裸奔,经 Next 服务端受信角色凭 slug 访问**。
3. **guests/rsvps/comments/...**:活动的 host 可读全部(看 dashboard);guest 侧写入一律走 SECURITY DEFINER RPC,不给 anon 宽 INSERT。
4. **contact 字段永不暴露给 anon**(只 host 可见)。**Can't Go 名单永不返回给 guest。问卷答案仅 host 可见。**
5. **slug 随机段必须密码学安全(`gen_random_bytes`),≥10位;guest_token 永不进 URL。**
6. **限流(Next + Upstash)对 slug-based 读取生效,MVP 必做。**
7. **未来产品线(Cards)不做任何会堵死它的设计**——主题/特效/Storage/链接分享这套基建保持通用。
