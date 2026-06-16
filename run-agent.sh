#!/usr/bin/env bash
# run-agent.sh v3 — 无人值守驱动 Claude Code 跑完 TASKS.md。
#
# 核心变更(复核 D11/G2):
#   - **打勾权在编排器,不在 agent**。agent 只实现/写测试/commit,绝不改 [x]。
#   - 轮末编排器跑 check-boundaries + 测试,过 → sed 打勾;不过 → git reset 回退本轮 + 记 BLOCKERS。
#   - 同一任务连续失败 ≥ MAX_RETRY → 标第三态 [~] 跳过、游标前移、真通知。
#   - [SECURITY]:实现 agent(禁改测试)+ 独立测试 agent(只准动 tests/,diff 闸);测试失败把失败断言注入下轮实现 agent。
#
# 强烈建议在 Docker/VM 中运行(用了 --dangerously-skip-permissions)。须 GNU 环境。
set -uo pipefail

MAX_ITERS="${MAX_ITERS:-80}"
MAX_RETRY="${MAX_RETRY:-3}"
LOG_DIR="agent-logs"; mkdir -p "$LOG_DIR"
STATE_DIR=".agent-state"; mkdir -p "$STATE_DIR"
export RUN_DB_CHECKS=1

notify() { echo "🔔 NOTIFY: $1"; [ -n "${NOTIFY_CMD:-}" ] && "${NOTIFY_CMD}" "$1" >/dev/null 2>&1 || true; }

echo "── preflight ──"
PREFAIL=0
for c in claude pnpm git supabase docker psql; do
  command -v "$c" >/dev/null 2>&1 && echo "  ✅ $c" || { echo "  ❌ 缺 $c"; PREFAIL=1; }
done
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "  ⚠ git 未初始化 → git init + .gitignore"; git init -q && printf ".env\n.env.*\nnode_modules/\n.next/\n" >> .gitignore
fi
git config user.email >/dev/null 2>&1 || git config user.email "agent@local"
git config user.name  >/dev/null 2>&1 || git config user.name  "unattended-agent"
DBURL="${SUPABASE_DB_URL:-${DATABASE_URL:-}}"
[ -z "$DBURL" ] && { echo "  ❌ 缺 SUPABASE_DB_URL/DATABASE_URL"; PREFAIL=1; }
if [ -n "$DBURL" ] && command -v psql >/dev/null 2>&1; then
  psql "$DBURL" -c "select 1" >/dev/null 2>&1 && echo "  ✅ DB 可连" || { echo "  ❌ DB 连不上"; PREFAIL=1; }
fi
[ "$PREFAIL" -eq 1 ] && { notify "preflight 失败,终止"; exit 1; }

remaining()      { grep -cE '^[[:space:]]*-[[:space:]]*\[ \]' TASKS.md 2>/dev/null || true; }
next_task_line() { grep -nE '^[[:space:]]*-[[:space:]]*\[ \]' TASKS.md 2>/dev/null | head -1; }
is_security()    { printf '%s' "$1" | grep -q '\[SECURITY\]'; }
task_id()        { printf '%s' "$1" | sed -nE 's/.*\*\*([0-9]+\.?[0-9a-z]*).*/\1/p'; }

# mark <lineno> <to: x|~>
mark() {
  local ln="$1" to="$2"
  sed -i "${ln}s/^\([[:space:]]*-[[:space:]]*\)\[ \]/\1[$to]/" TASKS.md
  git add TASKS.md && git commit -q -m "chore: mark task [$to] (line $ln)" || true
}

COMMON="读 CLAUDE.md、SCHEMA.md(数据模型+安全逐字段边界)、TASKS.md。前端任务另读 DESIGN-TONE.md 与 frontend-design SKILL.md。安全任务断言见 TEST-SPEC.md。绝不提交密钥;绝不削弱 RLS;🟡 功能只建表不做前端;承载安全/数据语义的行为必须正确。**绝不自己改 TASKS.md 的 [ ]→[x](打勾由编排器做)。**"

run_claude() { claude --dangerously-skip-permissions -p "$1" 2>&1 | tee -a "$LOG_DIR/$TS.log"; }

iter=0
while true; do
  left="$(remaining)"; left="${left:-0}"
  [ "$left" -eq 0 ] && { echo "✅ 全部任务完成。"; break; }
  [ "$iter" -ge "$MAX_ITERS" ] && { notify "达到 MAX_ITERS=$MAX_ITERS,剩 $left。"; break; }
  iter=$((iter+1)); TS="$(date +%Y%m%d-%H%M%S)"
  LINE_RAW="$(next_task_line)"
  LN="${LINE_RAW%%:*}"; LINE="${LINE_RAW#*:}"
  TID="$(task_id "$LINE")"; [ -z "$TID" ] && TID="line$LN"
  ATT_FILE="$STATE_DIR/$TID.att"; ATT=$(cat "$ATT_FILE" 2>/dev/null || echo 0)
  echo "▶ 迭代 $iter — 剩 $left — 任务 $TID(尝试 $((ATT+1))/$MAX_RETRY)— 行 $LN — 日志 $LOG_DIR/$TS.log"

  BASELINE="$(git rev-parse HEAD 2>/dev/null || echo '')"
  BLOCK_HINT=""
  [ -f "BLOCKERS.md" ] && BLOCK_HINT="若 BLOCKERS.md 有本任务($TID)的失败断言,先读它并逐条修复。"

  if is_security "$LINE"; then
    echo "  🔒 [SECURITY] → 实现 agent + 独立测试 agent"
    run_claude "你是【实现工程师】,完成 TASKS.md 任务 $TID 的【实现部分】。
