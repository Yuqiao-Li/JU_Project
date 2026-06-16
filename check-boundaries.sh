#!/usr/bin/env bash
# check-boundaries.sh v2 — 静态 + DB 权威护栏门禁。每个任务 commit 前由 run-agent.sh 自动跑。
# 任一检查失败 → 退出码 1 → 该任务判失败、写 BLOCKERS、编排器不打勾。
# 形式边界机器精确验证;语义边界由 TEST-SPEC 的测试覆盖。
# 需要 GNU 环境(grep/sed)。SKIPPED 与 PASSED 显式区分。

set -uo pipefail
command -v grep >/dev/null 2>&1 || { echo "no grep"; exit 1; }
grep --version 2>/dev/null | grep -qi gnu || echo "  ⚠ 非 GNU grep,正则行为可能不符(建议在 Linux/容器跑)"

FAIL=0
WEB="web"
SQLDIR="supabase/migrations"
say()  { echo "  $1"; }
skip() { echo "  ⏭ SKIPPED: $1"; }
bad()  { echo "  ❌ $1"; FAIL=1; }
ok()   { echo "  ✅ $1"; }

have_migrations() { ls "$SQLDIR"/*.sql >/dev/null 2>&1; }

echo "── 护栏 0/8:git 必须已初始化(密钥护栏前提)──"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  ok "git 仓库存在"
  GIT_OK=1
else
  bad "git 未初始化 —— 密钥护栏无法生效(应 git init + .gitignore 含 .env*)"
  GIT_OK=0
fi

echo "── 护栏 1/8:禁止越界文件(🟡 留白功能不得有前端;路径段 + 内容)──"
# 黑名单:留白功能的路由段 + 代码内标识(组件名/RPC 名),覆盖下划线/camelCase/复数
BLACKLIST_RE='questionnaire|survey|photo[-_]?album|gallery|reaction|cohost|co[-_]?host|manage[-_]?hosts|broadcast|text[-_]?blast|reminder[-_]?settings|auto[-_]?reminder|guest[-_]?approval'
CONTENT_RE='Questionnaire|CommentReaction|PhotoAlbum|CoHost|Broadcast|TextBlast|ReminderSettings|GuestApproval|insert into answers|insert into comment_reactions|insert into event_photos|insert into broadcasts'
if [ -d "$WEB/app" ] || [ -d "$WEB/components" ]; then
  # 路径段(用 / 边界,避免对通用英语词裸子串误杀)
  PHITS=$(find "$WEB/app" "$WEB/components" -type f \( -name "*.tsx" -o -name "*.ts" \) 2>/dev/null \
            | grep -iE "(^|/)([a-z0-9-]*($BLACKLIST_RE)[a-z0-9-]*)(/|\.)" || true)
  # 内容(扫文件内的留白功能标识)
  CHITS=$(grep -rlEi "$CONTENT_RE" "$WEB/app" "$WEB/components" 2>/dev/null || true)
  if [ -n "$PHITS" ]; then bad "越界前端文件(路径):$PHITS"; fi
  if [ -n "$CHITS" ]; then bad "越界前端内容(留白功能标识):$CHITS"; fi
  [ "$FAIL" -eq 0 ] && ok "无越界前端"
else
  skip "web 前端尚未创建"
fi

echo "── 护栏 2/8:slug 必须密码学安全(函数体内)──"
if have_migrations; then
  if grep -rliE "function[[:space:]]+[a-z_]*slug|generate_slug|gen_slug" "$SQLDIR" >/dev/null 2>&1 \
     || grep -rli "slug" "$SQLDIR" >/dev/null 2>&1; then
    if grep -rl "gen_random_bytes" "$SQLDIR" >/dev/null 2>&1; then
      ok "slug 使用 gen_random_bytes"
    else
      bad "未发现 gen_random_bytes 用于 slug"
    fi
    # 禁不安全来源(锚定,排除 gen_random_*)
    if grep -rnE "(^|[^_a-z])random[[:space:]]*\(" "$SQLDIR" 2>/dev/null | grep -v "gen_random" >/dev/null; then
      bad "slug 上下文疑似使用了不安全的 random()"
    fi
    if grep -rniE "now\(\)|current_timestamp|nextval\(|timeofday\(" "$SQLDIR" 2>/dev/null \
         | grep -i "slug" >/dev/null; then
      bad "slug 疑似时间戳/自增派生(禁止)"
    fi
  else
    skip "无 slug 逻辑"
  fi
else
  skip "无 migration"
fi

echo "── 护栏 3/8:禁用模式 ──"
if [ -d "$WEB" ]; then
  # 3a sessionStorage(全 web,排除 node_modules/.next;无 // allow 逃逸;含间接形式)
  if grep -rnE "sessionStorage|\[[\"']sessionStorage[\"']\]" "$WEB" \
        --include="*.ts" --include="*.tsx" \
        --exclude-dir=node_modules --exclude-dir=.next 2>/dev/null >/dev/null; then
    bad "使用了 sessionStorage(禁用)"
  else ok "无 sessionStorage"; fi
  # 3b service-role 不进客户端:NEXT_PUBLIC_*SERVICE_ROLE、客户端可达模块引用 service env、硬编码 JWT
  if grep -rnE "NEXT_PUBLIC_[A-Z_]*SERVICE_ROLE|NEXT_PUBLIC_[A-Z_]*=[A-Za-z0-9._-]*service_role" "$WEB" 2>/dev/null >/dev/null; then
    bad "service-role key 疑似以 NEXT_PUBLIC_ 暴露"
  else ok "service-role 未经 NEXT_PUBLIC_ 暴露"; fi
  # 客户端组件('use client')里直接引用 service-role env 或硬编码 JWT
  CLIENTFILES=$(grep -rlE "['\"]use client['\"]" "$WEB" --include="*.tsx" --include="*.ts" --exclude-dir=node_modules --exclude-dir=.next 2>/dev/null || true)
  if [ -n "$CLIENTFILES" ]; then
    if echo "$CLIENTFILES" | xargs -r grep -lE "SERVICE_ROLE|service_role|eyJ[A-Za-z0-9_-]{20,}" 2>/dev/null | grep -q .; then
      bad "客户端组件疑似引用 service-role / 硬编码 JWT"
    else ok "客户端组件无 service-role 引用"; fi
  fi
  # 3c service.ts 不得被客户端组件 import(覆盖 @/lib 与相对路径;xargs -r 防空输入)
  SVC=$(grep -rlE "lib/supabase/service|\.\./service" "$WEB" --include="*.ts" --include="*.tsx" --exclude-dir=node_modules --exclude-dir=.next 2>/dev/null || true)
  if [ -n "$SVC" ]; then
    INCLIENT=$(echo "$SVC" | xargs -r grep -lE "['\"]use client['\"]" 2>/dev/null || true)
    if [ -n "$INCLIENT" ]; then bad "客户端组件引用了 service(受信角色):$INCLIENT"; else ok "service 仅服务端使用"; fi
  fi
else
  skip "web 未初始化(禁用模式检查)"
fi

echo "── 护栏 4/8:不得提交密钥文件 ──"
if [ "$GIT_OK" -eq 1 ]; then
  if git ls-files 2>/dev/null | grep -E "(^|/)\.env(\..+)?$|\.pem$|.*serviceaccount.*\.json$|.*credentials.*" >/dev/null; then
    bad "提交了密钥文件(.env*/.pem/serviceaccount.json/credentials)"
  else ok "无密钥文件被提交"; fi
  # 内容兜底:被 track 文件里硬编码 service-role JWT
  if git grep -lE "eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}" -- "$WEB" 2>/dev/null | grep -q .; then
    bad "疑似硬编码 JWT/service key 进了被 track 文件"
  fi
