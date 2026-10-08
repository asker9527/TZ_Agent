/**
 * pi-invest: 组合层
 *
 * 负责: 投资人画像、持仓台账、交易流水、组合计算、风控硬约束、月度投入计划算法。
 * 设计原则:
 *   - 组合数字全部由代码计算, 模型只做选择与解释
 *   - 风控是硬约束(抛错/拒绝), 不是建议
 *   - 流水 append-only, 任何时候可回溯
 */

import { appendFileSync, readFileSync } from "node:fs";
import { ensureDir, fileExists, readJson, ws, writeJson } from "./config";
import { type FundBrief, type FundSnapshot, getFundNavInfo, getFundSnapshot, round, valuationPercentile } from "./datasource";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export const ASSET_CLASSES: Record<string, string> = {
	cn_broad: "A股宽基",
	cn_theme: "A股行业/主题",
	global: "海外QDII",
	gold: "黄金/商品",
	bond: "债券",
	cash: "现金/货基",
};

export type AssetClass = keyof typeof ASSET_CLASSES;

export interface Holding {
	code: string;
	name?: string;
	assetClass: AssetClass | string;
	shares: number;
	costAmount: number;
	firstBuyAt?: string;
	notes?: string;
	/** 货币基金等净值恒为 1 的品种 */
	isCashLike?: boolean;
}

export interface Portfolio {
	version: number;
	updatedAt: string;
	holdings: Holding[];
	cash: number;
	lastNav: Record<string, { nav: number; date: string }>;
	snapshots: Array<{ date: string; total: number; cash: number; byClass: Record<string, number> }>;
}

export interface Tilt {
	enabled: boolean;
	/** [分位上限, 系数] 升序 */
	bands: Array<[number, number]>;
}

export interface Profile {
	version: number;
	name?: string;
	/** 税后月薪; null 表示未设置 */
	monthlySalary: number | null;
	/** 直接指定每月投入金额(元); 设了就优先于 月薪×比例 */
	monthlyInvestAmount?: number | null;
	investRatio: number;
	payday: number;
	paydayWindowDays: number;
	riskLevel: string;
	targets: Record<string, number>;
	benchmark: Record<string, string[]>;
	tilt: Tilt;
	constraints: {
		maxSingleFund: number;
		minCashRatio: number;
		maxStockRatio: number;
		avoidChasingPct: number;
		minBuyAmount: number;
		/** 单只基金的最小有意义买入额; 低于此值不开新仓, 资金累积到下期 */
		minFundAmount: number;
		/** 单期最多开几个新仓位（避免小资金过度分散） */
		maxNewPositions: number;
	};
	rebalance: { absBand: number; relBand: number };
	updatedAt?: string;
}

export interface LedgerEntry {
	id: string;
	date: string;
	type: "deposit" | "withdraw" | "buy" | "sell" | "dividend";
	code?: string;
	assetClass?: string;
	amount: number;
	shares?: number;
	nav?: number;
	fee?: number;
	note?: string;
	source?: string;
	planId?: string;
}

export interface WatchItem {
	code: string;
	assetClass: AssetClass | string;
	reason?: string;
	addedAt?: string;
	/** 数值越大越优先被选为新建仓标的 */
	priority?: number;
}

export interface Watchlist {
	version: number;
	updatedAt: string;
	items: WatchItem[];
}

// ---------------------------------------------------------------------------
// 默认画像
// ---------------------------------------------------------------------------

export function defaultProfile(): Profile {
	return {
		version: 1,
		monthlySalary: null,
		monthlyInvestAmount: null,
		investRatio: 0.4,
		payday: 10,
		paydayWindowDays: 3,
		riskLevel: "aggressive",
		targets: { cn_broad: 0.45, cn_theme: 0.15, global: 0.2, gold: 0.05, bond: 0.1, cash: 0.05 },
		benchmark: {
			cn_broad: ["SH000300", "SH000905"],
			cn_theme: ["CSI931087", "SZ399989", "CSI930652"],
			global: ["NDX", "SP500", "HKHSTECH"],
			gold: [],
			bond: [],
			cash: [],
		},
		tilt: {
			enabled: true,
			bands: [
				[20, 1.4],
				[50, 1.0],
				[80, 0.7],
				[100.01, 0.4],
			],
		},
		constraints: {
			maxSingleFund: 0.25,
			minCashRatio: 0.05,
			maxStockRatio: 0.95,
			avoidChasingPct: 25,
			minBuyAmount: 10,
			minFundAmount: 300,
			maxNewPositions: 3,
		},
		rebalance: { absBand: 0.05, relBand: 0.25 },
	};
}

export function defaultPortfolio(): Portfolio {
	return { version: 1, updatedAt: new Date().toISOString(), holdings: [], cash: 0, lastNav: {}, snapshots: [] };
}

export function loadProfile(): Profile {
	const stored = readJson<Partial<Profile>>(ws("profile.json"), {});
	const base = defaultProfile();
	return {
		...base,
		...stored,
		targets: { ...base.targets, ...(stored.targets ?? {}) },
		benchmark: { ...base.benchmark, ...(stored.benchmark ?? {}) },
		tilt: { ...base.tilt, ...(stored.tilt ?? {}) },
		constraints: { ...base.constraints, ...(stored.constraints ?? {}) },
		rebalance: { ...base.rebalance, ...(stored.rebalance ?? {}) },
	};
}

export function saveProfile(profile: Profile): void {
	writeJson(ws("profile.json"), { ...profile, updatedAt: new Date().toISOString() });
}

export function loadPortfolio(): Portfolio {
	const stored = readJson<Partial<Portfolio>>(ws("portfolio.json"), {});
	const base = defaultPortfolio();
	return {
		...base,
		...stored,
		holdings: stored.holdings ?? [],
		lastNav: stored.lastNav ?? {},
		snapshots: (stored.snapshots ?? []).slice(-400),
	};
}

export function savePortfolio(p: Portfolio): void {
	writeJson(ws("portfolio.json"), { ...p, updatedAt: new Date().toISOString() });
}

export function loadWatchlist(): Watchlist {
	return readJson<Watchlist>(ws("watchlist.json"), { version: 1, updatedAt: "", items: [] });
}

