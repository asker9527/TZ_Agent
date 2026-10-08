---
description: 股市体检——指数估值分位、当日行情、当前仓位，判断"现在该投多少"
argument-hint: "[关注的方向，如 沪深300 / 恒生科技]"
---
读取 skill `invest-manager` 的《流程 A：股市体检》，按 ${1:-全市场} 范围执行。

必须包含：
1. `invest_market mode=valuation` 的宽基分位（沪深300 / 中证500 / 中证1000 / 上证50 / 创业板）。
2. 相关指数的实时行情（`invest_market mode=quote`）。
3. `invest_portfolio action=status` 的当前仓位与现金比例。
4. 结论按【估值】【现状】【判断】【动作】【改变主意的条件】五段输出。

禁止预测涨跌、禁止说"最佳买点"。分位只回答"贵不贵、该投多少"。
