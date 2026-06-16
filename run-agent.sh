#!/usr/bin/env bash
# run-agent.sh v3 — 无人值守驱动 Claude Code 跑完 TASKS.md。
#
# 核心变更(复核 D11/G2):
#   - **打勾权在编排器,不在 agent**。agent 只实现/写测试/commit,绝不改 [x]。
#   - 轮末编排器跑 check-boundaries + 测试,过 → sed 打勾;不过 → git reset 回退本轮 + 记 BLOCKERS。
#   - 同一任务连续失败 ≥ MAX_RETRY → 标第三态 [~] 跳过、游标前移、真通知。
#   - [SECURITY]:实现 agent(禁改测试)+ 独立测试 agent(只准动 tests/,diff 闸);测试失败把失败断言注入下轮实现 agent。
#   - **额度耗尽 ≠ 任务失败,且全自动**:claude 报 usage/rate limit 时,不回退/不计失败/不标 [~](当前任务保持原样),
#     解析重置时间并 sleep 到点+5min(解析不到默认 5h5m),期间打心跳,醒来自动从第一个未勾选任务续跑——无需人工。
#     **周上限(weekly)例外**:不盲目睡一周 → 写 QUOTA-BLOCKED.md + exit,交你决定等/换 key。
#     **MAX_WALL_HOURS 总时长上限**兜底,防意外无限 sleep。
#     (测试:SIMULATE_QUOTA=N 在第 N 轮模拟一次额度耗尽 + 短 sleep,不真撞墙验证 检测→等待→续跑。)
#
# 强烈建议在 Docker/VM 中运行(用了 --dangerously-skip-permissions)。须 GNU 环境。
set -uo pipefail

MAX_ITERS="${MAX_ITERS:-200}"           # 大值,足够跑完整个 MVP;额度靠下面的睡眠机制管,不再靠它节流
MAX_RETRY="${MAX_RETRY:-3}"
MAX_WALL_HOURS="${MAX_WALL_HOURS:-72}"  # 总运行时长上限(含睡眠),防意外无限 sleep;超过即 exit
QUOTA_HEARTBEAT_SECS="${QUOTA_HEARTBEAT_SECS:-900}"  # 额度等待期间心跳间隔(默认 15min)
LOG_DIR="agent-logs"; mkdir -p "$LOG_DIR"
STATE_DIR=".agent-state"; mkdir -p "$STATE_DIR"
export RUN_DB_CHECKS=1
# 总时长起点:跨 re-exec(额度睡醒后自重启)保持不变,使 MAX_WALL_HOURS 真正封顶
START_EPOCH="${RUN_START_EPOCH:-$(date +%s)}"; export RUN_START_EPOCH="$START_EPOCH"

notify() { echo "🔔 NOTIFY: $1"; [ -n "${NOTIFY_CMD:-}" ] && "${NOTIFY_CMD}" "$1" >/dev/null 2>&1 || true; }

echo "── preflight ──"
PREFAIL=0
for c in claude pnpm git supabase docker psql; do
  command -v "$c" >/dev/null 2>&1 && echo "  ✅ $c" || { echo "  ❌ 缺 $c"; PREFAIL=1; }
done
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "  ⚠ git 未初始化 → git init + .gitignore"; git init -q && printf ".env\n.env.*\nnode_modules/\n.next/\n" >> .gitignore
fi
# 确保运行期产物不被 agent 的 git add -A 误提交(幂等;含额度状态文件)
ensure_ignored() { touch .gitignore 2>/dev/null || true; grep -qxF "$1" .gitignore 2>/dev/null || echo "$1" >> .gitignore; }
for p in ".env" ".env.*" "node_modules/" ".next/" "agent-logs/" ".agent-state/" "QUOTA-BLOCKED.md"; do ensure_ignored "$p"; done
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