export function saveWatchlist(w: Watchlist): void {
	writeJson(ws("watchlist.json"), { ...w, updatedAt: new Date().toISOString() });
}

// ---------------------------------------------------------------------------
// 流水
// ---------------------------------------------------------------------------

export function ledgerPath(): string {
	return ws("ledger.jsonl");
}

export function appendLedger(entry: LedgerEntry): void {
	ensureDir(ws());
	appendFileSync(ledgerPath(), `${JSON.stringify(entry)}\n`, "utf8");
}

export function readLedger(): LedgerEntry[] {
	try {
		return readFileSync(ledgerPath(), "utf8")
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l) as LedgerEntry);
	} catch {
		return [];
	}
}

export function newId(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// ---------------------------------------------------------------------------
// 净值刷新
// ---------------------------------------------------------------------------

export interface NavInfo {
	nav: number;
	date: string;
	changePct?: number;
	accNav?: number;
	buy?: string;
	sell?: string;
}

const NAV_TTL = 30 * 60 * 1000;

/** 取最新净值 (带 30 分钟缓存), 并将结果写回 portfolio.lastNav */
export async function refreshNavs(
	portfolio: Portfolio,
	signal?: AbortSignal,
): Promise<{ updated: string[]; failed: string[] }> {
	const updated: string[] = [];
	const failed: string[] = [];
	for (const h of portfolio.holdings) {
		if (h.isCashLike) continue;
		try {
			const info =
				(cacheNav(h.code) as NavInfo | undefined) ??
				((await getFundNavInfo(h.code, signal)) as NavInfo | undefined);
			if (info && Number.isFinite(info.nav) && info.nav > 0) {
				setCacheNav(h.code, info);
				portfolio.lastNav[h.code] = { nav: info.nav, date: info.date };
				updated.push(h.code);
			} else {
				failed.push(h.code);
			}
		} catch {
			failed.push(h.code);
		}
	}
	return { updated, failed };
}

// 净值内存+磁盘缓存(复用 datasource 的 cached 会引入循环, 这里用轻量实现)
const navMem = new Map<string, { at: number; info: NavInfo }>();

function cacheNav(code: string): NavInfo | undefined {
	const hit = navMem.get(code);
	if (hit && Date.now() - hit.at < NAV_TTL) return hit.info;
	const disk = readJson<{ at: number; info: NavInfo } | null>(ws("cache", `nav_${code}.json`), null);
	if (disk && Date.now() - disk.at < NAV_TTL) {
		navMem.set(code, disk);
		return disk.info;
	}
	return undefined;
}

function setCacheNav(code: string, info: NavInfo): void {
	const rec = { at: Date.now(), info };
	navMem.set(code, rec);
	try {
		writeJson(ws("cache", `nav_${code}.json`), rec);
	} catch {
		// 忽略缓存写失败
	}
}

export function navOf(portfolio: Portfolio, holding: Holding): { nav: number; date?: string; stale: boolean } {
	if (holding.isCashLike) return { nav: 1, date: undefined, stale: false };
	const cached = portfolio.lastNav[holding.code];
	if (cached && cached.nav > 0) return { nav: cached.nav, date: cached.date, stale: false };
	return { nav: 0, stale: true };
}

// ---------------------------------------------------------------------------
// XIRR
// ---------------------------------------------------------------------------

export function xirr(flows: Array<{ date: string; amount: number }>): number | undefined {
	if (flows.length < 2) return undefined;
	const hasNeg = flows.some((f) => f.amount < 0);
	const hasPos = flows.some((f) => f.amount > 0);
	if (!hasNeg || !hasPos) return undefined;
	const t0 = new Date(`${flows[0].date}T00:00:00Z`).getTime();
	const npv = (rate: number) =>
		flows.reduce((sum, f) => {
			const years = (new Date(`${f.date}T00:00:00Z`).getTime() - t0) / (365 * 86400000);
			return sum + f.amount / (1 + rate) ** years;
		}, 0);
	let lo = -0.9999;
	let hi = 10;
	let fLo = npv(lo);
	let fHi = npv(hi);
	if (!Number.isFinite(fLo) || !Number.isFinite(fHi) || fLo * fHi > 0) return undefined;
	for (let i = 0; i < 200; i++) {
		const mid = (lo + hi) / 2;
		const fMid = npv(mid);
		if (Math.abs(fMid) < 1e-9) return round(mid * 100, 2);
		if (fLo * fMid < 0) {
			hi = mid;
			fHi = fMid;
		} else {
			lo = mid;
			fLo = fMid;
		}
	}
	return round(((lo + hi) / 2) * 100, 2);
}

// ---------------------------------------------------------------------------
// 组合计算
// ---------------------------------------------------------------------------

export interface HoldingView {
	code: string;
	name: string;
	assetClass: string;
	assetClassLabel: string;
	shares: number;
	costAmount: number;
	nav: number;
	navDate?: string;
	navStale: boolean;
	marketValue: number;
	pnl: number;
	pnlPct: number;
	weight: number;
}

export interface ClassView {
	key: string;
	label: string;
	/** 画像里的静态目标权重(%) */
	targetWeight: number;
	/** 估值倾斜后的动态目标权重(%); 未提供估值时等于 targetWeight */
	tiltedWeight: number;
	targetValue: number;
	value: number;
	weight: number;
	/** 实际权重 - 动态目标 (pp) */
	driftPp: number;
	gap: number;
	tiltFactor: number;
	valuationPct?: number;
	status: "超配" | "低配" | "达标" | "无标的";
}

export interface RebalanceHint {
	key: string;
	label: string;
	driftPp: number;
	action: "减仓" | "加仓";
	amount: number;
	trigger: string;
}

export interface PortfolioStatus {
	total: number;
	cash: number;
	investedMarketValue: number;
	investedCost: number;
	pnl: number;
	pnlPct: number;
	stockRatio: number;
	/** 纯股票仓位(不含黄金商品) */
	equityRatio: number;
	cashRatio: number;
	xirrPct?: number;
	firstFlowDate?: string;
	holdings: HoldingView[];
	byClass: ClassView[];
	rebalance: RebalanceHint[];
	warnings: string[];
}

/** 按目标分位计算倾斜系数 */
export function tiltFactor(pct: number | undefined, tilt: Tilt): number {
	if (!tilt.enabled || pct === undefined || !Number.isFinite(pct)) return 1;
	for (const [upper, factor] of tilt.bands) {
		if (pct < upper) return factor;
	}
	return 1;
}

export interface StatusOpts {
	vals?: Record<string, number | undefined>;
}

export function computeStatus(
	profile: Profile,
	portfolio: Portfolio,
	opts: StatusOpts = {},
): PortfolioStatus {
	const warnings: string[] = [];
	const byClassValue: Record<string, number> = {};
	const holdings: HoldingView[] = [];
	let investedMarketValue = 0;
	let investedCost = 0;

	for (const h of portfolio.holdings) {
		const { nav, date, stale } = navOf(portfolio, h);
		if (stale) warnings.push(`${h.code} 无净值数据, 请先刷新净值(portfolio action=refresh)`);
		const mv = h.shares * nav;
		investedMarketValue += mv;
		investedCost += h.costAmount;
		byClassValue[h.assetClass] = (byClassValue[h.assetClass] ?? 0) + mv;
		holdings.push({
			code: h.code,
			name: h.name ?? h.code,
			assetClass: h.assetClass,
			assetClassLabel: ASSET_CLASSES[h.assetClass] ?? h.assetClass,
			shares: round(h.shares, 4),
			costAmount: round(h.costAmount, 2),
			nav,
			navDate: date,
			navStale: stale,
			marketValue: round(mv, 2),
			pnl: round(mv - h.costAmount, 2),
			pnlPct: h.costAmount > 0 ? round(((mv - h.costAmount) / h.costAmount) * 100, 2) : 0,
			weight: 0,
		});
	}
	byClassValue.cash = (byClassValue.cash ?? 0) + portfolio.cash;
	const total = investedMarketValue + portfolio.cash;

	for (const h of holdings) h.weight = total > 0 ? round((h.marketValue / total) * 100, 2) : 0;

	// 估值倾斜后的动态目标: 状态/再平衡/计划三处必须用同一套目标,
	// 否则高估值时会出现「实际已达动态目标, 却一直报低配并要求加仓」的自相矛盾指令。
	const classKeys = [...new Set([...Object.keys(profile.targets), ...Object.keys(byClassValue)])];
	const factors: Record<string, number> = {};
	const valuationPcts: Record<string, number | undefined> = {};
	let weightedSum = 0;
	for (const key of classKeys) {
		const pct = opts.vals?.[key];
		valuationPcts[key] = pct;
		factors[key] = tiltFactor(pct, profile.tilt);
		weightedSum += (profile.targets[key] ?? 0) * factors[key];
	}
	const tilted: Record<string, number> = {};
	for (const key of classKeys) {
		const raw = (profile.targets[key] ?? 0) * factors[key];
		tilted[key] = weightedSum > 0 ? raw / weightedSum : (profile.targets[key] ?? 0);
	}

	const byClass: ClassView[] = classKeys.map((key) => {
		const targetWeight = profile.targets[key] ?? 0;
		const target = tilted[key] ?? targetWeight;
		const value = byClassValue[key] ?? 0;
		const weight = total > 0 ? value / total : 0;
		const driftPp = round((weight - target) * 100, 2);
		const targetValue = total * target;
		return {
			key,
			label: ASSET_CLASSES[key] ?? key,
			targetWeight: round(targetWeight * 100, 2),
			tiltedWeight: round(target * 100, 2),
			targetValue: round(targetValue, 2),
			value: round(value, 2),
			weight: round(weight * 100, 2),
			driftPp,
			gap: round(targetValue - value, 2),
			tiltFactor: round(factors[key] ?? 1, 2),
			valuationPct: valuationPcts[key] === undefined ? undefined : round(valuationPcts[key] as number, 1),
			status: Math.abs(driftPp) <= profile.rebalance.absBand * 100 ? "达标" : driftPp > 0 ? "超配" : "低配",
		};
	});

	const equityValue = Object.entries(byClassValue)
		.filter(([k]) => k !== "cash" && k !== "bond" && k !== "gold")
		.reduce((a, [, v]) => a + v, 0);
	const stockValue = Object.entries(byClassValue)
		.filter(([k]) => k !== "cash" && k !== "bond")
		.reduce((a, [, v]) => a + v, 0);

	// 再平衡提示
	const rebalance: RebalanceHint[] = [];
	for (const c of byClass) {
		if (c.key === "cash" || c.targetWeight === 0) continue;
		const absTrigger = Math.abs(c.driftPp) > profile.rebalance.absBand * 100;
		const relTrigger = c.tiltedWeight > 0 && Math.abs(c.weight - c.tiltedWeight) / c.tiltedWeight > profile.rebalance.relBand;
		if (absTrigger || relTrigger) {
			rebalance.push({
				key: c.key,
				label: c.label,
				driftPp: c.driftPp,
				action: c.driftPp > 0 ? "减仓" : "加仓",
				amount: round(Math.abs(c.gap), 2),
				trigger: absTrigger ? `绝对偏离 ${Math.abs(c.driftPp)}pp > ${profile.rebalance.absBand * 100}pp` : `相对偏离超 ${profile.rebalance.relBand * 100}%`,
			});
		}
	}

	// XIRR: 账户级现金流(入金/出金) + 期末市值
	const ledger = readLedger();
	const flows = ledger
		.filter((e) => e.type === "deposit" || e.type === "withdraw")
		.map((e) => ({ date: e.date, amount: e.type === "deposit" ? -Math.abs(e.amount) : Math.abs(e.amount) }));
	let xirrPct: number | undefined;
	let firstFlowDate: string | undefined;
	if (flows.length) {
		flows.sort((a, b) => a.date.localeCompare(b.date));
		firstFlowDate = flows[0].date;
		xirrPct = xirr([...flows, { date: new Date().toISOString().slice(0, 10), amount: total }]);
	}

	if (total > 0 && stockValue / total > profile.constraints.maxStockRatio + 1e-9) {
		warnings.push(`权益仓位 ${round((stockValue / total) * 100, 2)}% 超过上限 ${profile.constraints.maxStockRatio * 100}%`);
	}
	if (total > 0 && portfolio.cash / total < profile.constraints.minCashRatio) {
		warnings.push(`现金比例 ${round((portfolio.cash / total) * 100, 2)}% 低于下限 ${profile.constraints.minCashRatio * 100}%`);
	}
	for (const h of holdings) {
		if (total > 0 && h.marketValue / total > profile.constraints.maxSingleFund) {
			warnings.push(`${h.name}(${h.code}) 单一持仓占比 ${round((h.marketValue / total) * 100, 2)}% 超过上限 ${profile.constraints.maxSingleFund * 100}%`);
		}
	}

	return {
		total: round(total, 2),
		cash: round(portfolio.cash, 2),
		investedMarketValue: round(investedMarketValue, 2),
		investedCost: round(investedCost, 2),
		pnl: round(investedMarketValue - investedCost, 2),
		pnlPct: investedCost > 0 ? round(((investedMarketValue - investedCost) / investedCost) * 100, 2) : 0,
		stockRatio: total > 0 ? round((stockValue / total) * 100, 2) : 0,
		equityRatio: total > 0 ? round((equityValue / total) * 100, 2) : 0,
		cashRatio: total > 0 ? round((portfolio.cash / total) * 100, 2) : 0,
		xirrPct,
		firstFlowDate,
		holdings: holdings.sort((a, b) => b.marketValue - a.marketValue),
		byClass: byClass.sort((a, b) => b.targetWeight - a.targetWeight),
		rebalance,
		warnings,
	};
}

// ---------------------------------------------------------------------------
// 交易 / 现金
// ---------------------------------------------------------------------------

export interface TradeInput {
	date?: string;
	code: string;
	assetClass?: string;
	side: "buy" | "sell";
	amount: number;
	nav?: number;
	fee?: number;
	note?: string;
}

export interface TradeResult {
	ok: boolean;
	message: string;
	entry?: LedgerEntry;
	warnings: string[];
	holding?: Holding;
}

export async function applyTrade(
	profile: Profile,
	portfolio: Portfolio,
	input: TradeInput,
	signal?: AbortSignal,
): Promise<TradeResult> {
	const warnings: string[] = [];
	const date = input.date ?? new Date().toISOString().slice(0, 10);
	const code = input.code.trim();
	const amount = Math.abs(input.amount);
	if (!/^\d{6}$/.test(code)) return { ok: false, message: `基金代码格式不正确: ${code}`, warnings };
	if (!(amount > 0)) return { ok: false, message: "金额必须大于 0", warnings };

	let holding = portfolio.holdings.find((h) => h.code === code);
	let nav = input.nav;
	let name = holding?.name;

	if (nav === undefined) {
		const info = cacheNav(code) ?? ((await getFundNavInfo(code, signal)) as NavInfo | undefined);
		if (info) {
			setCacheNav(code, info);
			nav = info.nav;
			portfolio.lastNav[code] = { nav: info.nav, date: info.date };
		}
	}
	if (input.side === "buy") {
		if (nav === undefined || !(nav > 0)) {
			return { ok: false, message: `无法取得 ${code} 的最新净值, 请用 nav 参数显式指定后再记账`, warnings };
		}
	}
	if (!name) {
		try {
			const snap = (await getFundSnapshot(code, signal)) as FundSnapshot;
			name = snap.name;
		} catch {
			name = code;
		}
	}

	const assetClass = holding?.assetClass ?? input.assetClass;
	if (!assetClass) return { ok: false, message: `需要为 ${code} 指定 assetClass (${Object.keys(ASSET_CLASSES).join("/")})`, warnings };
	if (!ASSET_CLASSES[assetClass]) return { ok: false, message: `未知 assetClass: ${assetClass}`, warnings };

	const fee = input.fee ?? 0;
	const currentTotal = portfolio.holdings.reduce((a, h) => a + h.shares * navOf(portfolio, h).nav, 0) + portfolio.cash;

	if (input.side === "buy") {
		if (amount > portfolio.cash + 1e-6) {
			return {
				ok: false,
				message: `现金不足: 可用 ${round(portfolio.cash, 2)} 元, 本次买入 ${round(amount, 2)} 元。请先 record 工资入账 (portfolio action=cash type=deposit)`,
				warnings,
			};
		}
		const shares = (amount - fee) / (nav as number);
		const newValue = (holding ? holding.shares * navOf(portfolio, holding).nav : 0) + amount;
		const newTotal = currentTotal; // 买入不改变总资产
		if (newTotal > 0 && newValue / newTotal > profile.constraints.maxSingleFund + 1e-9) {
			return {
				ok: false,
				message: `风控拒绝: 买入后 ${name}(${code}) 占比将达 ${round((newValue / newTotal) * 100, 2)}%, 超过单一标的上限 ${round(profile.constraints.maxSingleFund * 100, 2)}%`,
				warnings,
			};
		}
		// 追涨检查
		try {
			const snap = await getFundSnapshot(code, signal);
			const m1 = snap.returns?.m1;
			if (m1 !== undefined && m1 > profile.constraints.avoidChasingPct) {
				warnings.push(`⚠️ ${name} 近1月涨幅 ${m1}% 已超过追涨阈值 ${profile.constraints.avoidChasingPct}%, 属于追高买入, 请确认这是计划内行为`);
			}
		} catch {
			// 拉不到档案不影响记账
		}

		portfolio.cash = round(portfolio.cash - amount, 4);
		if (holding) {
			holding.shares = round(holding.shares + shares, 6);
			holding.costAmount = round(holding.costAmount + amount, 4);
		} else {
			holding = {
				code,
				name,
				assetClass,
				shares: round(shares, 6),
				costAmount: amount,
				firstBuyAt: date,
			};
			portfolio.holdings.push(holding);
		}
		const entry: LedgerEntry = {
			id: newId("buy"),
			date,
			type: "buy",
			code,
			assetClass,
			amount: round(amount, 2),
			shares: round(shares, 6),
			nav,
			fee,
			note: input.note,
		};
		appendLedger(entry);
		return { ok: true, message: `买入记账完成: ${name}(${code}) ${round(amount, 2)} 元 @ ${nav}`, entry, warnings };
	}

	// sell
	if (!holding) return { ok: false, message: `没有 ${code} 的持仓, 无法卖出`, warnings };
	if (!(nav && nav > 0)) return { ok: false, message: `无法取得 ${code} 最新净值`, warnings };
	const sellShares = Math.min(holding.shares, amount / nav);
	if (sellShares <= 0) return { ok: false, message: "卖出份额为 0", warnings };
	const proceeds = round(sellShares * nav - fee, 4);
	const costPart = round((sellShares / holding.shares) * holding.costAmount, 4);
	holding.shares = round(holding.shares - sellShares, 6);
	holding.costAmount = round(holding.costAmount - costPart, 4);
	portfolio.cash = round(portfolio.cash + proceeds, 4);
	if (holding.shares <= 1e-6) {
		portfolio.holdings = portfolio.holdings.filter((h) => h.code !== code);
		holding = undefined;
	}
	const entry: LedgerEntry = {
		id: newId("sell"),
		date,
		type: "sell",
		code,
		assetClass,
		amount: round(proceeds, 2),
		shares: round(sellShares, 6),
		nav,
		fee,
		note: `已实现盈亏 ${round(proceeds - costPart, 2)} 元${input.note ? ` | ${input.note}` : ""}`,
	};
	appendLedger(entry);
	return { ok: true, message: `卖出记账完成: ${name}(${code}) 回款 ${round(proceeds, 2)} 元 @ ${nav}`, entry, warnings, holding };
}

export function applyCash(
	portfolio: Portfolio,
	type: "deposit" | "withdraw",
	amount: number,
	date?: string,
	note?: string,
): LedgerEntry {
	const d = date ?? new Date().toISOString().slice(0, 10);
	const amt = Math.abs(amount);
	if (type === "deposit") portfolio.cash = round(portfolio.cash + amt, 4);
	else {
		const real = Math.min(portfolio.cash, amt);
		portfolio.cash = round(portfolio.cash - real, 4);
	}
	const entry: LedgerEntry = { id: newId(type), date: d, type, amount: round(amt, 2), note };
	appendLedger(entry);
	return entry;
}

// ---------------------------------------------------------------------------
// 投入计划
// ---------------------------------------------------------------------------

export interface PlanLine {
	code: string;
	name: string;
	assetClass: string;
	assetClassLabel: string;
	amount: number;
	nav?: number;
	estShares?: number;
	reason: string;
	isNew: boolean;
}

export interface PlanClassRow {
	key: string;
	label: string;
	targetWeight: number;
	tiltedWeight: number;
	tiltFactor: number;
	valuationPct?: number;
	currentValue: number;
	currentWeight: number;
	gap: number;
	directed: number;
}

export interface PlanResult {
	planId: string;
	createdAt: string;
	/** 计划投入上限 */
	amount: number;
	/** 实际可部署金额 = min(计划额, 低配缺口, 现金扣除下限) */
	deployable: number;
	totalBefore: number;
	totalAfter: number;
	classes: PlanClassRow[];
	lines: PlanLine[];
	allocated: number;
	unallocated: number;
	/** 执行后预计现金 */
	cashAfter: number;
	warnings: string[];
	notes: string[];
}

/**
 * 在「每只基金剩余容量」约束下分配预算: 按权重比例, 超出容量部分多轮溢出给还有容量的标的。
 * 返回每只标的的金额与无法分配的剩余。
 */
export function allocateWithCaps(
	budget: number,
	picks: Array<{ weight: number; capacity: number }>,
): { alloc: number[]; leftover: number } {
	const alloc = picks.map(() => 0);
	const caps = picks.map((p) => Math.max(0, p.capacity));
	let remaining = Math.max(0, budget);
	for (let round = 0; round < 6 && remaining > 0.01; round++) {
		const open = picks.map((_, i) => i).filter((i) => caps[i] - alloc[i] > 0.01);
		if (!open.length) break;
		const wsum = open.reduce((a, i) => a + (picks[i].weight > 0 ? picks[i].weight : 1e-9), 0);
		let moved = 0;
		for (const i of open) {
			const w = picks[i].weight > 0 ? picks[i].weight : 1e-9;
			const want = (remaining * w) / wsum;
			const room = caps[i] - alloc[i];
			const give = Math.min(want, room);
			if (give > 0) {
				alloc[i] += give;
				moved += give;
			}
		}
		if (moved < 0.01) break;
		remaining -= moved;
	}
	return { alloc, leftover: round(remaining, 2) };
}

export interface PlanOpts {
	amount: number;
	/** 每个资产类别指定标的及权重, 覆盖默认的"按现有持仓等比补" */
	overrides?: Record<string, Array<{ code: string; weight: number; name?: string }>>;
	signal?: AbortSignal;
}

/** 月度投入计划: 目标权重 -> 估值倾斜 -> 缺口分配 -> 标的分配 -> 风控裁剪 */
export async function buildPlan(profile: Profile, portfolio: Portfolio, opts: PlanOpts): Promise<PlanResult> {
	const { amount, overrides, signal } = opts;
	const warnings: string[] = [];
	const notes: string[] = [];
	if (!(amount > 0)) throw new Error("投入金额必须大于 0");

	await refreshNavs(portfolio, signal);

	// 1) 先取估值分位 (基准指数), 倾斜与状态判断共用同一套输入
	const vals: Record<string, number | undefined> = {};
	for (const [cls, codes] of Object.entries(profile.benchmark)) {
		if (!codes?.length) continue;
		try {
			vals[cls] = await valuationPercentile(codes, signal);
		} catch {
			vals[cls] = undefined;
			warnings.push(`${ASSET_CLASSES[cls] ?? cls} 估值分位获取失败, 本类别不做倾斜`);
		}
	}

	const status = computeStatus(profile, portfolio, { vals });
	const totalBefore = status.total;
	// amount 是「本次打算部署的金额」, 默认这笔钱已在现金里(先入金再投)。
	// 不重复计入总资产, 否则会同时高估目标市值与单一标的上限空间。
	const totalAfter = totalBefore;
	const cashAvailable = portfolio.cash;
	const minCashRequired = totalBefore * profile.constraints.minCashRatio;
	const maxDeployable = Math.max(0, cashAvailable - minCashRequired);
	if (cashAvailable + 1e-6 < amount) {
		warnings.push(
			`现金只有 ${round(cashAvailable, 2)} 元, 少于本次计划投入 ${round(amount, 2)} 元。请先用 invest_portfolio action=cash cashType=deposit 记录工资入金, 再执行计划。`,
		);
	}

	// 2) 目标权重 = 画像权重 × 估值倾斜后归一化; 状态与计划共用同一套动态目标
	const factors: Record<string, number> = {};
	const tiltedWeight: Record<string, number> = {};
	for (const c of status.byClass) {
		factors[c.key] = c.tiltFactor;
		tiltedWeight[c.key] = c.tiltedWeight / 100;
	}

	// 3) 各类缺口 = 动态目标市值 - 当前市值
	const classRows: PlanClassRow[] = [];
	for (const c of status.byClass) {
		const currentValue = c.key === "cash" ? portfolio.cash : c.value;
		const tw = tiltedWeight[c.key] ?? 0;
		const gap = totalAfter * tw - currentValue;
		classRows.push({
			key: c.key,
			label: c.label,
			targetWeight: c.targetWeight,
			tiltedWeight: round(tw * 100, 2),
			tiltFactor: c.tiltFactor,
			valuationPct: c.valuationPct,
			currentValue: round(currentValue, 2),
			currentWeight: totalBefore > 0 ? round((currentValue / totalBefore) * 100, 2) : 0,
			gap: round(gap, 2),
			directed: 0,
		});
	}

	// 本次可部署金额 = min(计划额, 低配缺口合计, 现金扣除下限后可动用部分)
	const positives = classRows.filter((r) => r.gap > 0);
	const positiveSum = positives.reduce((a, r) => a + r.gap, 0);
	const deployable = round(Math.max(0, Math.min(amount, positiveSum, maxDeployable)), 2);
	const minFund = Math.max(profile.constraints.minBuyAmount, profile.constraints.minFundAmount ?? 0);
	const directed: Record<string, number> = {};
	if (positiveSum <= 0) {
		notes.push("所有资产类别都已达到或超过目标权重, 本月建议全部留作现金, 等待偏离出现后再投");
	} else if (deployable <= 0) {
		notes.push("可用现金不足以在不击穿现金下限的情况下继续投入, 本次不建议买入");
	} else {
		// 先按缺口比例分配, 再把金额过小、没有操作意义的类别剔除并把钱归给能吸收的类别,
		// 否则小额月份会开出一地几十元的小仓。
		let entries = positives.map((r) => ({ key: r.key, amt: round((r.gap / positiveSum) * deployable, 2) }));
		for (let iter = 0; iter < 4; iter++) {
			const keep = entries.filter((e) => e.amt >= minFund);
			const drop = entries.filter((e) => e.amt < minFund);
			if (!drop.length || !keep.length) break;
			const droppedAmt = drop.reduce((a, e) => a + e.amt, 0);
			const gapOf = (key: string) => positives.find((p) => p.key === key)?.gap ?? 0;
			const keepGapSum = keep.reduce((a, e) => a + gapOf(e.key), 0);
			if (keepGapSum <= 0) break;
			entries = keep.map((e) => ({ key: e.key, amt: round(e.amt + (droppedAmt * gapOf(e.key)) / keepGapSum, 2) }));
			if (drop.length) {
				notes.push(`${drop.map((d) => ASSET_CLASSES[d.key] ?? d.key).join("/")} 可投金额不足 ${minFund} 元, 本期不建仓, 资金留给其他类别或累积到下期`);
			}
		}
		for (const e of entries) directed[e.key] = e.amt;
		const unreachable = entries.filter((e) => e.amt < minFund);
		if (unreachable.length && !positives.some((p) => entries.some((e) => e.key === p.key && e.amt >= minFund))) {
			notes.push(`本期可投金额过小(${deployable} 元), 建议先累积到 ${minFund * 3} 元以上再建仓, 避免碎片持仓`);
		}
	}
	for (const r of classRows) r.directed = directed[r.key] ?? 0;
	if (positiveSum > deployable + 0.01) {
		notes.push(`低配缺口合计 ${round(positiveSum, 2)} 元, 本次只部署 ${deployable} 元(受投入额/现金下限限制), 剩余缺口留待下期`);
	}

	// 类别内标的分配
	const lines: PlanLine[] = [];
	const holdingsByClass: Record<string, Holding[]> = {};
	for (const h of portfolio.holdings) (holdingsByClass[h.assetClass] ??= []).push(h);

	for (const r of classRows) {
		const budget = directed[r.key] ?? 0;
		if (budget < minFund) continue;

		const classCap = totalAfter * profile.constraints.maxSingleFund;
		let picks: Array<{ code: string; name?: string; weight: number }> = [];
		if (overrides?.[r.key]?.length) {
			picks = overrides[r.key];
		} else {
			const hs = holdingsByClass[r.key] ?? [];
			const values = hs.map((h) => ({ h, v: h.shares * navOf(portfolio, h).nav }));
			const sum = values.reduce((a, x) => a + x.v, 0);
			if (hs.length) {
				picks = values.map((x) => ({ code: x.h.code, name: x.h.name, weight: Math.max(x.v, 1) }));
			}
			const existingCap = hs.reduce((a, h) => a + Math.max(0, classCap - h.shares * navOf(portfolio, h).nav), 0);
			const extraNeeded = Math.max(0, budget - existingCap);
			const watch = loadWatchlist()
				.items.filter((w) => w.assetClass === r.key && !hs.some((h) => h.code === w.code))
				.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
			if (extraNeeded > 0 && watch.length) {
				// 单一标的上限使一个大类需要多只基金; 按需启用，数量=缺口/单只容量
				const need = Math.max(1, Math.min(watch.length, Math.ceil(extraNeeded / Math.max(1, classCap))));
				const use = watch.slice(0, need);
				for (const w of use) picks.push({ code: w.code, weight: classCap });
				notes.push(
					`${r.label} ${hs.length ? "现有持仓容量不足, " : "无持仓, "}启用 ${use.map((w) => w.code).join(" + ")} (${use.map((w) => w.reason ?? "未注明理由").join("; ")})`,
				);
			} else if (!picks.length) {
				// 无持仓且无需新增(预算很小) : 用优先级最高的 1 只
				if (watch.length) {
					picks = [{ code: watch[0].code, weight: classCap }];
					notes.push(`${r.label} 无持仓, 使用关注池标的 ${watch[0].code} (${watch[0].reason ?? "未注明理由"})`);
				}
			}
		}

		if (!picks.length) {
			warnings.push(`${r.label} 需要投入 ${budget} 元但没有任何可用标的: 请先用 invest_fund_rank / invest_fund_detail 筛选并加入 watchlist`);
			continue;
		}

		const weightSumPicks = picks.reduce((a, p) => a + Math.max(0, p.weight), 0) || picks.length;
		// 单一标的上限是组合级约束, 在这里就按每只基金剩余容量分配,
		// 否则计划会给出连自己都无法执行的买入额。
		const caps = picks.map((p) => {
			const existing = portfolio.holdings.find((h) => h.code === p.code);
			const cur = existing ? existing.shares * navOf(portfolio, existing).nav : 0;
			return Math.max(0, classCap - cur);
		});
		const { alloc, leftover } = allocateWithCaps(
			budget,
			picks.map((p, i) => ({ weight: Math.max(0, p.weight) || 1, capacity: caps[i] })),
		);
		if (leftover >= profile.constraints.minBuyAmount) {
			const totalCap = round(picks.length * classCap, 2);
			warnings.push(
				`${r.label} 本次想投 ${budget} 元, 但在单一标的上限 ${round(profile.constraints.maxSingleFund * 100, 2)}% 下只能投 ${round(budget - leftover, 2)} 元` +
					` (该类别可用标的 ${picks.length} 只, 容量合计约 ${totalCap} 元)。剩余 ${round(leftover, 2)} 元留存现金。` +
					`解决办法: 用 invest_fund_rank + invest_fund_detail 为该类别再选 1-2 只不同指数的基金加入 watchlist。`,
			);
		}

		for (let i = 0; i < picks.length; i++) {
			const p = picks[i];
			const amt = round(alloc[i] ?? 0, 2);
			if (amt < minFund) {
				if (amt > 0) notes.push(`${p.code} 仅能分配 ${amt} 元, 低于最小建仓额 ${minFund} 元, 本期不建仓`);
				continue;
			}
			const existing = portfolio.holdings.find((h) => h.code === p.code);
			let nav: number | undefined;
			let name = p.name ?? existing?.name;
			let estShares: number | undefined;
			if (existing?.isCashLike) {
				nav = 1;
				estShares = amt;
			} else {
				try {
					const info = cacheNav(p.code) ?? ((await getFundNavInfo(p.code, signal)) as NavInfo | undefined);
					if (info) {
						setCacheNav(p.code, info);
						nav = info.nav;
						estShares = round(amt / nav, 2);
					}
					if (!name) name = (await getFundSnapshot(p.code, signal)).name;
				} catch {
					warnings.push(`${p.code} 净值获取失败, 计划中的份额数为估算`);
				}
			}
			lines.push({
				code: p.code,
				name: name ?? p.code,
				assetClass: r.key,
				assetClassLabel: r.label,
				amount: amt,
				nav,
				estShares,
				reason: `${r.label} 目标 ${round(r.tiltedWeight, 2)}% (静态 ${round(r.targetWeight, 2)}%, 估值倾斜 ×${round(factors[r.key] ?? 1, 2)}${vals[r.key] !== undefined ? `, 分位 ${round(vals[r.key] as number, 1)}%` : ""}), 当前 ${r.currentWeight}%`,
				isNew: !existing,
			});
		}
	}

	// 单一标的上限裁剪
	const projected = new Map<string, number>();
	for (const h of portfolio.holdings) projected.set(h.code, h.shares * navOf(portfolio, h).nav);
	let overCap = false;
	for (const line of lines) {
		const cur = projected.get(line.code) ?? 0;
		const cap = totalAfter * profile.constraints.maxSingleFund;
		if (cur + line.amount > cap + 0.01) {
			const allowed = Math.max(0, cap - cur);
			if (allowed < minFund) {
				warnings.push(`${line.name}(${line.code}) 已达单一标的上限 ${round(profile.constraints.maxSingleFund * 100, 2)}%, 本类别资金改投同类其他标的或留作现金`);
				line.amount = 0;
			} else if (allowed < line.amount - 0.01) {
				warnings.push(`${line.name}(${line.code}) 买入额被单一标的上限裁剪: ${line.amount} -> ${round(allowed, 2)} 元`);
				line.amount = round(allowed, 2);
			}
			overCap = true;
		}
		projected.set(line.code, cur + line.amount);
	}
	const finalLines = lines.filter((l) => l.amount >= minFund);
	// 单期开仓数上限。
	// 关键：必须按「类别分配额」排序来选类别，而不能按「单只基金金额」排序——
	// 否则一个被拆成 2 只的类别（如海外）会因单只金额变小而被误砍，
	// 而它很可能正是用户真正想要的方向。
	const maxNew = Math.max(1, profile.constraints.maxNewPositions ?? 3);
	const newLines = finalLines.filter((l) => l.isNew);
	let buyLines = finalLines;
	if (newLines.length > maxNew) {
		// 1) 按类别聚合本次要新建的金额
		const byClass = new Map<string, { amount: number; lines: PlanLine[] }>();
		for (const l of newLines) {
			const rec = byClass.get(l.assetClass) ?? { amount: 0, lines: [] };
			rec.amount += l.amount;
			rec.lines.push(l);
			byClass.set(l.assetClass, rec);
		}
		// 2) 类别按金额降序，取前 maxNew 个类别
		const ranked = [...byClass.entries()].sort((a, b) => b[1].amount - a[1].amount);
		const keepClasses = new Set(ranked.slice(0, maxNew).map(([k]) => k));
		const dropClasses = ranked.slice(maxNew);
		// 3) 未选中类别的基金金额清零（钱留存现金，下期继续）
		const dropped: PlanLine[] = [];
		for (const [, rec] of dropClasses) for (const l of rec.lines) { dropped.push({ ...l }); l.amount = 0; }
		const droppedAmount = round(dropped.reduce((a, l) => a + l.amount, 0), 2);
		const keptAmount = round(ranked.slice(0, maxNew).reduce((a, [, rec]) => a + rec.amount, 0), 2);
		warnings.push(
			`单期最多建 ${maxNew} 个类别（避免小资金开太多仓位）。本期建：` +
				`${ranked.slice(0, maxNew).map(([k, rec]) => `${ASSET_CLASSES[k] ?? k}(${round(rec.amount, 2)}元)`).join("、")}，共 ${keptAmount} 元；` +
				`本期不建：${dropClasses.map(([k, rec]) => `${ASSET_CLASSES[k] ?? k}(${round(rec.amount, 2)}元)`).join("、")}，共 ${droppedAmount} 元留存现金，下期继续建（不是不投）。` +
				`若长期觉得口袋太多，应改 profile.targets 合并类别；若想一次建更多，调大 constraints.maxNewPositions。`,
		);
		buyLines = finalLines.filter((l) => l.amount > 0);
	}
	const allocated = round(buyLines.reduce((a, l) => a + l.amount, 0), 2);
	const unallocated = round(amount - allocated, 2);
	const cashAfter = round(cashAvailable - allocated, 2);
	if (unallocated > 0) {
		notes.push(`本次实际买入 ${allocated} 元, 未分配 ${unallocated} 元留存现金(原因见上方提示${overCap ? "/单一标的超限" : ""})`);
	}

	// 现金下限检查(执行后)
	if (cashAfter < minCashRequired - 1e-6) {
		warnings.push(
			`警告: 执行后现金 ${round(cashAfter, 2)} 元低于下限 ${round(minCashRequired, 2)} 元 (${round(profile.constraints.minCashRatio * 100, 2)}%), 建议至少留 ${round(minCashRequired - cashAfter, 2)} 元现金`,
		);
	}

	const planId = `plan-${new Date().toISOString().slice(0, 10)}-${newId("x").slice(-5)}`;
	const result: PlanResult = {
		planId,
		createdAt: new Date().toISOString(),
		amount: round(amount, 2),
		deployable,
		totalBefore,
		totalAfter,
		classes: classRows,
		lines: buyLines,
		allocated,
		unallocated,
		cashAfter,
		warnings,
		notes,
	};
	writeJson(ws("plans", `${planId}.json`), { ...result, status: "preview" });
	return result;
}

export interface CommitResult {
	ok: boolean;
	planId: string;
	applied: Array<{ code: string; name: string; amount: number; shares?: number }>;
	failed: Array<{ code: string; reason: string }>;
	cashAfter: number;
}

/** 执行计划: 按计划逐笔买入并记账 */
export async function commitPlan(
	profile: Profile,
	portfolio: Portfolio,
	planId: string,
	signal?: AbortSignal,
): Promise<CommitResult> {
	const path = ws("plans", `${planId}.json`);
	const plan = readJson<(PlanResult & { status?: string }) | null>(path, null);
	if (!plan) throw new Error(`找不到计划 ${planId}`);
	if (plan.status === "committed") throw new Error(`计划 ${planId} 已执行过, 拒绝重复执行`);
	if (plan.status === "cancelled") throw new Error(`计划 ${planId} 已取消`);

	const applied: CommitResult["applied"] = [];
	const failed: CommitResult["failed"] = [];
	for (const line of plan.lines) {
		const res = await applyTrade(
			profile,
			portfolio,
			{ code: line.code, assetClass: line.assetClass, side: "buy", amount: line.amount, note: `计划 ${planId}` },
			signal,
		);
		if (res.ok) {
			applyLedgerPlanId(res.entry?.id, planId);
			applied.push({ code: line.code, name: line.name, amount: line.amount, shares: res.entry?.shares });
		} else {
			failed.push({ code: line.code, reason: res.message });
		}
	}
	const remaining = round(
		plan.lines.filter((l) => !applied.some((a) => a.code === l.code)).reduce((a, l) => a + l.amount, 0),
		2,
	);
	// 失败笔的钱从未从现金扣除, 因此不做回补; 仅记录未执行金额。
	savePortfolio(portfolio);
	writeJson(path, {
		...plan,
		status: failed.length ? "partially-committed" : "committed",
		committedAt: new Date().toISOString(),
		unexecutedAmount: remaining,
	});
	return { ok: failed.length === 0, planId, applied, failed, cashAfter: round(portfolio.cash, 2) };
}

function applyLedgerPlanId(_entryId: string | undefined, _planId: string): void {
	// 流水在 applyTrade 中已 append; planId 通过 note 体现, 此处保留扩展点
}

/** 记录当日快照 */
export function recordSnapshot(profile: Profile, portfolio: Portfolio): { date: string; total: number } {
	const status = computeStatus(profile, portfolio);
	const byClass: Record<string, number> = {};
	for (const c of status.byClass) byClass[c.key] = c.value;
	const date = new Date().toISOString().slice(0, 10);
	const snap = { date, total: status.total, cash: status.cash, byClass };
	const idx = portfolio.snapshots.findIndex((s) => s.date === date);
	if (idx >= 0) portfolio.snapshots[idx] = snap;
	else portfolio.snapshots.push(snap);
	portfolio.snapshots = portfolio.snapshots.slice(-400);
	savePortfolio(portfolio);
	return snap;
}

// ---------------------------------------------------------------------------
// 画像初始化辅助
// ---------------------------------------------------------------------------

export function initWorkspace(profilePatch: Partial<Profile>): { profile: Profile; portfolio: Portfolio; createdFiles: string[] } {
	const created: string[] = [];
	const profile = { ...loadProfile(), ...profilePatch, version: 1 };
	saveProfile(profile);
	created.push(ws("profile.json"));
	if (!fileExists(ws("portfolio.json"))) {
		const p = defaultPortfolio();
		savePortfolio(p);
		created.push(ws("portfolio.json"));
	}
	if (!fileExists(ws("watchlist.json"))) {
		saveWatchlist({ version: 1, updatedAt: new Date().toISOString(), items: [] });
		created.push(ws("watchlist.json"));
	}
	if (!fileExists(ledgerPath())) {
		appendFileSync(ledgerPath(), "", "utf8");
		created.push(ledgerPath());
	}
	ensureDir(ws("reports"));
	ensureDir(ws("plans"));
	ensureDir(ws("cache"));
	return { profile, portfolio: loadPortfolio(), createdFiles: created };
}

export function fundSearchHint(f: FundBrief): string {
	return `${f.code} ${f.name} (${f.type})`;
}
