# JU — 交接文档 (HANDOFF)

> 2026-06-18 写。这份文档让任何人/新会话能接手。配套文件：`AUDIT.md`（92 条问题清单 = 待办源头）、`DEPLOY.md`（部署填空清单）、`SECURITY.md`（安全审查报告）、`CLAUDE.md`/`SCHEMA.md`/`TASKS.md`（项目宪法/数据模型/任务）。Claude 记忆目录里另有 `prelaunch-fix-progress`、`running-web-app-locally`、`deployment-is-manual-run-is-local`、`product-review-findings`、`source-grep-tests-and-test-exit-code` 等。

## 1. 这是什么
**JU** = 给年轻华人用户的活动邀请平台（Partiful 的简化、可商用克隆）。核心闭环：主办建活动 → 分享公开链接 → 访客**无需注册**用链接 RSVP（名字+可选联系方式）。主办有账号、访客没有。
- **后端**：Supabase（Postgres + RLS + Auth + Storage + RPC），无独立 API server。**数据库是安全边界**：访客读写只经 `SECURITY DEFINER` RPC；anon 对客数据表零直接权限；host 经 RLS（`host_id = auth.uid()`）只碰自己的活动；私密活动只经可信 service-role SSR 读；完整地址/客人名单是二级字段（RSVP 解锁后才给）；`contact` 仅主办可见、非身份键；`guest_token` 存 localStorage、绝不进 URL。
- **前端**：Next.js 16.2.9（App Router，**非标准版，看 `web/node_modules/next/dist/docs/`**）+ TS strict + Tailwind v4 + next-intl。pnpm。
- 这项目原本由一个无人值守 agent 流水线（`run-agent.sh` + `check-boundaries.sh`）自己写出来的；流水线已跑完（TASKS.md 全 `[x]`）。

## 2. 当前状态（最重要）
**分支 `prelaunch-fixes`（从 master 切出）上完成了一轮"上线前修复"**，针对 `AUDIT.md` 的 92 条审计发现，修掉了**全部 阻断 + 高危**项。
- ✅ 全量测试 **489 用例 / 39 文件全绿**。
- ✅ 护栏 `check-boundaries.sh` 8/8 全过（含 DB 权威 RLS）。
- ✅ 独立多 agent 安全复核：**0 条可利用漏洞**（发现 1 条新引入低危 oracle，已用迁移 0019 关闭并复验）。
- ✅ `master` 和 `prelaunch-fixes` 都已推到 GitHub `Yuqiao-Li/JU_Project`。
- 当前 HEAD：`3ce3530`。迁移已到 **0019**。

### 工作模式（用户强制要求，务必延续）
**实现由我/实现 agent 写；测试一律由"独立 agent"写**（全新上下文、把实现当黑盒、只碰 `tests/`、对抗性地按 spec 测）。每批：实现 → 独立测试 agent → 跑全量门禁 → 提交。这套机制实战抓到 2 个真 bug（见下）。为省主上下文，实现也尽量委派给 agent。

## 3. 已完成（批次 → 提交）
| 批次 | 内容 | 提交 |
|---|---|---|
| 1/1b | next-intl 双语基建（默认中文、NEXT_LOCALE cookie、无 URL 路由）+ 中文字体回退 + 全站可见 UI 中文化 + 语言切换 | `5eaa57c` / `4c5316d` |
| 2 | 改名 Partiful → JU（保留 localStorage 前缀 `partiful:rsvp:` 以免老 token 失效；保留名加 "ju"） | `78b6893` |
| 3 | 时区：主办输入按北京(+08:00)存为 UTC，全站 zh-CN/Asia-Shanghai 显示（`lib/events/timezone.ts`） | `d37a580` |
| — | 独立测试补全（B3 时区、重写 B4、加强 B1b） | `476d069` |
| 4 | 活动生命周期：取消/删除/发布动作（RLS 授权）+ updateEvent 不复活已取消 + 公开页"已取消/已结束"横幅并禁 RSVP/投票/加日历 + draft 死链提示 + 以访客预览 | `b7556f0` |
| 5 | 主办 UX：`get_my_events` 返回人数计数（迁移 **0017**）→ 仪表盘卡片显示；复制全部联系方式 | `551a37b` |
| 6 | RSVP/解锁：H14 解锁失败给重试反馈；**H16 跨设备账号解锁**（迁移 **0018**：`get_event_by_slug`/`guest_unlock_status` 加可信 `viewer_id`，仅 service_role 认）；M26 候补文案 | `842a68f` |
| 7 | 数据丢失防护 + Auth：**登录重发链接+冷却**(H22)、M49 重定向用 `NEXT_PUBLIC_SITE_URL`、H21 auth 回调错误处理、H19 清空用户名需确认、H20 RPC 错误抛到 error.tsx 而非空态 | `aabcb0a` |
| 安全收口 | 迁移 **0019**：`guest_unlock_status` 也只对 service_role 采信 viewer_id（关闭 anon RSVP-出席 oracle） | `3ce3530` |

**独立测试 agent 抓到的真 bug**：① B5 迁移文件名撞 `0016_date_poll`（CLI 按数字前缀去重 → 没生效，已改名 0017）；② 安全复核发现 0018 的 viewer_id 在 helper 内无信任校验（已 0019 修）。