# ── 额度/用量上限处理(额度耗尽 ≠ 任务失败;全自动睡到重置再续跑)──
# 关键守卫:仅在 claude **退出码非 0** 时才据输出判额度。本项目 agent 正常会大量讨论
# "限流 / rate limit / capacity limit / quota"等话题,**成功跑(rc=0)里出现这些词绝不能误判**。
# 两种额度分流:weekly(周上限,可能等到下周)→ 不盲目睡,写 QUOTA-BLOCKED.md + exit;
#              其余(5 小时滚动窗口 / 一般 usage / rate limit)→ 解析重置时间并 sleep 后自动续跑。
# 可用 QUOTA_WEEKLY_RE / QUOTA_SIGNAL_RE 覆盖措辞;CLAUDE_QUOTA_EXIT_CODE 可按专用退出码精确命中。
# 🧪 测试开关:SIMULATE_QUOTA=N 在第 N 轮模拟一次额度耗尽(默认 usage/5h;SIMULATE_QUOTA_KIND=weekly 测周上限分支),
#    usage 用 SIMULATE_QUOTA_SLEEP_SECS(默认 30s)短 sleep,跨 re-exec 只触发一次(SIMULATE_QUOTA_DONE)——不真撞墙验证整链路。
QUOTA_WEEKLY_RE="${QUOTA_WEEKLY_RE:-weekly limit|weekly usage|usage limit.*week|per week|this week|7[- ]day|resets? (next )?(monday|week)|weekly cap}"
QUOTA_SIGNAL_RE="${QUOTA_SIGNAL_RE:-usage limit|usage_limit|5[- ]hour limit|limit will reset|rate_limit_error|rate limit exceeded|too many requests|credit balance is too low|out of credits|insufficient_quota|quota exceeded}"

fmt_dur() { local s="$1"; [ "$s" -lt 0 ] && s=0; printf '%dh%02dm' $(( s/3600 )) $(( (s%3600)/60 )); }

quota_kind() {  # <rc> <file> → 打印 none|weekly|usage
  local rc="$1" file="$2"
  if [ -n "${CLAUDE_QUOTA_EXIT_CODE:-}" ] && [ "$rc" = "$CLAUDE_QUOTA_EXIT_CODE" ]; then
    { [ -f "$file" ] && grep -qiE "$QUOTA_WEEKLY_RE" "$file"; } && echo weekly || echo usage; return
  fi
  [ "$rc" -ne 0 ] || { echo none; return; }
  [ -f "$file" ] || { echo none; return; }
  grep -qiE "$QUOTA_WEEKLY_RE" "$file" && { echo weekly; return; }
  grep -qiE "$QUOTA_SIGNAL_RE" "$file" && { echo usage;  return; }
  echo none
}

# 从错误文本解析"重置时间"→ 打印目标 epoch(秒);解析不到则无输出 + 返回 1(交调用方走默认)
parse_reset_epoch() {
  local f="$1" ep s h m
  # 1) Claude 风格 "...usage limit reached|<epoch>" 或 reset 附近的 10 位 unix 时间戳
  ep="$(grep -oiE '(reached|reset[s]?( at)?|resetsat"?[: ]?)[^0-9]{0,12}[0-9]{10}' "$f" 2>/dev/null | grep -oE '[0-9]{10}' | tail -1)"
  if [ -n "$ep" ]; then echo "$ep"; return 0; fi
  # 2) 相对时间 "in 3 hours 20 minutes" / "try again in 45 minutes" / "in 2h"
  if grep -qiE 'in[[:space:]]+[0-9]+[[:space:]]?(hour|hr|h|minute|min|m)' "$f" 2>/dev/null; then
    h="$(grep -oiE '[0-9]+[[:space:]]?(hours?|hrs?|h)\b' "$f" | grep -oE '[0-9]+' | head -1)"
    m="$(grep -oiE '[0-9]+[[:space:]]?(minutes?|mins?|m)\b'  "$f" | grep -oE '[0-9]+' | head -1)"
    h="${h:-0}"; m="${m:-0}"
    if [ "$h" -gt 0 ] || [ "$m" -gt 0 ]; then echo $(( $(date +%s) + h*3600 + m*60 )); return 0; fi
  fi
  # 3) ISO 8601 时间戳(GNU date -d 解析)
  s="$(grep -oiE '[0-9]{4}-[0-9]{2}-[0-9]{2}[t ][0-9]{2}:[0-9]{2}(:[0-9]{2})?z?' "$f" 2>/dev/null | head -1)"
  if [ -n "$s" ]; then ep="$(date -d "$s" +%s 2>/dev/null || true)"; [ -n "$ep" ] && { echo "$ep"; return 0; }; fi
  # 4) 绝对时钟 "reset at 10pm" / "resets at 15:30"(GNU date -d;若已过则 +1 天)
  s="$(grep -oiE 'reset[s]?( at)?[[:space:]]+[0-9]{1,2}(:[0-9]{2})?[[:space:]]?(am|pm)?' "$f" 2>/dev/null | sed -E 's/.*reset[s]?( at)?[[:space:]]+//I' | head -1)"
  if [ -n "$s" ]; then ep="$(date -d "$s" +%s 2>/dev/null || true)"
    if [ -n "$ep" ]; then [ "$ep" -le "$(date +%s)" ] && ep=$(( ep + 86400 )); echo "$ep"; return 0; fi; fi
  return 1
}

