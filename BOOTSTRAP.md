# BOOTSTRAP.md — 开跑前逐项打勾清单

> 这是**开跑前**的环境与护栏自验清单。按 A→B→C→D 顺序逐项 `[x]`。
> **A** 备环境 → **B** 故意触发每道护栏确认它真能抓 → **C** 只跑到 Phase 0 停下人工验 → **D** 放开无人值守 + 监控/回滚。
> 配套:CLAUDE.md(宪法)· SCHEMA.md(数据/安全)· TASKS.md(任务)· TEST-SPEC.md(断言)· check-boundaries.sh / run-agent.sh(护栏/编排)。
>
> ⚠️ **铁律**:`run-agent.sh` 用了 `--dangerously-skip-permissions`。**必须在 Docker 容器或独立 VM 里跑,绝不要在日常主环境跑。**
> ⚠️ **Windows**:所有 `.sh` 用 **Git Bash 或容器(GNU + LF 行尾)** 跑,**不要用 PowerShell 跑 `.sh`**(脚本是 bash,且 GNU grep/sed 行为依赖)。
> 行尾自查:`file run-agent.sh check-boundaries.sh`(应是 LF,不是 CRLF);若被 Git 转成 CRLF:`sed -i 's/\r$//' *.sh`。

---

## A. 环境就绪

### A1 — 安装四件工具并各自验证就位
> `run-agent.sh` 开头的 preflight 会逐个检查 `claude pnpm git supabase docker psql`,缺一即 `fail loud` 退出。先手动确认:

- [ ] **docker**:`docker --version` 且 `docker info` 不报错(daemon 在跑)
- [ ] **supabase CLI**:`supabase --version`(用于 `supabase start` / `db reset`)
- [ ] **pnpm**:`pnpm --version`(Node ≥ 18:`node --version`)
- [ ] **claude**(Claude Code CLI):`claude --version` 且**已登录**(`claude` 能正常起会话)
- [ ] **psql**:`psql --version`(护栏5 的 DB 权威校验靠它连库)
- [ ] **git**:`git --version`;仓库已是 git 仓库:`git rev-parse --is-inside-work-tree`(应输出 `true`);否则 `git init` + 确认 `.gitignore` 含 `.env*`

一次性检查命令:
```bash
for c in docker supabase pnpm claude psql git; do command -v "$c" >/dev/null && echo "OK  $c" || echo "MISSING  $c"; done
```

### A2 — 起本地 Supabase 并取连接信息
- [ ] `supabase start`(在仓库根;首次会拉镜像,较慢)
- [ ] 记下输出里的:`API URL`(默认 `http://127.0.0.1:54321`)、`DB URL`(默认 `postgresql://postgres:postgres@127.0.0.1:54322/postgres`)、`anon key`、`service_role key`
- [ ] 随时可回看:`supabase status`

### A3 — 写 env(两处:shell 环境 + web/.env.local)
> **为什么两处**:`run-agent.sh` 与 `check-boundaries.sh`(护栏5)从 **shell 环境**读 `SUPABASE_DB_URL`;Next app 与 Vitest 从 **web/.env.local** 读。对照 0.2 任务要建的 `.env.local.example` 填全。

- [ ] **shell 环境**(跑 run-agent 的那个终端 export,供编排器/护栏用):
```bash
export SUPABASE_DB_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
```
- [ ] **web/.env.local**(Next + 测试用),列出需要的全部 key:
```dotenv
# Supabase（来自 supabase start / status）
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
SUPABASE_SERVICE_ROLE_KEY=<service_role key>     # 仅服务端,绝不进 NEXT_PUBLIC_*
SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres   # Vitest 集成测试连库

# Upstash Redis（限流,A4）
UPSTASH_REDIS_REST_URL=<https://...upstash.io>
UPSTASH_REDIS_REST_TOKEN=<token>
```
- [ ] 确认 `web/.env.local` 在 `.gitignore` 里(`git check-ignore web/.env.local` 应回显路径);**永不提交**

> ⚠️ 命名铁律(护栏3 会抓):service-role key 只能进 `SUPABASE_SERVICE_ROLE_KEY`(无 `NEXT_PUBLIC_` 前缀),**绝不能**塞进任何 `NEXT_PUBLIC_*`。

