# JU 实现日志（Step-10A 落地）

> 自主实现：**开发 agent 写代码、独立 agent 写测试**；每任务 → 自检(typecheck/lint) → 全量门禁(vitest + check-boundaries) → commit → 记录于此。
> 任务大纲见 [README.md](./README.md#实现逻辑step-10a-设计--跨页)。视觉件（局卡 art/分类模板/态过渡/PNG 布局）= Step 10B；品牌 PDF 待补，先做功能/结构、视觉用占位。

## 任务清单（依赖顺序）
1. **迁移 0022 + RPC 边界测试**（基础，PDF/视觉无关）— ✅ 完成
2. 局卡组件 + `next/og` 图片路由 + QR 生成库
3. 建局（选局卡 UI / 成局目标=capacity reframe / 发布校验 +时间/TBD+城市）
4. 局详情（改造 `EventClient`：局卡顶+留位，移 slot，保地址 reveal）
5. 管理（改造 `[id]/page`：局卡+展开管理 / 满→提示成局 wiring）
6. 仪表盘（局卡顶 + 一键复用 `/new?from=`）
7. 设置（昵称合并 / host 通用联系方式 / 去 `/u/`）
8. 发现（紧凑局卡 + 静默隐藏过滤）

## 进度记录
### 任务 1 — 迁移 0022 + RPC 基础　【✅ 完成 2026-06-19】
- 范围：events.category/card_variant + profiles.contact；recreate get_event_by_slug（+category/card_variant 一等；**host_contact 与 host_wechat_id 同一双盲门控**，仅 unlocked+contact_open 时返回）、get_public_events（+静默隐藏 WHERE：未成局-过期 = past + capacity 设了 + going<cap + locked_at 空，用 locked_at 非 is_locked）；web types + view.ts schema。
- 开发 agent + 独立 RPC 边界测试（`web/tests/migration-0022-category-contact.test.ts`，8 例）+ 对抗审查（5 向量全 could-not-refute、无泄露）。
- 门禁：vitest **687/687**、护栏 **8/8**。
- 任务 1 ✅ → 任务 2 进行中。