# 睡到目标 epoch,期间按心跳间隔打印进度;尊重 MAX_WALL_HOURS(睡到上限就 exit)
sleep_until_with_heartbeat() {
  local target="$1" reason="$2" now rem chunk eta deadline
  deadline=$(( START_EPOCH + MAX_WALL_HOURS*3600 ))
  eta="$(date -d "@$target" '+%m-%d %H:%M' 2>/dev/null || echo '?')"
  echo "😴 额度耗尽($reason)。预计 $eta 恢复;每 ${QUOTA_HEARTBEAT_SECS}s 心跳一次。"
  notify "额度耗尽,自动睡到 $eta 续跑(MAX_WALL_HOURS=$MAX_WALL_HOURS 兜底)。"
  while :; do
    now="$(date +%s)"
    [ "$now" -ge "$target" ] && break
    if [ "$now" -ge "$deadline" ]; then
      echo "⛔ 已达总运行上限 MAX_WALL_HOURS=$MAX_WALL_HOURS,停止等待并退出。"; notify "达到 MAX_WALL_HOURS,退出。"; exit 77
    fi
    rem=$(( target - now ))
    echo "  ⏳ $(date '+%H:%M') 额度耗尽,等待重置中,预计 $eta 恢复(剩 $(fmt_dur "$rem"))"
    chunk="$QUOTA_HEARTBEAT_SECS"
    [ "$rem" -lt "$chunk" ] && chunk="$rem"
    [ $(( deadline - now )) -lt "$chunk" ] && chunk=$(( deadline - now ))
    [ "$chunk" -lt 1 ] && chunk=1
    sleep "$chunk"
  done
  echo "⏰ $(date '+%H:%M') 额度窗口应已重置。"
}

# 周上限:写状态文件 + 退出(交人决定)
write_quota_blocked() {  # <file>
  local f="$1" ep eta
  ep="$(parse_reset_epoch "$f" || true)"
  eta="$( [ -n "$ep" ] && date -d "@$ep" '+%Y-%m-%d %H:%M' 2>/dev/null || echo '未能解析(见下方输出)')"
  {
    echo "# QUOTA-BLOCKED — 检测到周上限(weekly limit)"
    echo
    echo "- 时间:$(date '+%Y-%m-%d %H:%M:%S')"
    echo "- 类型:**weekly limit(周上限)**,可能要等到下周才重置"
    echo "- 解析到的重置时间:$eta"
    echo "- 剩余未完成任务数:$(remaining)"
    echo
    echo "## 为什么停这儿(而不是 sleep)"
    echo "周上限不同于 5 小时滚动窗口,盲目 sleep 会醒来又撞墙空转。已退出,交你决定:等待 / 换 API key / 升级额度。"
    echo
    echo "## 恢复"
    echo "重置(或换好凭证)后直接重跑 \`./run-agent.sh\`,会从第一个未勾选 [ ] 任务自动续跑,不重做已完成的。删本文件不影响续跑。"
    echo
    echo "## 触发时 claude 输出(末 30 行)"
    echo '```'
    tail -n 30 "$f" 2>/dev/null || true
    echo '```'
  } > QUOTA-BLOCKED.md
}