### A4 — Upstash Redis(限流用)
- [ ] 在 Upstash 控制台建一个 Redis 实例(免费档即可),拿 **REST URL** + **REST TOKEN**
- [ ] 写进 `web/.env.local`(见 A3)的 `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`
- [ ] 备注:限流是 Phase 2.3.5 才用;Phase 0/1 没有它也能跑,但**开跑前一起配好**省得中途卡

### A5 — 隔离环境确认(必过)
- [ ] 当前是 **Docker 容器 / 独立 VM**(不是你的主力机)
- [ ] 仓库已挂载/克隆进该环境,`.sh` 是 LF 行尾(见顶部 Windows 提示)
- [ ] `claude` 在该隔离环境内已登录

---

## B. 护栏自验(开跑前故意触发每道护栏,确认它真能抓)

> 这是验证"护栏本身有效"的关键步骤——**护栏抓不住的护栏等于没有**。
> 每条:**怎么塞 → 跑什么 → 预期报什么 → 验完还原**。塞的都是**临时探针**,验完务必删干净。

### B1 — 护栏2:slug 用 `random()` 必须被抓
- [ ] 塞探针迁移:
```bash
mkdir -p supabase/migrations
cat > supabase/migrations/9999_probe_slug.sql <<'SQL'
-- slug generator probe (gen_random_bytes 占位避免误报"未发现密码学源")
-- gen_random_bytes(8)
create or replace function probe_slug() returns text language sql as $$
  select substr(md5(random()::text), 1, 10);   -- BAD: 不安全 random()
$$;
SQL
```
- [ ] 跑:`bash ./check-boundaries.sh`
- [ ] **预期**:`护栏 2/8` 报 `❌ slug 上下文疑似使用了不安全的 random()`,总判 `❌ 护栏失败`
- [ ] 还原:`rm supabase/migrations/9999_probe_slug.sql`

### B2 — 护栏4:把密钥文件加进 git 必须被抓
- [ ] 塞探针(强制 add 绕过 .gitignore):
```bash
echo "SECRET=x" > .env.local
git add -f .env.local
```
- [ ] 跑:`bash ./check-boundaries.sh`
- [ ] **预期**:`护栏 4/8` 报 `❌ 提交了密钥文件(.env*/...)`
- [ ] 还原:`git rm --cached .env.local && rm -f .env.local`

### B3 — 护栏3:客户端文件出现 service-role 必须被抓
> 需要 `web/` 存在;开跑前可建最小桩来测,验完删。
- [ ] 塞探针:
```bash
mkdir -p web/app/probe
cat > web/app/probe/page.tsx <<'TSX'
"use client";
export default function P(){ return <div>{process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY}</div>; }
TSX
```
- [ ] 跑:`bash ./check-boundaries.sh`
- [ ] **预期**:`护栏 3/8` 报 `❌ service-role key 疑似以 NEXT_PUBLIC_ 暴露`(或"客户端组件疑似引用 service-role")
- [ ] 还原:`rm -rf web/app/probe`(若 `web/` 是为这条测试临时建的,一并 `rm -rf web`)

### B4 — 护栏1:🟡 留白功能前端(路径)必须被抓
- [ ] 塞探针:`mkdir -p web/app/broadcast && echo 'export default function P(){return null}' > web/app/broadcast/page.tsx`
- [ ] 跑:`bash ./check-boundaries.sh`
- [ ] **预期**:`护栏 1/8` 报 `❌ 越界前端文件(路径):...broadcast...`
- [ ] 还原:`rm -rf web/app/broadcast`

### B5 — 护栏5:DB 权威校验真的连上库(不是 SKIP)+ 漏开 RLS 被抓
> 这条最重要:确认 `supabase start` 后 DB 路径真活、且能抓"建表没开 RLS"。
- [ ] 塞探针迁移(建表不开 RLS):
```bash
cat > supabase/migrations/9999_probe_norls.sql <<'SQL'
create table if not exists public.probe_norls (id int primary key);
SQL
```
- [ ] 跑(带 DB 开关与连接串):
```bash
RUN_DB_CHECKS=1 SUPABASE_DB_URL="$SUPABASE_DB_URL" bash ./check-boundaries.sh
```
- [ ] **预期**:`护栏 5/8` **不是** `⏭ SKIPPED`,而是 `❌ RLS 违规:NO_RLS:probe_norls ...`(证明:① DB 真连上了 ② 漏开 RLS 被抓)
- [ ] 还原:`rm supabase/migrations/9999_probe_norls.sql`,并 `supabase db reset --db-url "$SUPABASE_DB_URL"`(把探针表从库里清掉)

