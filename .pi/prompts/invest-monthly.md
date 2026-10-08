---
description: 生成本月基金买入计划（先记录工资入金，再按估值倾斜分配）
argument-hint: "[本月投入金额]"
---
读取 skill `invest-manager` 的《流程 B：月度计划》，严格执行。

本月投入金额：${1:-（留空则按 profile.json 的 monthlySalary × investRatio 计算；若 monthlySalary 为空，必须先问我金额，不要假设）}

步骤：
1. `invest_portfolio action=profile` 确认月薪/比例/发薪日与目标配置。
2. `invest_portfolio action=cash cashType=deposit` 记录本月入金。
3. 检查关注池每个大类是否有足够标的（目标权重 > 25% 的类别至少 2 只不同指数的基金），不足的先补。
4. `invest_plan action=preview` 生成计划，把完整清单和**所有警告**呈现给我。
5. 等我确认后再 `invest_plan action=commit`，然后 `invest_portfolio action=snapshot`。
6. 报告写入 `invest/reports/<今天>-monthly.md` 并用 `invest_notify` 推送。