# 统一处理:命中额度后做什么(usage→睡后 re-exec 续跑;weekly→写文件 exit)。不返回。
handle_quota() {  # <kind> <file> <rc>
  local kind="$1" file="$2" rc="$3" now target reason deadline eta
  echo; echo "⚠ 检测到 Claude 额度信号(kind=$kind, claude 退出码 $rc)—— 按额度处理,**不当任务失败**(不回退/不计失败/不标 [~]/不打勾)。"
  now="$(date +%s)"; deadline=$(( START_EPOCH + MAX_WALL_HOURS*3600 ))

  if [ "$kind" = weekly ]; then
    write_quota_blocked "$file"; rm -f "$file"
    echo "🚫 周上限:已写 QUOTA-BLOCKED.md(含重置时间与续跑说明),退出。等/换 key 由你定。"
    notify "周上限,已写 QUOTA-BLOCKED.md 并退出,需你决定等待或换 key。"
    exit 76
  fi

  # usage / 5h / 一般限流:确定 sleep 目标(🧪模拟时用短 sleep,真实时解析重置时间)
  if [ "${QUOTA_SIM:-}" = 1 ]; then
    target=$(( now + ${SIMULATE_QUOTA_SLEEP_SECS:-30} )); reason="🧪模拟额度(测试,短 sleep ${SIMULATE_QUOTA_SLEEP_SECS:-30}s)"; rm -f "$file"
  else
    target="$(parse_reset_epoch "$file" || true)"; rm -f "$file"
    if [ -z "${target:-}" ]; then target=$(( now + 5*3600 + 300 )); reason="未解析到重置时间 → 默认 5h5m"
    else                            target=$(( target + 300 ));      reason="解析到重置时间 + 5min 缓冲"; fi
  fi

  if [ "$now" -ge "$deadline" ]; then echo "⛔ 已达 MAX_WALL_HOURS=$MAX_WALL_HOURS,退出。"; notify "达到 MAX_WALL_HOURS,退出。"; exit 77; fi
  if [ "$target" -gt "$deadline" ]; then
    eta="$(date -d "@$target" '+%Y-%m-%d %H:%M' 2>/dev/null || echo '?')"
    echo "⛔ 预计恢复($eta)超过总运行上限 MAX_WALL_HOURS=$MAX_WALL_HOURS。不再等待,退出由你决定。"
    { echo "# QUOTA-BLOCKED — 重置时间超过 MAX_WALL_HOURS"; echo; echo "- 预计恢复:$eta"; echo "- 剩余未完成任务数:$(remaining)"; echo "- 重置后重跑 ./run-agent.sh 自动续跑。"; } > QUOTA-BLOCKED.md
    notify "额度重置时间超过 MAX_WALL_HOURS,退出。"; exit 77
  fi

  sleep_until_with_heartbeat "$target" "$reason"
  export QUOTA_SLEEPS=$(( ${QUOTA_SLEEPS:-0} + 1 ))
  echo "🔁 第 $QUOTA_SLEEPS 次额度等待结束 → 重启编排器,从第一个未勾选任务继续…"
  exec bash "$0"
}

run_claude() {
  local rc out kind simk
  # 临时文件放 repo 外(避免被 agent 的 git add -A 误提交),仅供本次额度检测
  out="$(mktemp 2>/dev/null || echo "${TMPDIR:-/tmp}/claude_out.$$")"
  if [ -n "${SIMULATE_QUOTA:-}" ] && [ "${SIMULATE_QUOTA}" = "${iter:-}" ] && [ -z "${SIMULATE_QUOTA_DONE:-}" ]; then
    # 🧪 第 N 轮注入模拟额度信号,**跳过真实 claude**(不烧额度),跑通 检测→等待→续跑
    simk="${SIMULATE_QUOTA_KIND:-usage}"
    echo "🧪 SIMULATE_QUOTA=$SIMULATE_QUOTA(kind=$simk):第 $iter 轮注入模拟『额度耗尽』,跳过真实 claude。" | tee -a "$LOG_DIR/$TS.log"
    if [ "$simk" = weekly ]; then
      printf 'SIMULATED quota: Claude weekly limit reached; resets next Monday.\n' > "$out"
    else
      printf 'SIMULATED quota: Claude usage limit reached (5-hour rolling limit); resets shortly.\n' > "$out"
      QUOTA_SIM=1   # 仅 usage:让 handle_quota 用短 sleep(不导出 → 续跑不再模拟)
    fi
    rc=1
    export SIMULATE_QUOTA_DONE=1   # 跨 re-exec 只模拟一次
  else
    claude --dangerously-skip-permissions -p "$1" 2>&1 | tee -a "$LOG_DIR/$TS.log" "$out"
    rc=${PIPESTATUS[0]}                     # claude 的退出码(非 tee 的)
  fi
  kind="$(quota_kind "$rc" "$out")"
  [ "$kind" != none ] && handle_quota "$kind" "$out" "$rc"   # 睡后 re-exec / 周上限 exit;均不返回
  rm -f "$out"
  return "$rc"
}

iter=0
while true; do
  # 总时长上限兜底(含睡眠;START_EPOCH 跨 re-exec 保持不变)
  if [ $(( $(date +%s) - START_EPOCH )) -ge $(( MAX_WALL_HOURS*3600 )) ]; then
    echo "⛔ 达到总运行上限 MAX_WALL_HOURS=$MAX_WALL_HOURS,退出。"; notify "达到 MAX_WALL_HOURS=$MAX_WALL_HOURS,退出。"; break
  fi
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