### B6 — 干净基线复跑(确认还原彻底)
- [ ] 全部探针删除后跑:`RUN_DB_CHECKS=1 SUPABASE_DB_URL="$SUPABASE_DB_URL" bash ./check-boundaries.sh`
- [ ] **预期**:无 `❌`;早期阶段(尚无 web/migrations)各段为 `⏭ SKIPPED`,总判 `✅ 护栏全过`
- [ ] `git status --short` 干净(无残留探针文件、无误加进 git 的东西)

---

## C. Phase 0 验收(先只跑到 Phase 0 结束,停下人工验)

> Phase 0 = 0.1–0.6(脚手架 + 测试框架 + 护栏 + 测试 DB),共 6 个任务。把 `MAX_ITERS` 设一个刚够跑完的小值,跑完停下人工核对,**别一上来全放开**。

### C1 — 小步跑 Phase 0
- [ ] 在隔离环境、已 `export SUPABASE_DB_URL` 的终端:
```bash
MAX_ITERS=12 ./run-agent.sh 2>&1 | tee bootstrap-phase0.log
```
- [ ] 跑完后看 `TASKS.md`:0.1–0.6 应为 `[x]`(若有 `[~]` = 被跳过,需查 `BLOCKERS.md`)

### C2 — 测试 DB 真起来 + 迁移机制可用
- [ ] `supabase status` 显示服务在跑
- [ ] DB 可连:`psql "$SUPABASE_DB_URL" -c "select 1;"`
- [ ] `supabase db reset --db-url "$SUPABASE_DB_URL"` 能跑通(Phase 0 尚无业务迁移,应空跑成功;**真正的迁移 apply 验证留到 1.1 之后**)
- [ ] Vitest smoke 绿:`( cd web && pnpm test )`
- [ ] web 三件套绿:`( cd web && pnpm typecheck && pnpm lint && pnpm build )`

### C3 — 编排器的"打勾/回退/跳过"按预期(故意让一个任务失败)
> 目的:确认门禁失败时编排器**回退本轮 + 不打勾 + 重试到上限后标 `[~]`**,而不是错误打勾。用一个确定性失败的探针,不依赖 agent 表现。
- [ ] 在 `TASKS.md` 顶部(Phase 0 之前)临时插一个会失败的探针任务:
```
- [ ] **0.0 PROBE 故意失败**【🟢】
  - 让 agent 在 web/app/ 下建一个文件 `web/app/broadcast/page.tsx`(内容随意)。
  - 【验收】N/A 【测试】N/A
```
  （`broadcast` 会触发护栏1 越界 → 门禁必失败,与 agent 写得好不好无关）
- [ ] 单独小跑:`MAX_ITERS=3 MAX_RETRY=2 ./run-agent.sh 2>&1 | tee bootstrap-probe.log`
- [ ] **预期**(看日志 + 结果):
  - 每轮末 `❌ 轮末门禁失败 ... → 回退本轮 commit`(`git reset`)
  - 连续 `MAX_RETRY=2` 次后 `⛔ 任务 0.0 超重试上限 → 标 [~] 跳过` + `🔔 NOTIFY`
  - `TASKS.md` 里 0.0 变成 `[~]`(**不是 `[x]`**);`web/app/broadcast/` 已被回退删除
  - `BLOCKERS.md` 有 0.0 的失败记录
- [ ] 还原:从 `TASKS.md` 删掉 0.0 探针;`rm -f .agent-state/0.0.att bootstrap-probe.log`;`git status` 确认干净
- [ ] (备选确定性测法)若想脱离 agent 验门禁:临时 `git add -f .env.local`(让护栏4 必失败)→ 跑一轮 → 看是否回退/不打勾 → `git rm --cached .env.local && rm .env.local`