## 4. 关键决策/约定（别推翻）
- i18n：**中英双语 next-intl**，默认中文，cookie `NEXT_LOCALE`，**无 URL 路由**；客户端组件 `useTranslations`、服务端 `getTranslations`；文案在 `web/messages/{zh,en}.json` 按 namespace。
- 时区：**单一中国时区 Asia/Shanghai（+08:00）**。多时区（活动级时区列）留作迭代。
- Supabase key：用 **legacy anon / service_role**（经典 JWT），不用新的 sb_publishable/sb_secret——代码和测试都按 legacy 验证过。
- 迁移：编号唯一、不可改已应用的；最新 **0019**，下一个用 0020。CLI 按**前导数字**去重（别再撞号）。
- 测试坑：**别把 `pnpm test` 接管道**（`| tail` 会吞掉 vitest 退出码，曾误报绿）；有些测试 grep 源码里的硬编码英文/签名，改文案/签名会打破它们，需独立 agent 同步更新（保留安全意图）。

## 5. 本地怎么跑/测（坑都在这）
- `web/.env.local` 默认是**占位符**；真实本地值用 `eval "$(supabase status -o env)"` 取（`API_URL/ANON_KEY/SERVICE_ROLE_KEY/DB_URL`）。本地 API `http://127.0.0.1:54321`，Mailpit（magic-link 邮件）`http://127.0.0.1:54324`。
- **别在主工作树跑 `pnpm dev`**（会和测试/构建抢 `.next/`）。用隔离 worktree：`git worktree add --detach /home/rain/ju-preview HEAD` → `CI=true pnpm --dir <wt>/web install` → 写 .env.local（含 `RATELIMIT_BACKEND=memory`，没 Upstash 时限流自动退化内存版）→ 用 **next 二进制**直接起：`<wt>/web/node_modules/.bin/next dev <wt>/web -p 3001 -H 127.0.0.1`（`pnpm run dev -- -p` 会错传参数）。
- **本地访问/登录一律用 `localhost:3001`，不要 `127.0.0.1`**：auth 回调用 `request.nextUrl.origin`（dev 下解析成 localhost），cookie 是 host 绑定的，混用会被弹回登录。
- 本地登录：magic link 进 Mailpit；或用 service role 一键生成登录链接：`POST $API_URL/auth/v1/admin/generate_link {type:magiclink,email:demo-host@partiful.local,redirect_to:.../auth/callback}` 取 `hashed_token` → 开 `/auth/callback?token_hash=<...>&type=magiclink`（一次性、db reset 后失效）。
- seed 演示：公开活动 slug `demo-summer-rooftop-bash`、私密 `demo-members-only-tasting`、主办主页 `/u/demo_host`，host 账号 `demo-host@partiful.local`。
- 全量门禁：`pnpm --dir web test`（要本地 stack 起着、会 db reset，~12 分钟）。护栏：`RUN_DB_CHECKS=1 SUPABASE_DB_URL=... bash ./check-boundaries.sh`。

## 6. 部署状态 + 当前卡点
按 `DEPLOY.md` 走。已完成：GitHub 仓库 + 两分支已推；Vercel 项目已建（Root Directory=`web`）；三个环境变量已在 Vercel 配（Production and Preview）。
**当前正卡在 Vercel preview 验收**，两个待修：
1. ⚠️ `NEXT_PUBLIC_SUPABASE_URL` 值填错了——填成了 `https://jfqynfatjwrlndkzdsqq.supabase.co/rest/v1/`，**应去掉 `/rest/v1/`**，改成 `https://jfqynfatjwrlndkzdsqq.supabase.co`（base URL，无结尾斜杠）。
2. `NEXT_PUBLIC_*` 是**构建时**烤进去的——改值后必须**无缓存 Redeploy**（取消 "Use existing Build Cache"），并打开新构建的网址。
还需确认/做：`supabase db push`（云端库要有 0001–0019 schema，否则"表不存在"）；Supabase Auth → URL Configuration 加 preview/正式域名到 Site URL + Redirect URLs（`.../auth/callback`）；正式上线配 **SMTP**（内置邮件每小时仅几封）+ Vercel 设 `NEXT_PUBLIC_SITE_URL`（M49 依赖它做登录重定向）。
- 🔒 **安全**：用户在聊天里贴过 service_role key → **上线前轮换 JWT secret**（Supabase Settings → API）。

## 7. 还剩什么（全是上线后迭代，中/低优先；源头 AUDIT.md）
- 服务端报错文案 i18n（M3–M6：zod 校验信息、server action 返回 message、API route message、Supabase 原始错误、lib 里的 "Date TBD"）——目前这些仍是英文。
- 多时区支持（活动级 timezone 列）。
- 无障碍扫除（M7–M12：radio 键盘、直播区 aria-live、错误关联+焦点、对比度 token、封面改 `<img>`+alt、触控目标）。
- B6 遗留：无 token 的"账号解锁"访客只通过 SSR 拿到解锁门面，**不含实时轮询的客人名单**（`get_guest_list` 是 token-scoped）——要扩展得改 get_guest_list。
- 其余中/低打磨见 AUDIT.md。

## 8. 上线路径（建议顺序）
1. 验收 preview（修好第 6 节两点）或本地预览，把中文化/改名/时区/取消/人数/登录重发等点一遍。
2. 满意后 **`prelaunch-fixes` → `master`**（开 PR 或本地 merge），Vercel production 自动部署。
3. 部署前：Vercel 配 `NEXT_PUBLIC_SITE_URL` + Supabase 配 SMTP + Auth URL 含正式域名；轮换 service_role key。
4. 上线后按优先级做第 7 节迭代项（仍用"独立测试 agent"模式）。