else
  bad "git 未初始化,密钥护栏跳过=不可信(判失败)"
fi

echo "── 护栏 5/8:DB 权威 RLS 校验(每表 RLS+策略;anon 无客数据表策略;无 using(true);storage)──"
# 复用 D10 本地库:RUN_DB_CHECKS=1 且 psql + 连接串可用时,apply 迁移到 DB 再查 pg_catalog。
DBURL="${SUPABASE_DB_URL:-${DATABASE_URL:-}}"
if have_migrations && [ "${RUN_DB_CHECKS:-0}" = "1" ] && command -v psql >/dev/null 2>&1 && [ -n "$DBURL" ]; then
  # 重置/应用迁移(优先 supabase db reset;否则假设已 apply)
  if command -v supabase >/dev/null 2>&1; then supabase db reset --db-url "$DBURL" >/dev/null 2>&1 || true; fi
  CLIENT_TABLES="'events','guests','rsvps','comments','date_votes','date_options','answers','questions','comment_reactions','event_photos','scheduled_reminders','broadcasts','rate_limits'"
  RLS_SQL=$(cat <<SQL
\set ON_ERROR_STOP on
-- 1) public 表未启用 RLS
select 'NO_RLS:'||c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relkind='r' and not c.relrowsecurity;
-- 2) 启用 RLS 但无任何 policy
select 'NO_POLICY:'||c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relkind='r' and c.relrowsecurity
   and not exists (select 1 from pg_policies p where p.schemaname='public' and p.tablename=c.relname);