### C4 — check-boundaries 在真实仓库状态下跑通
- [ ] Phase 0 完成后(web 已建、仍无业务迁移):`RUN_DB_CHECKS=1 SUPABASE_DB_URL="$SUPABASE_DB_URL" bash ./check-boundaries.sh`
- [ ] **预期**:web 相关段(护栏1/3/8)真跑且 `✅`;migration 相关段(护栏2/5/6)`⏭ SKIPPED`(还没业务迁移,正常);总判 `✅`

**C 全绿 = 地基与护栏在真实环境可信,可进 D。**

---

## D. 放开无人值守(Phase 0 验过后全跑)

### D1 — 全跑
- [ ] 后台跑(容器内,断连不中断):
```bash
nohup ./run-agent.sh > agent-logs/run.out 2>&1 &     # 或 tmux/screen
```
（默认 `MAX_ITERS=80`、`MAX_RETRY=3`;按需 `MAX_ITERS=120 ./run-agent.sh`）

### D2 — 跑起来后定期看什么
- [ ] **进度**:`grep -cE '^\s*-\s*\[ \]' TASKS.md`(剩余)、`grep -cE '^\s*-\s*\[~\]' TASKS.md`(**被跳过=需人审,重点**)
- [ ] **实时日志**:`tail -f agent-logs/*.log`(看每轮"✅ 打勾 / ❌ 回退 / ⛔ 跳过")
- [ ] **BLOCKERS.md**:`tail -50 BLOCKERS.md`——同一任务反复出现 = 卡住了,去看它的日志
- [ ] **提交流**:`git -c core.pager=cat log --oneline -30`(每任务一组 commit + `chore: mark [x]`)
- [ ] **重点盯前几个 [SECURITY] 产出**(地基安全的核心):
  - `1.3 / 1.4`:RLS + anon 收敛(看护栏5 DB 权威校验是否真通过)
  - `1.5.0`:`guest_unlock_status` helper + 它的对抗测试(护栏7 轮末二道闸是否真跑)
  - `1.5a–1.5e`:5 个 RPC 的独立测试是否真覆盖 TEST-SPEC 对应小节(别只看绿,抽查 `web/**/*.test.ts` 内容是否真断言了 location_text / 私密直调被拒 / 裸 contact 不接管 等)
- [ ] **被跳过的任务**:出现 `[~]` 就去看对应 `BLOCKERS.md` + 日志,人工决定补/改/跳

### D3 — 真跑飞了怎么回滚
> 编排器**每任务一组 commit**,所以可以回退到任意任务边界。
- [ ] 看历史定位最后一个"好"提交:`git -c core.pager=cat log --oneline -50`
- [ ] **软回退某几轮**(保留工作树改动以便查看):`git reset --soft <good-commit>`
- [ ] **硬回退到干净点**(丢弃之后所有改动):`git reset --hard <good-commit>`
- [ ] **只撤某一坏提交**:`git revert <bad-commit>`
- [ ] **重置某任务的重试计数**(想让它从头再来):`rm -f .agent-state/<任务号>.att`(如 `.agent-state/1.5a.att`)
- [ ] **整体重来**:`git reset --hard <Phase0 完成点>` + `rm -rf .agent-state` + `supabase db reset --db-url "$SUPABASE_DB_URL"`
- [ ] 紧急刹车:`pkill -f run-agent.sh`(或 `kill %1`);它是逐任务推进,停下不会留半完成的打勾(打勾只在门禁通过后由编排器做)

### D4 — 完成判定
- [ ] `TASKS.md` 无 `[ ]` 残留;`[~]`(跳过)清单都已人工处理
- [ ] `( cd web && pnpm test )` 全绿;`RUN_DB_CHECKS=1 SUPABASE_DB_URL=... bash ./check-boundaries.sh` 全绿
- [ ] 对照 CLAUDE.md 安全清单 + 复核报告 D1–D16/G1–G8 逐条过(6.4 任务也会做,但你自己再核一遍)

---

> 备注:本清单只覆盖"开跑前 + 监控/回滚"。具体功能验收以 `TASKS.md` 各任务的【验收】【测试】+ `TEST-SPEC.md` 断言为准。
> 已知次要项(本轮未改,记录在案,不阻塞):护栏8 每次都跑 build(非仅 web 触及)· 护栏6 helper-grep 是启发式 · diff 闸只比 commit(测试 agent 改实现但不 commit 可绕过)。跑起来后留意这三处即可。
