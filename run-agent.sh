#!/usr/bin/env bash
# run-agent.sh v2 — 无人值守驱动 Claude Code 跑完 TASKS.md。
#
# 核心:每轮取下一个未勾选任务。
#   - 任务标 [SECURITY] → 两轮独立 agent:① 实现 agent ② 独立测试 agent(对抗性)。
#   - 普通任务 → 单轮同 agent TDD(先测后写)。
# 每轮结束跑 check-boundaries.sh + 测试;通过才允许打勾。
#
# 强烈建议在 Docker/VM 中运行(用了 --dangerously-skip-permissions)。
# 前置:Claude Code 已装且已登录;从仓库根运行;Supabase/Upstash 的 env 已配。

set -uo pipefail
MAX_ITERS="${MAX_ITERS:-60}"
LOG_DIR="agent-logs"; mkdir -p "$LOG_DIR"

remaining() { grep -c '^\s*-\s*\[ \]' TASKS.md 2>/dev/null || echo 0; }
next_task_line() { grep -n '^\s*-\s*\[ \]' TASKS.md 2>/dev/null | head -1; }
is_security() { echo "$1" | grep -q '\[SECURITY\]'; }

run_claude() { # $1 = prompt
  claude --dangerously-skip-permissions -p "$1" 2>&1 | tee -a "$LOG_DIR/$TS.log"
}

iter=0
while true; do
  left="$(remaining)"
  [ "$left" -eq 0 ] && { echo "✅ 全部任务完成。"; break; }
  [ "$iter" -ge "$MAX_ITERS" ] && { echo "⛔ 达到 MAX_ITERS=$MAX_ITERS,剩 $left 个任务,停下待审。"; break; }
  iter=$((iter+1)); TS="$(date +%Y%m%d-%H%M%S)"
  LINE="$(next_task_line)"
  echo "▶ 迭代 $iter — 剩 $left — 任务:$LINE — 日志 $LOG_DIR/$TS.log"

  COMMON="读 CLAUDE.md、SCHEMA.md(数据模型+安全逐字段边界)、TASKS.md。前端任务另读 DESIGN-TONE.md 与 frontend-design SKILL.md。安全任务的测试断言见 TEST-SPEC.md。绝不提交密钥;绝不削弱 RLS;🟡 功能只建表不做前端;承载安全/数据语义的行为必须正确。"

  if is_security "$LINE"; then
    echo "  🔒 [SECURITY] 任务 → 两轮独立 agent"
    # —— 第一轮:实现 agent(禁改测试)——
    run_claude "你是【实现工程师】,自主完成 TASKS.md 中第一个未勾选任务的【实现部分】。
$COMMON
规则:
- 只写实现代码,**不得编写或修改任何测试文件**(测试由独立测试工程师另写)。
- 严格遵守该任务【禁止】项与 SCHEMA.md 的安全字段边界。
- 完成后运行 ./check-boundaries.sh;若失败则修到通过。
- **先不要打勾、先不要写最终 commit message 声称完成**;实现+护栏通过后做一次 commit(feat:),然后停止。
- 若无法完成(缺密钥/外部阻塞/歧义),写 BLOCKERS.md 并停,不要瞎编。不要问我问题。"

    # —— 第二轮:独立测试 agent(全新调用、对抗性)——
    run_claude "你是【测试工程师】,**你没有写过这段实现代码**。针对 TASKS.md 中第一个未勾选的 [SECURITY] 任务,编写并运行**对抗性测试**,目标是找出实现的漏洞,尤其安全语义。
$COMMON
规则:
- 按 TEST-SPEC.md 中该任务对应小节的断言**逐条**写测试,可加更多边界用例。
- **以怀疑的心态写**:假设实现可能在分级返回、容量、去重、contact 泄露、权限上有漏洞,设计能戳穿这些的用例。
- 运行测试:全部通过 → 运行 ./check-boundaries.sh → 通过后,将该任务在 TASKS.md 由 [ ] 改为 [x],commit(test:),停止。
- **若任何测试不通过 → 不要打勾**。在 BLOCKERS.md 记录失败的断言与疑似缺陷,commit 测试代码(test:),停止。等下轮实现 agent 修复后再回来。不要自己去改实现代码绕过测试。不要问我问题。"

  else
    echo "  🟢 普通任务 → 单轮 TDD"
    run_claude "你是工程师,用 TDD 自主完成 TASKS.md 中第一个未勾选任务。
$COMMON
TDD 流程:
1. 先为该任务写测试(此时应失败=红)。
2. 写实现让测试通过(绿)。普通任务测试可适度;若该任务【测试】标 N/A 则以 build/typecheck 为验证。
3. 运行 ./check-boundaries.sh,失败则修到通过。
4. 全绿后:将该任务 [ ] 改为 [x],commit(feat: 或 db:),停止。
只做这一个任务。若无法完成,写 BLOCKERS.md 并停,不要瞎编、不要问我。"
  fi

  # —— 轮末:仓库侧二次校验(防 agent 漏跑护栏)——
  if [ -x ./check-boundaries.sh ]; then
    if ! ./check-boundaries.sh >> "$LOG_DIR/$TS.log" 2>&1; then
      echo "  ⚠ 轮末护栏未过 — 见 $LOG_DIR/$TS.log(该任务不应被打勾)"
    fi
  fi
  sleep 1
done

echo; echo "Summary:"; echo "  剩余任务:$(remaining)"
echo "  本次提交:"; git -c core.pager=cat log --oneline -n 25