-- 3) 全放行谓词 using(true)/with check(true)
select 'PERMISSIVE_TRUE:'||tablename||'.'||policyname from pg_policies
 where schemaname='public' and (coalesce(qual,'')='true' or coalesce(with_check,'')='true');
-- 4) G1:客数据表上有授予 anon/public 角色的策略
select 'ANON_POLICY:'||tablename||'.'||policyname from pg_policies
 where schemaname='public' and tablename in ($CLIENT_TABLES)
   and (roles && array['anon','public']::name[]);
-- 5) G8:storage.objects 必须有策略(且不是全放行)
select 'STORAGE_NO_POLICY' where not exists
 (select 1 from pg_policies where schemaname='storage' and tablename='objects');
select 'STORAGE_PERMISSIVE:'||policyname from pg_policies
 where schemaname='storage' and tablename='objects' and (coalesce(qual,'')='true' or coalesce(with_check,'')='true');
SQL
)
  OFFENDERS=$(psql "$DBURL" -At -v ON_ERROR_STOP=1 -c "$RLS_SQL" 2>/dev/null || echo "PSQL_ERROR")
  if [ "$OFFENDERS" = "PSQL_ERROR" ]; then
    bad "DB 权威校验执行失败(psql/连接/迁移问题)"
  elif [ -n "$OFFENDERS" ]; then
    bad "RLS 违规:$(echo "$OFFENDERS" | tr '\n' ' ')"
  else
    ok "DB 权威 RLS 校验通过(每表 RLS+策略、anon 无客数据表策略、无 using(true)、storage 有策略)"
  fi
else
  if have_migrations; then skip "DB 权威校验未运行(需 RUN_DB_CHECKS=1 + psql + SUPABASE_DB_URL)"; else skip "无 migration(RLS 校验)"; fi
fi

