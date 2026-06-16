#!/usr/bin/env bash
# check-boundaries.sh — 静态护栏门禁。每个任务 commit 前由 run-agent.sh 自动跑。
# 任一检查失败 → 退出码 1 → 该任务判失败、写 BLOCKERS、不打勾。
# 这些是机器可精确验证的"形式"边界;语义边界由 TEST-SPEC 的测试覆盖。

set -uo pipefail
FAIL=0
WEB="web"
say()  { echo "  $1"; }
bad()  { echo "  ❌ $1"; FAIL=1; }
ok()   { echo "  ✅ $1"; }

echo "── 护栏 1/6:禁止越界文件(🟡 留白功能不得有前端)──"
# 🟡 功能即便表已建,MVP 不得出现其前端实现。出现即越界。
BLACKLIST_PATHS=(
  "questionnaire" "questions" "survey"        # 问卷
  "photo-album" "photoalbum" "gallery"        # 相册
  "reaction" "reactions"                       # 评论反应
  "cohost" "co-host" "manage-hosts"            # co-host 管理
  "broadcast" "text-blast" "textblast"         # 群发
  "reminder-settings" "auto-reminder"          # 自动提醒设置
  "approval" "guest-approval"                   # 审核
)
if [ -d "$WEB/app" ] || [ -d "$WEB/components" ]; then
  for p in "${BLACKLIST_PATHS[@]}"; do
    HITS=$(find "$WEB/app" "$WEB/components" -type f \( -name "*.tsx" -o -name "*.ts" \) 2>/dev/null | grep -i "$p" || true)
    if [ -n "$HITS" ]; then bad "发现越界前端文件(🟡 功能 '$p'):$HITS"; fi
  done
  [ "$FAIL" -eq 0 ] && ok "无越界前端文件"
else
  say "(web 前端尚未创建,跳过)"
fi

echo "── 护栏 2/6:slug 必须密码学安全 ──"
SQLDIR="supabase/migrations"
if ls "$SQLDIR"/*.sql >/dev/null 2>&1; then
  # 若有 slug 生成逻辑,必须含 gen_random_bytes
  if grep -ril "slug" "$SQLDIR" >/dev/null 2>&1; then
    if grep -rl "gen_random_bytes" "$SQLDIR" >/dev/null 2>&1; then
      ok "slug 使用 gen_random_bytes"
    else
      # slug 生成可能在 TS;再查 web
      if grep -rl "gen_random_bytes\|crypto.randomBytes\|crypto.getRandomValues" "$WEB" 2>/dev/null >/dev/null; then
        ok "slug 使用密码学随机源(TS 侧)"
      else
        bad "未发现密码学随机源(gen_random_bytes/crypto)用于 slug"
      fi
    fi
  fi
  # slug 上下文禁用 random()
  if grep -rn "slug" "$SQLDIR" 2>/dev/null | grep -i "[^_]random()" >/dev/null; then
    bad "slug 生成疑似使用了不安全的 random()"
  fi
else
  say "(无 migration,跳过)"
fi

echo "── 护栏 3/6:禁用模式 ──"
if [ -d "$WEB" ]; then
  # 3a 无 localStorage 之外的浏览器存储违规(localStorage 本身按 CLAUDE.md 允许用于 guest_token)
  #    但 artifact 铁律禁 sessionStorage;此处放行 localStorage,禁 sessionStorage
  if grep -rn "sessionStorage" "$WEB/app" "$WEB/components" 2>/dev/null | grep -v "// allow" >/dev/null; then
    bad "使用了 sessionStorage(禁用)"
  else ok "无 sessionStorage"; fi
  # 3b service-role key 不进客户端:NEXT_PUBLIC_ 前缀不得带 SERVICE_ROLE
  if grep -rn "NEXT_PUBLIC_.*SERVICE_ROLE\|NEXT_PUBLIC_.*service_role" "$WEB" 2>/dev/null >/dev/null; then
    bad "service-role key 疑似以 NEXT_PUBLIC_ 暴露到客户端"
  else ok "service-role key 未暴露到客户端"; fi
  # 3c service.ts 不得被客户端组件 import('use client' 文件不得引 service)
  SERVICE_IN_CLIENT=$(grep -rl "lib/supabase/service" "$WEB" 2>/dev/null | xargs grep -l "\"use client\"\|'use client'" 2>/dev/null || true)
  if [ -n "$SERVICE_IN_CLIENT" ]; then bad "客户端组件引用了 service(受信角色):$SERVICE_IN_CLIENT"; else ok "service 仅服务端使用"; fi
fi

echo "── 护栏 4/6:不得提交密钥文件 ──"
if git ls-files 2>/dev/null | grep -E "\.env$|\.env\.local$" >/dev/null; then
  bad "提交了 .env / .env.local(禁止)"
else ok "无 .env 被提交"; fi

echo "── 护栏 5/6:每张表必须启用 RLS ──"
if ls "$SQLDIR"/*.sql >/dev/null 2>&1; then
  # 收集所有 create table 的表名,检查全局是否有对应 enable row level security
  TABLES=$(grep -rhi "create table" "$SQLDIR" 2>/dev/null | sed -E 's/.*create table[[:space:]]+(if not exists[[:space:]]+)?(public\.)?([a-zA-Z_]+).*/\3/I' | sort -u)
  ALLRLS=$(grep -rhi "enable row level security" "$SQLDIR" 2>/dev/null)
  MISSING=""
  for t in $TABLES; do
    if ! echo "$ALLRLS" | grep -qi "$t"; then MISSING="$MISSING $t"; fi
  done
  if [ -n "$MISSING" ]; then bad "以下表未启用 RLS:$MISSING"; else ok "所有表已启用 RLS"; fi
else
  say "(无 migration,跳过)"
fi

echo "── 护栏 6/6:类型检查 + lint + 构建 ──"
if [ -f "$WEB/package.json" ]; then
  ( cd "$WEB" && pnpm typecheck >/dev/null 2>&1 ) && ok "typecheck 通过" || bad "typecheck 失败"
  ( cd "$WEB" && pnpm lint >/dev/null 2>&1 )      && ok "lint 通过"      || bad "lint 失败"
  ( cd "$WEB" && pnpm build >/dev/null 2>&1 )     && ok "build 通过"     || bad "build 失败"
else
  say "(web 未初始化,跳过构建检查)"
fi

echo
if [ "$FAIL" -eq 0 ]; then echo "✅ 护栏全过"; exit 0; else echo "❌ 护栏失败,任务判定不通过"; exit 1; fi