$COMMON
$BLOCK_HINT
规则:只写实现代码,**不得编写或修改任何测试文件**。严守该任务【禁止】项与 SCHEMA 安全边界。完成后跑 ./check-boundaries.sh 修到过。**不打勾、不声称完成**,做一次 commit(feat/db:)后停止。无法完成则写 BLOCKERS.md 并停,不要瞎编、不要问我。"
    IMPL_HEAD="$(git rev-parse HEAD 2>/dev/null || echo '')"
    run_claude "你是【测试工程师】,**没写过这段实现**。针对任务 $TID 写并跑**对抗性测试**,严格按 TEST-SPEC 对应小节,可加更狠边界。
$COMMON
规则:**只准在 tests/(或 web/**/__tests__、*.test.ts)下写文件,绝不改任何实现文件**。以怀疑心态戳分级返回/容量/去重/contact 泄露/权限。跑测试与 ./check-boundaries.sh。**不打勾**;有失败 → 把失败断言记入 BLOCKERS.md(标任务 $TID)。commit(test:)后停止。不要改实现绕测试、不要问我。"
    # diff 闸:测试回合不得改实现文件(tests/ 之外)
    if [ -n "$IMPL_HEAD" ]; then
      DIRTY=$(git diff --name-only "$IMPL_HEAD" HEAD 2>/dev/null | grep -vE '(^|/)(tests?|__tests__)/|\.test\.|\.spec\.' || true)
      [ -n "$DIRTY" ] && { echo "  ⚠ 测试回合改了实现文件:$DIRTY → 判失败回退"; }
    fi
  else
    echo "  🟢 普通任务 → 单轮 TDD"
    run_claude "你是工程师,用 TDD 完成 TASKS.md 任务 $TID。
$COMMON
$BLOCK_HINT
流程:1) 先写会失败的测试(红);2) 实现至绿(若【测试】N/A 则以 build/typecheck 验);3) 跑 ./check-boundaries.sh 修到过;4) **不打勾**,commit(feat/db:)后停止。只做这一个任务。无法完成则写 BLOCKERS.md 并停。"
  fi

  # ── 轮末:编排器强制门禁(唯一打勾/回退处)──
  PASS=1
  # ROUND_END=1 仅本次调用置位(不 export → agent 自检不继承),启用护栏7 helper-coverage 硬门禁
  if [ -x ./check-boundaries.sh ]; then ROUND_END=1 ./check-boundaries.sh >>"$LOG_DIR/$TS.log" 2>&1 || PASS=0; fi
  # 仅当 web 已有 "test" 脚本时才跑测试(0.1/0.2 阶段 Vitest 尚未装,跑了必假失败→M2)
  if [ -f "web/package.json" ] && grep -qE '"test"[[:space:]]*:' web/package.json; then
    ( cd web && pnpm test >>"../$LOG_DIR/$TS.log" 2>&1 ) || PASS=0
  fi
  # 测试回合篡改实现 → 强制失败
  if is_security "$LINE" && [ -n "${DIRTY:-}" ]; then PASS=0; fi

  if [ "$PASS" -eq 1 ]; then
    echo "  ✅ 轮末门禁通过 → 编排器打勾"
    rm -f "$ATT_FILE"
    mark "$LN" "x"
  else
    ATT=$((ATT+1)); echo "$ATT" > "$ATT_FILE"
    echo "  ❌ 轮末门禁失败(尝试 $ATT/$MAX_RETRY)→ 回退本轮 commit"
    [ -n "$BASELINE" ] && git reset --hard "$BASELINE" >/dev/null 2>&1 || true
    { echo "## [$(date +%F\ %T)] 任务 $TID 第 $ATT 次失败(行 $LN)"; echo "见日志 $LOG_DIR/$TS.log"; } >> BLOCKERS.md
    git add BLOCKERS.md && git commit -q -m "chore: BLOCKERS $TID attempt $ATT" || true
    if [ "$ATT" -ge "$MAX_RETRY" ]; then
      echo "  ⛔ 任务 $TID 超重试上限 → 标 [~] 跳过"
      mark "$LN" "~"; rm -f "$ATT_FILE"
      notify "任务 $TID 连续 $MAX_RETRY 次失败,已标 [~] 跳过,需人审。"
    fi
  fi
  sleep 1
done

echo; echo "Summary:"
echo "  剩余 [ ]:$(remaining)"
echo "  跳过 [~]:$(grep -cE '^[[:space:]]*-[[:space:]]*\[~\]' TASKS.md 2>/dev/null || echo 0)"
echo "  本次提交:"; git -c core.pager=cat log --oneline -n 30
