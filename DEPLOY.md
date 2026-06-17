# JU 部署工作清单（填空版）

> 与代码修复并行进行。先搭好基建 + staging 验证；**正式上线等 i18n / 改名 / 时区等修复合并到 `master` 之后**。
> 详细说明见 [README.md](README.md) 的 Deployment 一节；这里是"照着勾 + 填空"的执行版。

## 0. 账号准备
- [ ] GitHub 账号（Vercel 从这里导入代码）
- [ ] Supabase 账号 <https://supabase.com>
- [ ] Vercel 账号 <https://vercel.com>
- [ ] Upstash 账号 <https://upstash.com>（可选但建议）
- [ ] （可选）一个 SMTP 邮件服务（Resend / 阿里云邮件 / SES）——**正式上线邮箱登录必需**

## 1. 推代码到 GitHub
> 当前 git origin 指向本地文件夹，不是 GitHub，必须新增远端。
- [ ] 在 GitHub 网页建一个**空的 private 仓库**（名字如 `JU`，不要勾 README/.gitignore）
- [ ] 本地关联并推送：
```bash
cd /home/rain/JU_Project
git remote add github https://github.com/<你的用户名>/JU.git
git push -u github master
git push github prelaunch-fixes
```
- [ ] 填：GitHub 仓库地址 = `____________________`

## 2. Supabase 云项目 + 推数据库
- [ ] Supabase 网页建项目，记下 region 和数据库密码
- [ ] CLI 登录并推 migration：
```bash
supabase login
supabase link --project-ref <project-ref>
supabase db push          # 只推 migration，不会推 seed —— 正确
```
- [ ] ⚠️ **不要** 对生产跑 `seed.sql`（那是演示数据）
- [ ] 在 Settings → API 抄下三个值（填到第 5 步）

**收集这些值：**
```
project-ref            = ____________________
NEXT_PUBLIC_SUPABASE_URL      = https://____________.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY = ____________________
SUPABASE_SERVICE_ROLE_KEY     = ____________________   (server-only，绝不加 NEXT_PUBLIC_)
```

## 3. Supabase Auth 配置
- [ ] Authentication → URL Configuration：
  - Site URL = `https://____________.vercel.app`（先用 Vercel 域名，有自定义域再换）
  - Redirect URLs 加上：`https://____________.vercel.app/auth/callback`
- [ ] ⚠️ **邮件速率坑**：内置邮件免费档每小时仅几封，仅够测试。正式上线前在 Authentication → Emails(SMTP) 配自己的 SMTP。
- [ ] Google 登录：首发可跳过（magic link 不依赖它）

## 4. Upstash Redis（读侧限流，建议）
- [ ] 建一个 Redis 库，抄下：
```
UPSTASH_REDIS_REST_URL   = ____________________
UPSTASH_REDIS_REST_TOKEN = ____________________
```
> 不配也能跑（退化为单实例内存限流，仍生效）。

## 5. Vercel 项目 + 环境变量
- [ ] 导入 GitHub 仓库
- [ ] ⚠️ **Root Directory 设为 `web/`**（关键，否则找不到 Next 应用）
- [ ] Settings → Environment Variables 填：

| 变量 | 值 | 必填 |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | （第 2 步） | ✅ |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | （第 2 步） | ✅ |
| `SUPABASE_SERVICE_ROLE_KEY` | （第 2 步，**普通变量，非 NEXT_PUBLIC_**） | ✅ |
| `NEXT_PUBLIC_SITE_URL` | `https://你的域名`（修完 M49 后用于 auth 重定向） | 建议 |
| `UPSTASH_REDIS_REST_URL` | （第 4 步） | 建议 |
| `UPSTASH_REDIS_REST_TOKEN` | （第 4 步） | 建议 |
| `EVENT_CREDENTIAL_SECRET` | 自己生成的随机串（不填则回退 service-role key） | 可选 |

- [ ] Deploy

## 6. 部署后
- [ ] 用 Vercel 给的域名访问，跑通：建活动 → 复制链接 → 无痕窗口 RSVP → 收到 magic link 登录
- [ ] 把真实域名回填到 Supabase Auth 的 Site URL / Redirect URLs（第 3 步）
- [ ] ⚠️ 现阶段建活动时间会偏（时区 bug H1 未修），先别当真，等 Batch 3 修完

## Staging vs 正式
- `prelaunch-fixes` 分支推到 GitHub 后，Vercel 会**自动生成一个 preview 部署**——用它验证链路，**别对外公开**。
- 修复全部合并到 `master` 后，Vercel production（跟 `master`）才部署正式版。

## 正式上线前最终核对
- [ ] migration 已 `db push`；如改过 schema 已重新 gen-types
- [ ] Auth Site URL + Redirect URLs 含正式域名；**SMTP 已配**
- [ ] `SUPABASE_SERVICE_ROLE_KEY` 是 server-only（绝不 NEXT_PUBLIC_）
- [ ] Upstash 已配（共享限流窗口）
- [ ] 无任何密钥被提交进 git
- [ ] i18n / 改名 JU / 时区 等阻断项已合并
