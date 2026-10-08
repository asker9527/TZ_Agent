/**
 * pi-invest: 投资经理 Agent 扩展
 *
 * 工具:
 *   invest_market        实时行情 / 指数估值分位
 *   invest_fund_search   基金代码或名称搜索
 *   invest_fund_detail   基金档案与风险指标
 *   invest_fund_rank     基金排行筛选
 *   invest_portfolio     持仓台账(状态/入金/记账/关注池/流水)
 *   invest_plan          月度投入计划(估值倾斜 + 风控裁剪)
 *   invest_notify        飞书推送报告
 *
 * 命令:
 *   /invest         打印组合看板(不消耗模型)
 *   /invest-status  打印数据源与推送通道自检
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CONFIG_FILE, getWorkspace, loadConfig, readJson, ws, writeJson } from "./config";
import {
	ASSET_CLASSES,
	type AssetClass,
	type Holding,
	type LedgerEntry,
	type PlanResult,
	type PortfolioStatus,
	type Profile,
	type WatchItem,
	applyCash,
	applyTrade,
	buildPlan,
	commitPlan,
	computeStatus,
	defaultProfile,
	initWorkspace,
	loadPortfolio,
	loadProfile,
	loadWatchlist,
	newId,
	readLedger,
	recordSnapshot,
	refreshNavs,
	savePortfolio,
	saveProfile,
	saveWatchlist,
} from "./portfolio";
import {
	RANK_CATEGORY_LABEL,
	RANK_PERIOD_LABEL,
	type RankCategory,
	type RankPeriod,
	type FundEstimate,
	type FundBasic,
	findValuations,
	getBoardValuations,
	getFundEstimates,
	getFundRank,
	getFundSnapshot,
	getQuotes,
	getValuations,
	normalizeSymbol,
	round,
	searchFunds,
	valuationPct,
	valuationPercentile,
} from "./datasource";
// 这些从 datasource 单独引入（上面的解构块太大，另起一块更安全）
import {
	getFundBasic,
	getFundHoldings,
	getFundScaleTotal,
	getStockProfile,
	type StockProfile,
} from "./datasource";
import { boardPercentile, historySummary, recordDailySnapshot } from "./valuation-history";
import { feishuStatus, sendFile, sendMarkdown } from "./notify";

const NO_FABRICATE =
	"invest_* 工具返回的数字才能进入结论。任何净值/涨跌/估值分位都必须来自工具输出, 不得凭记忆或推测填写; 取数失败就如实说明取数失败。";

function text(s: string, details?: unknown) {
	return { content: [{ type: "text" as const, text: s }], details: details ?? {} };
}

function pct(n: number | undefined, digits = 2): string {
	return n === undefined || !Number.isFinite(n) ? "—" : `${n > 0 ? "+" : ""}${round(n, digits)}%`;
}

function money(n: number | undefined): string {
	return n === undefined ? "—" : `${round(n, 2).toLocaleString("zh-CN")} 元`;
}

/** 取各资产类别的基准指数估值分位 (状态/计划共用) */
async function classValuations(profile: Profile, signal?: AbortSignal): Promise<Record<string, number | undefined>> {
	const vals: Record<string, number | undefined> = {};
	for (const [cls, codes] of Object.entries(profile.benchmark)) {
		if (!codes?.length) continue;
		try {
			vals[cls] = await valuationPercentile(codes, signal);
		} catch {
			vals[cls] = undefined;
		}
	}
	return vals;
}