echo "── 护栏 6/8:共享门禁 helper 必须被三处 RPC 复用(G4)──"
if have_migrations && grep -rl "guest_unlock_status" "$SQLDIR" >/dev/null 2>&1; then
  MISS=""
  for fn in get_event_by_slug get_guest_list add_comment; do
    # 该函数的 CREATE FUNCTION 块内须出现 guest_unlock_status( 调用
    BLOCK=$(awk "BEGIN{IGNORECASE=1} /create[ ]+(or[ ]+replace[ ]+)?function[ ]+(public\.)?$fn/{f=1} f{print} /\\\$\\\$[ ]*;?[ ]*\$/{if(f&&seen)exit; if(f)seen=1}" "$SQLDIR"/*.sql 2>/dev/null)
    if [ -n "$BLOCK" ]; then
      echo "$BLOCK" | grep -q "guest_unlock_status(" || MISS="$MISS $fn"
    fi
  done
  if [ -n "$MISS" ]; then bad "以下 RPC 未调用共享门禁 helper(疑自行实现门禁):$MISS"; else ok "门禁 helper 被三处 RPC 复用"; fi
elif have_migrations; then
  skip "helper 尚未出现(RPC 未实现)"
else
  skip "无 migration(helper 检查)"
fi

echo "── 护栏 7/8:测试存在性 + 防空测试(二道闸,m2)──"
# find 取代脆弱的 ** glob;两条硬门禁 + 阶段关键字告警
TESTGLOB=$(find "$WEB" tests -type f \( -name "*.test.ts" -o -name "*.test.tsx" -o -name "*.spec.ts" \) 2>/dev/null || true)
if [ -z "$TESTGLOB" ]; then
  skip "尚无测试文件"
else
  # (硬)防空测试:有测试文件却零断言(expect/assert)→ 失败
  if echo "$TESTGLOB" | xargs -r grep -lE "expect\(|assert" 2>/dev/null | grep -q .; then
    ok "测试含断言"
  else
    bad "存在测试文件但无任何断言(expect/assert)—— 疑似空测试"
  fi
  # 门禁 helper 已落却无测试引用它 → 失败,但**仅轮末编排器强制**(ROUND_END=1)。
  # 实现 agent 自检时降为提示:[SECURITY] 任务测试在另一回合(测试 agent)写,实现回合此处必然尚无。
  if have_migrations && grep -rl "guest_unlock_status" "$SQLDIR" >/dev/null 2>&1; then
    if echo "$TESTGLOB" | xargs -r grep -l "guest_unlock_status" 2>/dev/null | grep -q .; then
      ok "门禁 helper 有测试引用"
    elif [ "${ROUND_END:-0}" = "1" ]; then
      bad "guest_unlock_status 已实现但无测试引用它(轮末二道闸)"
    else
      say "(提示)guest_unlock_status 尚无测试引用(测试回合应补;轮末强制)"
    fi
  fi
  # (软)阶段相关关键字:仅告警,早期阶段未覆盖属正常
  MISSING_KW=""
  for kw in location_text waitlisted not_going; do
    echo "$TESTGLOB" | xargs -r grep -l "$kw" 2>/dev/null | grep -q . || MISSING_KW="$MISSING_KW $kw"
  done
  [ -n "$MISSING_KW" ] && say "(提示)测试中尚未出现关键字:$MISSING_KW"
fi

echo "── 护栏 8/8:类型检查 + lint + build(仅 web 触及时)──"
if [ -f "$WEB/package.json" ]; then
  # 禁止用 ignore 偷偷削弱
  if grep -rnE "ignoreBuildErrors|ignoreDuringBuilds" "$WEB"/next.config.* 2>/dev/null >/dev/null; then
    bad "next.config 含 ignoreBuildErrors/ignoreDuringBuilds(禁止)"
  fi
  has_script() { grep -qE "\"$1\"[[:space:]]*:" "$WEB/package.json"; }
  if has_script typecheck; then ( cd "$WEB" && pnpm typecheck >/tmp/tc.log 2>&1 ) && ok "typecheck 通过" || { bad "typecheck 失败"; tail -5 /tmp/tc.log; }
  else bad "缺 typecheck 脚本"; fi
  if has_script lint; then ( cd "$WEB" && pnpm lint >/tmp/ln.log 2>&1 ) && ok "lint 通过" || { bad "lint 失败"; tail -5 /tmp/ln.log; }
  else bad "缺 lint 脚本"; fi
  ( cd "$WEB" && pnpm build >/tmp/bd.log 2>&1 ) && ok "build 通过" || { bad "build 失败"; tail -5 /tmp/bd.log; }
else
  skip "web 未初始化(构建检查)"
fi

echo
if [ "$FAIL" -eq 0 ]; then echo "✅ 护栏全过"; exit 0; else echo "❌ 护栏失败,任务判定不通过"; exit 1; fi
