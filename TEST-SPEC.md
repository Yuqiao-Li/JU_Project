# TEST-SPEC.md — 安全门禁测试断言清单

> 给**独立测试 agent**的对抗性测试规格。每个 [SECURITY] 任务对应一节。
> 测试 agent 以"假设实现有漏洞"的怀疑心态写,逐条覆盖下列断言,并可补充更狠的边界用例。
> **任一断言不通过 → 任务不打勾**,把失败断言记入 BLOCKERS.md。
> 测试用 Vitest,对测试 DB 跑(连接串来自 env)。anon 路径用 anon key 客户端;host 路径用已登录会话;受信路径用 service 角色。

## §1.3 — RLS host 隔离
- host A 用自己会话查 host B 拥有活动的 guests/rsvps → **断言返回空/被拒**。
- host A 不能 UPDATE/DELETE host B 的 events 行 → **断言被拒**。
- 未登录 anon 查任意 host 的 dashboard 类数据 → **断言被拒**。

## §1.4 — 公开读 + 私密收敛 + contact 不泄露
- anon 直接 SELECT 一个 `private` 活动行(经 anon key)→ **断言空**(私密不对 anon 裸奔)。
- anon SELECT 一个 `public`+`published` 活动 → **断言可读**(公开可见)。
- anon SELECT 一个 `public` 但 `draft` 活动 → **断言空**(草稿不可见)。
- 任意 anon 可达路径取到的 guests 数据 → **断言不含 contact 字段**。

## §1.5 — guest 侧 RPC(核心安全套件)
**分级返回(get_event_by_slug):**
- **无 guest_token** 调用 → 返回含 title/cover/description/city/日期/人数;**断言不含 location_text、不含完整名单**。
- **带有效 guest_token**(已 RSVP)调用 → **断言含 location_text 与名单**。
- 带**伪造/不属于该活动**的 token → 按未 RSVP 处理,**断言不含地址**(伪造 token 不得解锁)。

**容量 / waitlist(submit_rsvp):**
- 活动 capacity=N,灌入 N 个 going(含 plus_ones 占用)后再 submit_rsvp going → **断言新记录 status='waitlisted'**。
- 容量未满时 submit → **断言 status='going'**。

**三段去重(submit_rsvp):**
- 同一 guest_token 二次 submit(改状态)→ **断言更新原 guest/rsvp,不新建**(guests 行数不增)。
- 不带 token 但 contact 与既有 guest 相同 → **断言更新既有,不新建**。
- 不带 token 且 contact 为空/不同 → **断言新建** guest。

**get_guest_list:**
- 返回结果 → **断言不含 contact 字段**;**断言不含 status='not_going'(Can't Go)条目**;只含 going/maybe。
- 活动 hide_guest_list=true 时调用 → **断言返回空/被拒**。
- 调用者未 RSVP(无有效 token)→ **断言不返回名单**。

**写门禁(add_comment):**
- 未 RSVP(无有效 token)调 add_comment → **断言被拒**。
- 有有效 token 调 add_comment → **断言成功插入**。

**host-only:**
- 非 host 调 finalize_date / promote_guest → **断言被拒**。

## §2.3.5 — 限流 + 私密收敛基础设施
- 同一 IP 在窗口内对 slug 读取超过阈值 → **断言被限**(429 或等价拒绝)。
- 阈值内正常请求 → **断言放行**。
- anon 尝试绕过 Next 直连 private 活动的 get_event_by_slug RPC → **断言被拒**(收敛有效)。

## §2.4 — 公开活动页 + RSVP(端到端语义)
- 未 RSVP 加载 /{slug} 的 SSR 响应体 → **断言不含完整地址字符串、不含名单**。
- 完成 RSVP 后再加载 → **断言含完整地址、含名单**。
- submit 在容量满时 → **断言页面显示 waitlist 状态**且记录为 waitlisted。
- 页面任何位置(HTML/JS/URL)→ **断言不出现 guest_token**(token 不进 URL/不被渲染进可分享处)。
- anon 直连 private 活动 RPC(绕过 SSR)→ **断言被拒**。

## §3.1 — 公开页名单呈现
- get_guest_list 渲染数据 → **断言无 Can't Go、无 contact**。
- 未 RSVP 访客视角 → **断言名单不可见**。
- hide_guest_count=true → **断言人数不显示**。

## §4.1 — 评论读开放/写门禁
- 未 RSVP 访客 → **断言可读评论列表**。
- 未 RSVP 访客尝试发评论 → **断言被拒**并提示先 RSVP。
- 已 RSVP(有 token)发评论 → **断言成功并实时出现**。

## §6.3 — OG meta 不泄露
- 私密活动的 OG meta 输出 → **断言含 title/cover/description,不含 location_text**。