export default function (pi: ExtensionAPI) {
	// -----------------------------------------------------------------------
	// invest_market
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "invest_market",
		label: "行情/估值",
		description:
			"取 A股/港股/美股指数与个股、黄金原油汇率实时行情, 或指数 PE/PB 历史分位(估值), 或场外基金盘中估算涨跌。" +
			"mode=quote 传 codes(如 sh000300, hkHSI, usIXIC, hf_XAU, 510300 或中文别名'沪深300');" +
			"mode=valuation 按关键词筛选指数估值表, 分位越低越便宜;" +
			"mode=estimate 传 6 位基金代码, 看这些场外基金今天的盘中估算涨跌(你在支付宝看到的'净值估算')。",
		promptSnippet: "invest_market: 实时行情 / 指数估值分位 / 场外基金盘中估值",
		promptGuidelines: [
			NO_FABRICATE,
			"invest_market mode=estimate 返回的是第三方盘中估算，不是基金公司公布的官方净值；它不得用于记账、市值计算、盈亏或 XIRR 结论，只能用来回答“今天大概怎么样”。",
			"6 位纯数字代码在 mode=quote 下会被当作场内证券(股票/ETF/可转债)，与场外基金代码会撞号(例: 110020 是南山转债，不是易方达沪深300ETF联接A)。查场外基金的净值/估值要用 invest_fund_detail 或 invest_market mode=estimate；如果 quote 返回的名字不像预期标的，说明撞号了，如实说明而不是当成基金。",
		],
		parameters: Type.Object({
			mode: StringEnum(["quote", "valuation", "estimate", "board", "snapshot"] as const),
			codes: Type.Optional(Type.Array(Type.String(), { description: "行情代码或中文别名(mode=quote); 或 6 位基金代码(mode=estimate)" })),
			keyword: Type.Optional(Type.String({ description: "mode=valuation/board: 名称关键词, 如 300/红利/科技/半导体; 留空返回全表" })),
			sortBy: Type.Optional(StringEnum(["percentile", "name"] as const)),
			limit: Type.Optional(Type.Number({ description: "valuation/board 返回条数, 默认 40" })),
			force: Type.Optional(Type.Boolean({ description: "mode=snapshot: 忽略幂等检查强制重记" })),
		}),
		async execute(_id, params, signal) {
			if (params.mode === "board") {
				const all = await getBoardValuations(signal);
				const kw = params.keyword?.trim();
				const kws = kw ? kw.split(/[\s,，、|]+/).filter(Boolean) : [];
				let rows = kws.length ? all.filter((b) => kws.some((k) => b.name.includes(k) || b.code.toUpperCase().includes(k.toUpperCase()))) : all;
				// 按市值降序（大板块更可能是真实行业），限流输出
				rows = [...rows].sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0)).slice(0, params.limit ?? 40);
				if (!rows.length) return text(`没有匹配 "${params.keyword}" 的板块。可用关键词如 半导体 / 芯片 / 人工智能 / 消费电子。`);
				const lines = rows.map((b) => {
					const self = boardPercentile(b.code);
					const selfTxt = self.pct !== undefined
						? `自建分位 ${self.pct}% (样本${self.samples}天 ${self.firstDate}~${self.lastDate})`
						: `自建分位不可用(样本${self.samples}天<60)`;
					return `${b.name}(${b.code})[${b.kind === "industry" ? "行业" : "概念"}] PE ${b.pe ?? "—"} 市值 ${b.marketCap ? round(b.marketCap / 1e8, 0) + "亿" : "—"} ${pct(b.changePct)} | ${selfTxt}`;
				});
				const head =
					`板块估值（数据来源：东方财富板块接口；PE 为**整体法**口径，与指数 PE 不完全等价；**该接口不提供 PB**）。` +
					`自建分位来自本地历史库（${historySummary().days} 天），不足 60 个交易日时不给分位。`;
				return text([head, "", ...lines].join("\n"), { boards: rows });
			}

			if (params.mode === "snapshot") {
				const res = await recordDailySnapshot({ force: params.force === true, signal });
				const sum = historySummary();
				return text(
					`${res.skipped ? "⏭️" : "✅"} ${res.message}\n` +
						`本地估值历史库: ${sum.days} 天 (${sum.firstDate ?? "—"} ~ ${sum.lastDate ?? "—"})，已跟踪板块 ${sum.boardsTracked} 个，其中 ${sum.boardsReady} 个已达 60 个交易日可给自建分位\n` +
						`注: 分位靠时间累积，不存在回填历史的方法，每天记一次即可。`,
					{ ...res, summary: sum },
				);
			}

			if (params.mode === "valuation") {
				const all = await getValuations(signal);
				const kw = params.keyword?.trim();
				let items = kw ? all.filter((v) => v.name.includes(kw) || v.code.toUpperCase().includes(kw.toUpperCase())) : all;
				if (items.length === 0) {
					return text(
						`蛋卷估值表没有覆盖 "${kw}"（该表仅含 ${all.length} 个宽基/主要行业指数）。` +
							`可改用 invest_market mode=board 关键词=${kw} 查东财行业/概念板块 PE，` +
							`但要注意：板块 PE 是整体法口径、且本工具对板块只能给「自建分位」（靠本地历史累积，不足 60 个交易日不给分位）。`,
					);
				}
				const rows0 = items.slice();
				if (params.sortBy !== "name") rows0.sort((a, b) => (valuationPct(a) || 999) - (valuationPct(b) || 999));
				const rows = rows0.slice(0, params.limit ?? 40);
				const lines = rows.map((v) => {
					const p = valuationPct(v);
					const tag = p < 20 ? "🟢低估" : p < 50 ? "🟡偏低" : p < 80 ? "🟠偏高" : "🔴高估";
					return `${v.name}(${v.code}) PE ${v.pe ?? "—"} PB ${v.pb ?? "—"} 分位 ${Number.isFinite(p) ? `${round(p, 1)}%` : "—"} ${tag}` +
						`${v.dividendYield ? ` 股息率${round(v.dividendYield * 100, 2)}%` : ""}${v.evaType ? ` [蛋卷:${v.evaType}]` : ""}`;
				});
				const header = `指数估值表(数据日 ${rows[0]?.date ?? "—"}, 共 ${items.length} 个, 显示 ${rows.length} 个, 按分位升序)`;
				return text([header, ...lines].join("\n"), { valuations: rows });
			}

			if (params.mode === "estimate") {
				const codes = params.codes ?? [];
				if (!codes.length) return text("mode=estimate 需要提供 6 位基金代码");
				const ests = await getFundEstimates(codes, signal);
				if (!ests.length) {
					return text(
						"未取到任何盘中估值。可能原因：这些基金不提供估值（货币/纯债/部分 QDII 常见）、代码有误，或当前非交易时段。已公布净值仍可用 invest_fund_detail 或 invest_portfolio action=status 获取。",
					);
				}
				const lines = ests.map(
					(e) =>
						`${e.name}(${e.code}) 估算 ${e.estimatePct > 0 ? "+" : ""}${e.estimatePct}% → 估算净值 ${e.estimateNav} (已公布 ${e.publishedNav}) ${e.time ?? ""}`,
				);
				const missing = codes.filter((c) => !ests.some((e) => e.code === c));
				const head =
					"⚠️ 以下为第三方盘中估算（新浪），**不是基金公司公布的官方净值**，不得用于记账、市值计算或盈亏结论，仅供盘中参考。";
				return text(
					[head, ...lines, missing.length ? `无估值数据: ${missing.join(", ")}` : ""].filter(Boolean).join("\n"),
					{ estimates: ests },
				);
			}
			if (params.mode === "quote") {
				const codes = params.codes ?? [];
				if (!codes.length) return text("mode=quote 需要提供 codes");
				const quotes = await getQuotes(codes, signal);
				if (!quotes.length) return text("未取到任何行情, 请检查代码是否正确");
				const lines = quotes.map(
					(q) =>
						`${q.name}(${q.code}) ${q.price} ${pct(q.changePct)} 高${q.high}/低${q.low} 昨收${q.prevClose}` +
						`${q.amount ? ` 成交额${round(q.amount / 1e8, 2)}亿` : ""}${q.pe ? ` PE${round(q.pe, 2)}` : ""} ${q.date ?? ""} ${q.time ?? ""} [${q.source}]`,
				);
				const missing = codes
					.map((c) => ({ input: c, sym: normalizeSymbol(c).toUpperCase() }))
					.filter((n) => !quotes.some((q) => q.code.toUpperCase() === n.sym))
					.map((n) => n.input);
				return text([...lines, missing.length ? `未取到: ${missing.join(", ")}` : ""].filter(Boolean).join("\n"), { quotes });
			}
			return text("invest_market 需要 mode=quote | valuation | estimate | board | snapshot");
		},
	});

	// -----------------------------------------------------------------------
	// invest_fund_search
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "invest_fund_search",
		label: "搜索基金",
		description: "按基金代码、名称、拼音简拼搜索全市场基金(约3万只), 返回代码/名称/类型。用于确认代码或找候选基金。",
		promptSnippet: "invest_fund_search: 按代码/名称/拼音搜索基金",
		parameters: Type.Object({
			query: Type.String({ description: "代码、名称关键词或拼音简拼, 如 110011 / 沪深300 / HS300" }),
			typeKeyword: Type.Optional(Type.String({ description: "类型过滤, 如 指数型 / 混合型 / 债券型 / QDII" })),
			limit: Type.Optional(Type.Number({ description: "默认 20" })),
		}),
		async execute(_id, params, signal) {
			const rows = await searchFunds(params.query, { limit: params.limit ?? 20, typeKeyword: params.typeKeyword, signal });
			if (!rows.length) return text(`没有匹配 "${params.query}" 的基金`);
			return text(rows.map((f) => `${f.code} ${f.name} [${f.type}]`).join("\n"), { funds: rows });
		},
	});

	// -----------------------------------------------------------------------
	// invest_fund_detail
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "invest_fund_detail",
		label: "基金档案",
		description:
			"取单只基金的净值、区间收益、年化波动、最大回撤、夏普、规模、基金经理、股票仓位、费率、申购状态。" +
			"用于尽调候选基金。评估基金必须调用本工具, 不要凭印象判断。",
		promptSnippet: "invest_fund_detail: 基金净值/风险指标/规模/经理/费率",
		promptGuidelines: [
			NO_FABRICATE,
			"用 invest_fund_detail 做基金尽调时, 至少核对: 近1年与近3年收益、近1年最大回撤、年化波动、最新规模(亿元)、基金经理任职年限、申购状态。",
		],
		parameters: Type.Object({
			codes: Type.Array(Type.String(), { description: "基金代码数组, 建议单次不超过 5 只" }),
		}),
		async execute(_id, params, signal) {
			const out: string[] = [];
			const snaps: unknown[] = [];
			for (const code of params.codes) {
				try {
					const s = await getFundSnapshot(code, signal);
					let basic: FundBasic | undefined;
					let scaleTotal: { totalScaleYi?: number; ownScaleYi?: number; siblingCode?: string; siblingScaleYi?: number } | undefined;
					try {
						basic = await getFundBasic(code, signal);
					} catch {
						basic = undefined; // 基本概况取不到不影响其余指标
					}
					try {
						scaleTotal = await getFundScaleTotal(code, signal);
					} catch {
						scaleTotal = undefined;
					}
					snaps.push(s);
					const scale = s.holdings?.scaleSeries?.at(-1);
					const m = s.metrics;
					out.push(
						[
							`## ${s.name} (${s.code})`,
							`净值 ${s.nav?.latest ?? "—"} (${s.nav?.date ?? "—"}) 当日 ${pct(s.nav?.changePct)} | 成立 ${s.inceptionDate ?? "—"}`,
							`区间收益: 近1月 ${pct(s.returns?.m1)} 近3月 ${pct(s.returns?.m3)} 近6月 ${pct(s.returns?.m6)} 近1年 ${pct(s.returns?.y1)}`,
							`风险(近1年): 年化 ${pct(m?.y1?.annualizedReturn)} 波动 ${pct(m?.y1?.volatility)} 最大回撤 ${pct(m?.y1?.maxDrawdown)} 夏普 ${m?.y1?.sharpe ?? "—"}`,
							`风险(近3年): 年化 ${pct(m?.y3?.annualizedReturn)} 波动 ${pct(m?.y3?.volatility)} 最大回撤 ${pct(m?.y3?.maxDrawdown)} 夏普 ${m?.y3?.sharpe ?? "—"} 卡玛 ${m?.y3?.calmar ?? "—"}`,
							`风险(成立以来): 年化 ${pct(m?.all?.annualizedReturn)} 最大回撤 ${pct(m?.all?.maxDrawdown)} 样本${m?.all?.days ?? 0}天`,
							`规模: 本份额 ${scale ? `${scale.scaleYi} 亿` : "—"}` +
								(scaleTotal?.totalScaleYi !== undefined
									? ` | **A+C 合计 ${scaleTotal.totalScaleYi} 亿**（另有 ${scaleTotal.siblingCode ?? "同门份额"} ${scaleTotal.siblingScaleYi ?? "—"} 亿）← 判规模门槛要看合计`
									: "（未找到同门份额，合计规模待核）") +
								` | 股票仓位 ${s.holdings?.stockRatio !== undefined ? `${s.holdings.stockRatio}%` : "—"}`,
							`经理: ${s.managers?.map((x) => `${x.name}(${x.workTime ?? "?"}${x.star ? ` ${x.star}星` : ""})`).join(", ") || "—"}`,
							basic
								? `真实敷口: 跟踪 **${basic.trackedIndex ?? "—"}**${basic.isFeeder ? "（ETF联接基金，不直接持股）" : ""}` +
									`\n持有成本(年化): **${basic.holdingCostPct ?? "—"}%** = 管理费 ${basic.managementFeePct ?? "—"}% + 托管费 ${basic.custodyFeePct ?? "—"}%${basic.salesServiceFeePct !== undefined ? ` + 销售服务费 ${basic.salesServiceFeePct}%` : ""}` +
									`\n申购费: 最高 ${basic.maxSubscribeFeePct ?? "—"}% / 折后 ${basic.discountedSubscribeFeePct ?? "—"}%（一次性） | 最高赎回费 ${basic.maxRedeemFeePct ?? "—"}%`
								: `费率: 原 ${s.fee?.source ?? "—"} 现 ${s.fee?.current ?? "—"}（仅申购手续费；管理费/托管费未取到）`,
						].join("\n"),
					);
				} catch (err) {
					out.push(`## ${code}\n取数失败: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			return text(out.join("\n\n"), { snapshots: snaps });
		},
	});

	// -----------------------------------------------------------------------
	// invest_fund_holdings
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "invest_fund_holdings",
		label: "基金敷口/费用/持仓企业",
		description:
			"看一只基金到底买的是什么：① 跟踪标的指数（真实敷口）② 全部费用（管理费+托管费+销售服务费的年化持有成本，以及申赎费）" +
			"③ 规模（A+C 合计）④ 前十大重仓企业，并逐家给出所属行业、概念标签、主营业务。" +
			"用户问“这只基金里是什么公司/它们干什么”时必须用它。注意：持仓为季度披露，滞后 2-4 个月，只含前十大，不预示未来；" +
			"ETF 联接基金不直接持股，它的敷口就是跟踪标的指数。",
		promptSnippet: "invest_fund_holdings: 基金跟踪标的、全部费用、A+C规模、前十大持仓企业的行业与主营业务",
		promptGuidelines: [
			NO_FABRICATE,
			"用户要“基金前十大公司是干什么的”时用 invest_fund_holdings：它会给出每家的所属行业、概念标签与主营业务。行业/概念来自数据商标签，不是官方分类，转述时要说明。",
			"用户问“能不能只买我看好的那几家公司”时：先给真实持仓数据，再说明两件事——(a) 个股名单属于主观判断，本系统不提供“优质企业”推荐；(b) 用“是否包含我喜欢的公司”选基金是拿滞后 2-4 个月的前十大持仓做决策，不如直接买跟踪目标指数的指数基金（成分规则公开、自动调整）。不要为了迎合用户而编造企业名单或吹捧个股。",
		],
		parameters: Type.Object({
			codes: Type.Array(Type.String(), { description: "基金代码数组，建议不超过 3 只（每只需逐家查持仓企业，较慢）" }),
		}),
		async execute(_id, params, signal) {
			const out: string[] = [];
			for (const code of params.codes) {
				try {
					const [basic, hold, scale] = await Promise.all([
						getFundBasic(code, signal),
						getFundHoldings(code, signal),
						getFundScaleTotal(code, signal).catch(() => undefined),
					]);
					const lines: string[] = [`## ${basic.fullName?.slice(0, 40) ?? code} (${code})`];
					lines.push(
						`**真实敷口**: 跟踪「${basic.trackedIndex ?? "—"}」` +
							(basic.benchmark ? `\n业绩基准: ${basic.benchmark}` : "") +
							(basic.isFeeder ? `\n（这是 ETF 联接基金，主要持有目标 ETF 而不是直接持股；上方跟踪标的才是它的敷口）` : ""),
					);
					if (scale?.totalScaleYi !== undefined)
						lines.push(
							`**规模**: A+C 合计 **${scale.totalScaleYi} 亿元**（本份额 ${scale.ownScaleYi ?? "—"}亿 + ${scale.siblingCode ?? "同门份额"} ${scale.siblingScaleYi ?? "—"}亿）` +
								`\n（规模门槛必须看 A+C 合计；只看 A 类会低估、误判成不合格）`,
					);
					lines.push(
						`**费用**: 年化持有成本 **${basic.holdingCostPct ?? "—"}%**` +
							`（管理费 ${basic.managementFeePct ?? "—"}% + 托管费 ${basic.custodyFeePct ?? "—"}%` +
							(basic.salesServiceFeePct !== undefined ? ` + 销售服务费 ${basic.salesServiceFeePct}%` : "") +
							`）` +
							`\n申购费最高 ${basic.maxSubscribeFeePct ?? "—"}%、折后 ${basic.discountedSubscribeFeePct ?? "—"}%（一次性） | 最高赎回费 ${basic.maxRedeemFeePct ?? "—"}%`,
					);
					if (basic.inceptionDate) lines.push(`**成立**: ${basic.inceptionDate} | 管理人: ${basic.manager ?? "—"}`);

					if (!hold.holdings.length) {
						lines.push(`\n**持仓**: 未披露。${hold.note ?? ""}`);
					} else {
						const top10 = hold.top10WeightPct ?? 0;
						const feederCaveat = basic.isFeeder && top10 < 20;
						lines.push(
							`\n**前十大持仓**（${hold.period ?? "—"}，截止 ${hold.asOf ?? "—"}，合计 ${hold.top10WeightPct ?? "—"}%）` +
								(feederCaveat
									? `\n⚠️ 这是**基金自己直接持有**的股票（仅占净值的 ${top10}%）；该联接基金约 95% 资产是通过**目标 ETF** 间接持有的。` +
										`\n上市公司的名称与排序通常与跟踪指数的前十大一致，但**这里的百分比不是指数权重，不能当作“基金在这只股票上押了多少”**。` +
										`\n要看真实权重，应看目标 ETF（同一跟踪标的的场内 ETF）。`
									: "") +
								`——逐家补上行业与主营业务，让你知道钱投到了哪里：`,
						);
						for (const h of hold.holdings) {
							let p: StockProfile | undefined;
							try {
								p = await getStockProfile(h.code, { secid: h.secid, signal });
							} catch {
								p = undefined;
							}
							const bits: string[] = [];
							if (p?.business) bits.push(p.business);
							if (p?.industry) bits.push(`行业:${p.industry}`);
							if (p?.pe !== undefined) bits.push(`PE:${p.pe}`);
							if (p?.concepts?.length) bits.push(`概念:${p.concepts.slice(0, 4).join("/")}`);
							lines.push(
								`- **${h.name}** ${h.weightPct ?? "—"}%` +
									(bits.length ? `\n    ${bits.join(" | ")}` : "\n    （行业/主营未取到）"),
							);
						}
						lines.push(`\n说明: ${hold.note ?? ""}`);
					}
					out.push(lines.join("\n"));
				} catch (err) {
					out.push(`## ${code}\n取数失败: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			return text(out.join("\n\n"), {});
		},
	});

	// -----------------------------------------------------------------------
	// invest_fund_rank
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "invest_fund_rank",
		label: "基金排行",
		description:
			"按类型和区间收益取基金排行榜(全市场实时榜)。用于初筛候选池。" +
			"注意: 排行是滞后指标, 高收益往往伴随高波动, 必须再用 invest_fund_detail 核对回撤与规模。",
		promptSnippet: "invest_fund_rank: 基金类型×区间收益排行榜",
		parameters: Type.Object({
			category: Type.Optional(StringEnum(Object.keys(RANK_CATEGORY_LABEL) as RankCategory[])),
			period: Type.Optional(StringEnum(Object.keys(RANK_PERIOD_LABEL) as RankPeriod[])),
			top: Type.Optional(Type.Number({ description: "取前 N 只, 默认 20" })),
		}),
		async execute(_id, params, signal) {
			const category = (params.category ?? "all") as RankCategory;
			const period = (params.period ?? "1nzf") as RankPeriod;
			const rows = await getFundRank({ category, period, top: params.top ?? 20, signal });
			const lines = rows.map(
				(r) =>
					`${r.code} ${r.name} 净值${r.nav}(${r.navDate}) 近1月${pct(r.m1)} 近3月${pct(r.m3)} 近6月${pct(r.m6)} 近1年${pct(r.y1)} 近2年${pct(r.y2)} 近3年${pct(r.y3)} 今年来${pct(r.ytd)} 成立来${pct(r.sinceInception)} 成立${r.inceptionDate}`,
			);
			return text(
				`${RANK_CATEGORY_LABEL[category]} 按${RANK_PERIOD_LABEL[period]}排序 前${rows.length} (注意: 排行只看收益, 必须再用 invest_fund_detail 核对回撤/规模/经理):\n${lines.join("\n")}`,
				{ rows, category, period },
			);
		},
	});

	// -----------------------------------------------------------------------
	// invest_portfolio
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "invest_portfolio",
		label: "投资组合",
		description:
			"投资组合台账。action: status 看持仓/盈亏/偏离/再平衡提示 | refresh 刷新净值 | init 初始化画像 | profile 读改画像 | " +
			"cash 记工资入金(type=deposit)或取出 | trade 记录买/卖 | watch 管理关注池 | history 看流水 | snapshot 记录当日快照。" +
			"入金必须先于买入: 未入金的钱不能买。",
		promptSnippet: "invest_portfolio: 持仓/入金/记账/关注池",
		promptGuidelines: [
			NO_FABRICATE,
			"用 invest_portfolio 记录任何买入前, 必须先确认现金余额充足(action=status); 买入金额不得超过可用现金。",
			"invest_portfolio action=trade 有硬性风控(单一标的上限/现金不得为负/追涨告警), 被拒绝时如实转述拒绝理由, 不要绕过或用其他工具改数字。",
		],
		parameters: Type.Object({
			action: StringEnum(["status", "refresh", "init", "profile", "cash", "trade", "watch", "history", "snapshot"] as const),
			// init / profile
			profilePatch: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "init/profile: 画像字段, 如 monthlySalary/investRatio/payday/targets/constraints" })),
			// cash
			cashType: Type.Optional(StringEnum(["deposit", "withdraw"] as const)),
			amount: Type.Optional(Type.Number()),
			// trade
			code: Type.Optional(Type.String()),
			side: Type.Optional(StringEnum(["buy", "sell"] as const)),
			assetClass: Type.Optional(StringEnum(Object.keys(ASSET_CLASSES) as AssetClass[])),
			nav: Type.Optional(Type.Number({ description: "成交净值; 不传则自动取最新公布净值" })),
			fee: Type.Optional(Type.Number()),
			// watch
			watchAction: Type.Optional(StringEnum(["add", "remove", "list"] as const)),
			reason: Type.Optional(Type.String()),
			priority: Type.Optional(Type.Number()),
			date: Type.Optional(Type.String({ description: "YYYY-MM-DD, 默认今天" })),
			note: Type.Optional(Type.String()),
			limit: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal) {
			const profile = loadProfile();
			const portfolio = loadPortfolio();

			switch (params.action) {
				case "init": {
					const res = initWorkspace((params.profilePatch ?? {}) as Partial<Profile>);
					return text(
						`工作区已初始化: ${getWorkspace()}\n创建/更新: ${res.createdFiles.join(", ")}\n` +
							`月薪: ${res.profile.monthlySalary ?? "未设置(请设置, 否则无法自动算月度投入额)"} 投入比例: ${res.profile.investRatio * 100}% 发薪日: ${res.profile.payday}号\n` +
							`目标配置: ${Object.entries(res.profile.targets).map(([k, v]) => `${ASSET_CLASSES[k] ?? k} ${v * 100}%`).join(" / ")}`,
						res,
					);
				}
				case "profile": {
					if (params.profilePatch && Object.keys(params.profilePatch).length) {
						const merged = { ...profile, ...(params.profilePatch as Partial<Profile>) } as Profile;
						merged.targets = { ...profile.targets, ...((params.profilePatch.targets as Record<string, number>) ?? {}) };
						merged.constraints = { ...profile.constraints, ...((params.profilePatch.constraints as object) ?? {}) };
						saveProfile(merged);
						return text(`画像已更新:\n${JSON.stringify(merged, null, 2)}`, merged);
					}
					return text(JSON.stringify(profile, null, 2), profile);
				}
				case "refresh": {
					const res = await refreshNavs(portfolio, signal);
					savePortfolio(portfolio);
					const stale = Object.entries(portfolio.lastNav)
						.map(([c, v]) => `${c} ${v.nav}@${v.date}`)
						.join(", ");
					return text(`净值已刷新: 成功 ${res.updated.length} 只${res.failed.length ? `, 失败 ${res.failed.join(", ")}` : ""}\n${stale}`, res);
				}
				case "cash": {
					if (!params.amount || !params.cashType) return text("cash 需要 cashType(deposit/withdraw) 和 amount");
					const entry = applyCash(portfolio, params.cashType, params.amount, params.date, params.note);
					savePortfolio(portfolio);
					return text(`已记录${params.cashType === "deposit" ? "入金" : "取出"} ${money(params.amount)}, 当前可用现金 ${money(portfolio.cash)}`, entry);
				}
				case "trade": {
					if (!params.code || !params.side || !params.amount) return text("trade 需要 code / side / amount");
					const res = await applyTrade(
						profile,
						portfolio,
						{
							code: params.code,
							side: params.side,
							amount: params.amount,
							assetClass: params.assetClass,
							nav: params.nav,
							fee: params.fee,
							date: params.date,
							note: params.note,
						},
						signal,
					);
					if (res.ok) savePortfolio(portfolio);
					const lines = [`${res.ok ? "✅" : "❌"} ${res.message}`];
					if (res.warnings.length) lines.push(...res.warnings.map((w) => `- ${w}`));
					if (res.ok) lines.push(`当前可用现金 ${money(portfolio.cash)}`);
					return text(lines.join("\n"), res);
				}
				case "watch": {
					const wl = loadWatchlist();
					const act = params.watchAction ?? "list";
					if (act === "add") {
						if (!params.code || !params.assetClass) return text("watch add 需要 code 和 assetClass");
						const item: WatchItem = {
							code: params.code,
							assetClass: params.assetClass,
							reason: params.reason,
							priority: params.priority ?? 0,
							addedAt: new Date().toISOString().slice(0, 10),
						};
						const idx = wl.items.findIndex((i) => i.code === params.code);
						if (idx >= 0) wl.items[idx] = { ...wl.items[idx], ...item };
						else wl.items.push(item);
						saveWatchlist(wl);
						return text(`关注池已加入/更新: ${params.code} (${ASSET_CLASSES[params.assetClass] ?? params.assetClass}) 理由: ${params.reason ?? "未填"}`, wl);
					}
					if (act === "remove") {
						if (!params.code) return text("watch remove 需要 code");
						wl.items = wl.items.filter((i) => i.code !== params.code);
						saveWatchlist(wl);
						return text(`关注池已移除: ${params.code}, 剩余 ${wl.items.length} 只`, wl);
					}
					return text(
						wl.items.length
							? wl.items
									.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
									.map((i) => `${ASSET_CLASSES[i.assetClass] ?? i.assetClass} | ${i.code} | 优先级${i.priority ?? 0} | ${i.reason ?? ""}`)
									.join("\n")
							: "关注池为空。用 invest_fund_rank + invest_fund_detail 筛选后加入。",
						wl,
					);
				}
				case "history": {
					const ledger = readLedger();
					const limit = params.limit ?? 40;
					const rows = ledger.slice(-limit);
					if (!rows.length) return text("暂无流水记录");
					const lines = rows.map(
						(e) => `${e.date} ${e.type.padEnd(8)} ${e.code ?? "-"} ${money(e.amount)}${e.shares ? ` ${e.shares}份@${e.nav ?? "-"}` : ""}${e.note ? ` | ${e.note}` : ""}`,
					);
					const deposits = ledger.filter((e) => e.type === "deposit").reduce((a, e) => a + e.amount, 0);
					const buys = ledger.filter((e) => e.type === "buy").reduce((a, e) => a + e.amount, 0);
					return text(`累计入金 ${money(deposits)} | 累计买入 ${money(buys)} | 流水 ${ledger.length} 笔\n${lines.join("\n")}`, {
						ledger: rows,
						deposits,
						buys,
					});
				}
				case "snapshot": {
					const s = recordSnapshot(profile, portfolio);
					return text(`已记录 ${s.date} 快照: 总资产 ${money(s.total)}`, s);
				}
				default: {
					await refreshNavs(portfolio, signal);
					savePortfolio(portfolio);
					const status = computeStatus(profile, portfolio, { vals: await classValuations(profile, signal) });
					let estimates: Record<string, FundEstimate> = {};
					try {
						const list = await getFundEstimates(portfolio.holdings.filter((h) => !h.isCashLike).map((h) => h.code), signal);
						estimates = Object.fromEntries(list.map((e) => [e.code, e]));
					} catch {
						// 盘中估值取不到不影响持仓结论
					}
					return text(renderStatus(profile, portfolio, status, estimates), { ...status, estimates });
				}
			}
		},
	});

	// -----------------------------------------------------------------------
	// invest_plan
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "invest_plan",
		label: "投入计划",
		description:
			"生成或执行本月投入计划。按目标权重→估值分位倾斜→缺口分配→单一标的上限裁剪, 输出每只基金买多少钱。" +
			"action=preview 只算不记账; action=commit 按计划逐笔买入(必须先用 preview 给用户过目并得到确认)。" +
			"amount 省略时用 画像月薪×投入比例。",
		promptSnippet: "invest_plan: 月度买入计划(估值倾斜+风控裁剪)与执行",
		promptGuidelines: [
			NO_FABRICATE,
			"用 invest_plan 生成月度计划时, 不要因为某类基金'看起来好'就跳过估值倾斜和单一标的上限; 计划里的警告必须原样呈现给用户。",
			"invest_plan action=commit 会真实记账, 执行前必须先把 preview 结果给用户确认。",
		],
		parameters: Type.Object({
			action: StringEnum(["preview", "commit", "list"] as const),
			amount: Type.Optional(Type.Number({ description: "本月投入金额(元); 省略则用 月薪×投入比例" })),
			planId: Type.Optional(Type.String({ description: "commit 时指定要执行的计划" })),
			overrides: Type.Optional(
				Type.Record(
					Type.String(),
					Type.Array(Type.Object({ code: Type.String(), weight: Type.Number(), name: Type.Optional(Type.String()) })),
					{ description: '指定每个资产类别的标的与权重, 如 {"global":[{"code":"000834","weight":1}]}' },
				),
			),
		}),
		async execute(_id, params, signal) {
			const profile = loadProfile();
			const portfolio = loadPortfolio();

			if (params.action === "list") {
				const commits = readLedger().filter((e) => (e.note ?? "").includes("计划 plan-"));
				return text(`历史计划执行流水 ${commits.length} 笔:\n${commits.map((c) => `${c.date} ${c.code} ${money(c.amount)}`).join("\n") || "无"}`, { commits });
			}

			if (params.action === "commit") {
				if (!params.planId) return text("commit 需要 planId (来自 preview 结果)");
				const res = await commitPlan(profile, portfolio, params.planId, signal);
				const lines = [
					res.ok ? "✅ 计划执行完成" : "⚠️ 计划部分执行",
					...res.applied.map((a) => `  买入 ${a.name}(${a.code}) ${money(a.amount)}${a.shares ? ` ≈ ${a.shares} 份` : ""}`),
					...res.failed.map((f) => `  ❌ ${f.code} 失败: ${f.reason}`),
					`当前现金 ${money(res.cashAfter)}`,
				];
				return text(lines.join("\n"), res);
			}

			let amount = params.amount;
			if (amount === undefined) {
				if (profile.monthlyInvestAmount) {
					amount = round(profile.monthlyInvestAmount, 2);
				} else if (profile.monthlySalary) {
					amount = round(profile.monthlySalary * profile.investRatio, 2);
				} else {
					return text(
						"未设置每月投入额。请用 invest_portfolio action=profile 设置 monthlyInvestAmount（直接给金额，如 4000）或 monthlySalary（按比例算），或调用时直接传 amount。",
					);
				}
			}

			const plan = await buildPlan(profile, portfolio, {
				amount,
				overrides: params.overrides as PlanResult extends never ? never : any,
				signal,
			});
			return text(renderPlan(profile, plan), plan);
		},
	});

	// -----------------------------------------------------------------------
	// invest_notify
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "invest_notify",
		label: "推送到飞书",
		description:
			"把报告推送到飞书(卡片渲染 Markdown)。定时任务里必须用它投递, 否则你看不到结果。" +
			"可同时用 filePath 把报告原文件作为附件发出。",
		promptSnippet: "invest_notify: 推送报告到飞书",
		parameters: Type.Object({
			title: Type.String({ description: "卡片标题, 如 '投资周报 2026-09-26'" }),
			markdown: Type.String({ description: "报告正文(Markdown)" }),
			filePath: Type.Optional(Type.String({ description: "同时发送的归档文件路径(工作区内)" })),
		}),
		async execute(_id, params) {
			const res = await sendMarkdown(params.title, params.markdown);
			const lines = [res.ok ? `✅ ${res.detail}` : `❌ ${res.detail}`];
			if (res.ok && params.filePath) {
				const f = await sendFile(params.filePath);
				lines.push(f.ok ? `✅ ${f.detail}` : `❌ 附件发送失败: ${f.detail}`);
			}
			return text(lines.join("\n"), res);
		},
	});

	// -----------------------------------------------------------------------
	// 命令
	// -----------------------------------------------------------------------
	pi.registerCommand("invest", {
		description: "打印投资组合看板(不调用模型)",
		handler: async (_args, ctx) => {
			const profile = loadProfile();
			const portfolio = loadPortfolio();
			await refreshNavs(portfolio);
			savePortfolio(portfolio);
			const status = computeStatus(profile, portfolio, { vals: await classValuations(profile) });
			const md = renderStatus(profile, portfolio, status);
			ctx.ui.notify(md.split("\n").slice(0, 3).join(" | "), "info");
			pi.sendMessage({ customType: "pi-invest", content: md, display: true }, { deliverAs: "nextTurn" });
		},
	});

	pi.registerCommand("invest-status", {
		description: "数据源/工作区/推送通道自检",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`工作区: ${getWorkspace()}\n配置: ${CONFIG_FILE}\n${feishuStatus()}`, "info");
		},
	});

	// 初始化工作区(若未初始化则创建默认画像, 不覆盖已有文件)
	// 顺带记录当日估值快照: 自建分位靠时间累积, 幂等(一天只记一次), 不消耗模型 token
	pi.on("session_start", async (_event, ctx) => {
		try {
			const p = readJson<Record<string, unknown> | null>(ws("profile.json"), null);
			if (!p) {
				initWorkspace({});
				ctx.ui.notify(`pi-invest: 已创建默认画像 ${ws("profile.json")}, 请用 /invest-status 查看工作区`, "info");
			}
		} catch {
			// 初始化失败不阻塞会话
		}
		try {
			const res = await recordDailySnapshot({});
			if (!res.skipped) ctx.ui.notify(`pi-invest: ${res.message}`, "info");
		} catch (err) {
			ctx.ui.notify(`pi-invest: 估值快照记录失败 - ${err instanceof Error ? err.message : String(err)}`, "warning");
		}
	});
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function renderStatus(
	profile: Profile,
	portfolio: ReturnType<typeof loadPortfolio>,
	s: PortfolioStatus,
	estimates: Record<string, FundEstimate> = {},
): string {
	const lines: string[] = [];
	lines.push(`# 组合看板 (${new Date().toISOString().slice(0, 10)})`);
	lines.push(
		`总资产 **${money(s.total)}** | 持仓市值 ${money(s.investedMarketValue)} | 现金 ${money(s.cash)} | 浮盈 ${money(s.pnl)} (${pct(s.pnlPct)})` +
			`${s.xirrPct !== undefined ? ` | 年化(XIRR) **${pct(s.xirrPct)}**` : ""}`,
	);
	lines.push(`股票 ${s.equityRatio}% | 风险资产(含商品) ${s.stockRatio}% | 现金 ${s.cashRatio}%`);
	// 盘中估算: 明确标注非官方, 且不参与上面的任何金额计算
	const estCodes = Object.keys(estimates);
	if (estCodes.length && s.total > 0) {
		let weighted = 0;
		let weightSum = 0;
		for (const h of s.holdings) {
			const e = estimates[h.code];
			if (!e) continue;
			weighted += e.estimatePct * (h.marketValue / s.total);
			weightSum += h.marketValue / s.total;
		}
		if (weightSum > 0) {
			lines.push(
				`今日盘中估算 ≈ **${pct(weighted)}**（第三方估算，非官方净值，仅供参考；覆盖持仓 ${round(weightSum * 100, 1)}%）`,
			);
		}
	}
	lines.push("");
	lines.push("## 配置偏离 (目标已按估值分位动态倾斜)");
	lines.push("| 资产类别 | 静态目标 | 分位 | 系数 | 动态目标 | 实际 | 偏离 | 状态 |");
	lines.push("|---|---|---|---|---|---|---|---|");
	for (const c of s.byClass) {
		lines.push(
			`| ${c.label} | ${c.targetWeight}% | ${c.valuationPct !== undefined ? `${c.valuationPct}%` : "—"} | ×${c.tiltFactor} | ${c.tiltedWeight}% | ${c.weight}% | ${c.driftPp > 0 ? "+" : ""}${c.driftPp}pp | ${c.status} |`,
		);
	}
	if (s.rebalance.length) {
		lines.push("");
		lines.push("## 再平衡提示");
		for (const r of s.rebalance) lines.push(`- ${r.action} ${r.label} 约 ${money(r.amount)} (${r.trigger})`);
	}
	if (s.holdings.length) {
		lines.push("");
		lines.push("## 持仓");
		lines.push("| 代码 | 名称 | 类别 | 市值 | 占比 | 成本 | 盈亏 | 净值 | 今日估算 |");
		lines.push("|---|---|---|---|---|---|---|---|---|");
		for (const h of s.holdings) {
			const e = estimates[h.code];
			lines.push(
				`| ${h.code} | ${h.name} | ${h.assetClassLabel} | ${money(h.marketValue)} | ${h.weight}% | ${money(h.costAmount)} | ${money(h.pnl)} (${pct(h.pnlPct)}) | ${h.nav}${h.navDate ? `(${h.navDate})` : ""} | ${e ? pct(e.estimatePct) : "—"} |`,
			);
		}
	}
	if (s.warnings.length) {
		lines.push("");
		lines.push("## ⚠️ 风控告警");
		for (const w of s.warnings) lines.push(`- ${w}`);
	}
	return lines.join("\n");
}

function renderPlan(profile: Profile, plan: PlanResult): string {
	const lines: string[] = [];
	lines.push(`# 本月投入计划 ${plan.planId}`);
	lines.push(
		`本次可部署 **${money(plan.deployable)}** (计划额 ${money(plan.amount)}) | 总资产 ${money(plan.totalBefore)} | 执行后现金 ${money(plan.cashAfter)}`,
	);
	lines.push("");
	lines.push("## 资产配置(含估值倾斜)");
	lines.push("| 类别 | 基准权重 | 分位 | 系数 | 倾斜后 | 当前 | 缺口 | 本次分配 |");
	lines.push("|---|---|---|---|---|---|---|---|");
	for (const c of plan.classes) {
		lines.push(
			`| ${c.label} | ${c.targetWeight}% | ${c.valuationPct !== undefined ? `${c.valuationPct}%` : "—"} | ×${c.tiltFactor} | ${c.tiltedWeight}% | ${c.currentWeight}% | ${money(c.gap)} | ${money(c.directed)} |`,
		);
	}
	lines.push("");
	lines.push("## 买入清单");
	if (!plan.lines.length) lines.push("(无买入动作)");
	for (const l of plan.lines) {
		lines.push(`- **${l.name}(${l.code})** ${money(l.amount)}${l.nav ? ` @ ${l.nav}` : ""}${l.estShares ? ` ≈ ${l.estShares} 份` : ""}${l.isNew ? " 🆕新标的" : ""}`);
		lines.push(`  - ${l.reason}`);
	}
	lines.push("");
	lines.push(`合计分配 ${money(plan.allocated)} | 留存现金 ${money(plan.unallocated)}`);
	if (plan.notes.length) {
		lines.push("");
		for (const n of plan.notes) lines.push(`- ℹ️ ${n}`);
	}
	if (plan.warnings.length) {
		lines.push("");
		lines.push("## ⚠️ 执行前必须处理");
		for (const w of plan.warnings) lines.push(`- ${w}`);
	}
	lines.push("");
	lines.push(`确认后执行: \`invest_plan action=commit planId=${plan.planId}\``);
	return lines.join("\n");
}
