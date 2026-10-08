---
description: 生成投资周报（组合状态/估值变化/再平衡提示），归档并推送飞书
---
读取 skill `invest-manager` 的《流程 C：周度复盘》，严格执行并输出报告。

要求：
1. 先 `invest_portfolio action=status` 和 `invest_market mode=valuation` 取数，不许沿用记忆中的数字。
2. 对比 `invest/reports/` 里最近一份周报的估值分位，指出变化。
3. 按模板输出完整周报，写入 `invest/reports/<今天>-weekly.md`。
4. 用 `invest_notify` 推送标题与正文，并把报告文件作为附件带上。
5. 如果没有任何规则被触发，正文第一句必须是"本周无需动作"，不要为了凑内容编造观点。
