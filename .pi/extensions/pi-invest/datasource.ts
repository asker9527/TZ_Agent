/**
 * pi-invest: 数据源层
 *
 * 全部数据来自公开接口，取不到就报错，绝不猜测数字。
 *   实时行情  腾讯 qt.gtimg.cn (主) / 新浪 hq.sinajs.cn (备)
 *   指数估值  蛋卷 danjuanfunds.com    PE/PB 历史分位
 *   基金列表  fund.eastmoney.com/js/fundcode_search.js   (~3MB, 本地缓存)
 *   基金档案  fund.eastmoney.com/pingzhongdata/{code}.js 净值/持仓/规模/经理
 *   净值历史  api.fund.eastmoney.com/f10/lsjz
 *   基金排行  fund.eastmoney.com/data/rankhandler.aspx
 */

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { ensureDir, ws } from "./config";

const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ---------------------------------------------------------------------------
// 基础 HTTP
// ---------------------------------------------------------------------------

export type Encoding = "utf8" | "gbk" | "auto";

export interface FetchOpts {
	referer?: string;
	encoding?: Encoding;
	timeoutMs?: number;
	retries?: number;
	signal?: AbortSignal;
}

function decodeBuf(buf: Buffer, enc: Encoding): string {
	if (enc === "gbk") return new TextDecoder("gbk").decode(buf);
	if (enc === "utf8") return new TextDecoder("utf-8").decode(buf);
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(buf);
	} catch {
		return new TextDecoder("gbk").decode(buf);
	}
}

async function fetchBuffer(url: string, opts: FetchOpts = {}): Promise<Buffer> {
	const { referer, timeoutMs = 20000, retries = 2, signal } = opts;
	let lastErr: unknown;
	for (let attempt = 0; attempt <= retries; attempt++) {
		const ctl = new AbortController();
		const timer = setTimeout(() => ctl.abort(), timeoutMs);
		const onAbort = () => ctl.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const res = await fetch(url, {
				headers: {
					"User-Agent": UA,
					Accept: "*/*",
					...(referer ? { Referer: referer } : {}),
				},
				signal: ctl.signal,
			});
			if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
			return Buffer.from(await res.arrayBuffer());
		} catch (err) {
			lastErr = err;
			if (signal?.aborted) throw new Error("aborted");
			if (attempt < retries) await sleep(400 * (attempt + 1));
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	}
	throw new Error(`请求失败 ${url}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

export async function fetchText(url: string, opts: FetchOpts = {}): Promise<string> {
	const buf = await fetchBuffer(url, opts);
	return decodeBuf(buf, opts.encoding ?? "auto");
}

export async function fetchJson<T = any>(url: string, opts: FetchOpts = {}): Promise<T> {
	return JSON.parse(await fetchText(url, { ...opts, encoding: opts.encoding ?? "utf8" })) as T;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// 磁盘缓存
// ---------------------------------------------------------------------------

const memCache = new Map<string, { at: number; data: unknown }>();

export function cacheFilePath(key: string): string {
	return ws("cache", `${key}.json`);
}

/** 带 TTL 的磁盘缓存; ttlMs<=0 表示永不过期(手动刷新) */
export async function cached<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
	const now = Date.now();
	const mem = memCache.get(key);
	if (mem && now - mem.at < ttlMs) return mem.data as T;
	try {
		const st = statSync(cacheFilePath(key));
		if (now - st.mtimeMs < ttlMs) {
			const data = JSON.parse(readFileSync(cacheFilePath(key), "utf8")) as T;
			memCache.set(key, { at: st.mtimeMs, data });
			return data;
		}
	} catch {
		// 缓存未命中
	}
	const data = await loader();
	ensureDir(ws("cache"));
	memCache.set(key, { at: now, data });
	try {
		writeFileSync(cacheFilePath(key), JSON.stringify(data), "utf8");
	} catch {
		// 缓存写失败不影响主流程
	}
	return data;
}

/** 读取缓存(不管 TTL), 用于离线降级 */
export function readCache<T>(key: string): T | undefined {
	try {
		return JSON.parse(readFileSync(cacheFilePath(key), "utf8")) as T;
	} catch {
		return undefined;
	}
}

export function cacheAgeMs(key: string): number | undefined {
	try {
		return Date.now() - statSync(cacheFilePath(key)).mtimeMs;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// 行情
// ---------------------------------------------------------------------------

export interface Quote {
	code: string;
	name: string;
	price: number;
	open: number;
	prevClose: number;
	high: number;
	low: number;
	change: number;
	changePct: number;
	volume?: number;
	amount?: number;
	turnover?: number;
	pe?: number;
	date?: string;
	time?: string;
	currency?: string;
	source: string;
}

const TENCENT_NAME = "腾讯行情";
const SINA_NAME = "新浪行情";

/** 常用别名 -> 行情代码 */
export const SYMBOL_ALIASES: Record<string, string> = {
	上证指数: "sh000001",
	上证: "sh000001",
	大盘: "sh000001",
	深证成指: "sz399001",
	沪深300: "sh000300",
	中证500: "sh000905",
	中证1000: "sh000852",
	中证2000: "sh932000",
	上证50: "sh000016",
	创业板指: "sz399006",
	创业板: "sz399006",
	科创50: "sh000688",
	中证红利: "sh000922",
	恒生指数: "hkHSI",
	港股: "hkHSI",
	恒生科技: "hkHSTECH",
	纳斯达克: "usIXIC",
	纳指: "usIXIC",
	标普500: "usINX",
	道琼斯: "usDJI",
	伦敦金: "hf_XAU",
	黄金: "hf_XAU",
	白银: "hf_XAG",
	原油: "hf_CL",
	美元人民币: "USDCNY",
	沪深300ETF: "sh510300",
	中证500ETF: "sh510500",
	创业板ETF: "sz159915",
	黄金ETF: "sh518880",
	国债ETF: "sh511010",
	可转债ETF: "sh511380",
};

/** 把用户输入/别名规范成行情代码 */
export function normalizeSymbol(input: string): string {
	const raw = input.trim();
	if (!raw) return raw;
	if (SYMBOL_ALIASES[raw]) return SYMBOL_ALIASES[raw];
	if (/^[a-z]{2}[A-Za-z0-9]+$/.test(raw) && /^(sh|sz|bj|hk|us)/i.test(raw)) {
		const prefix = raw.slice(0, 2).toLowerCase();
		return prefix + raw.slice(2).toUpperCase();
	}
	if (/^(hf_|fx_)/i.test(raw)) return raw;
	if (/^\d{6}$/.test(raw)) {
		const head = raw[0];
		if (head === "6" || head === "5" || head === "9" || head === "1") return `sh${raw}`;
		return `sz${raw}`;
	}
	return raw;
}

function isSinaOnly(code: string): boolean {
	return /^(hf_|fx_)/i.test(code) || code === "USDCNY" || code === "AU0" || code === "AG0";
}

/**
 * 腾讯行情的时间字段各市场格式不同:
 *   A股 sh000001 -> "20260924152200"
 *   港股 hkHSTECH -> "2026/09/24 16:04:48"
 *   美股 usINX    -> "2026-09-23 16:36:22"
 * 不能按固定下标切字符串, 否则港美股会被切成乱码。
 */
function parseTencentTime(ts: string): { date?: string; time?: string } {
	const raw = (ts ?? "").trim();
	if (!raw) return {};
	if (/^\d{14}$/.test(raw)) {
		return {
			date: `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`,
			time: `${raw.slice(8, 10)}:${raw.slice(10, 12)}:${raw.slice(12, 14)}`,
		};
	}
	if (/^\d{8}$/.test(raw)) return { date: `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` };
	const m = raw.match(/^(\d{4})[/\-](\d{1,2})[/\-](\d{1,2})(?:[ T]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
	if (m) {
		return {
			date: `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`,
			time: m[4] === undefined ? undefined : `${m[4].padStart(2, "0")}:${(m[5] ?? "0").padStart(2, "0")}:${(m[6] ?? "0").padStart(2, "0")}`,
		};
	}
	return { date: raw };
}

async function fetchTencent(codes: string[], signal?: AbortSignal): Promise<Quote[]> {
	const text = await fetchText(`https://qt.gtimg.cn/q=${codes.join(",")}`, {
		referer: "https://gu.qq.com/",
		encoding: "gbk",
		signal,
	});
	const out: Quote[] = [];
	for (const rec of text.split(";")) {
		const m = rec.match(/v_([A-Za-z0-9_]+)\s*=\s*"([^"]*)"/);
		if (!m) continue;
		const f = m[2].split("~");
		if (f.length < 35 || !f[3]) continue;
		const num = (v: string | undefined) => {
			const n = Number.parseFloat(String(v ?? "").replace(/,/g, ""));
			return Number.isFinite(n) ? n : undefined;
		};
		const price = num(f[3]);
		const prevClose = num(f[4]);
		if (price === undefined) continue;
		let change: number | undefined;
		let changePct: number | undefined;
		if (prevClose !== undefined && prevClose > 0) {
			change = price - prevClose;
			changePct = (change / prevClose) * 100;
		} else {
			change = num(f[31]);
			changePct = num(f[32]);
		}
		const ts = String(f[30] ?? "");
		const when = parseTencentTime(ts);
		out.push({
			code: m[1],
			name: String(f[1] ?? "").trim(),
			price,
			open: num(f[5]) ?? 0,
			prevClose: prevClose ?? 0,
			high: num(f[33]) ?? 0,
			low: num(f[34]) ?? 0,
			change: change ?? 0,
			changePct: changePct ?? 0,
			volume: num(f[6]),
			// 腾讯的美股字段布局与A股/港股不同, f[37] 不是成交额(万元), 会算出天文数字, 因此美股不取成交额。
			amount:
				/^us/i.test(m[1]) || num(f[37]) === undefined
					? undefined
					: (num(f[37]) as number) * 10000 > 1e13
						? undefined // 超过 10 万亿元视为异常, 宁可缺数不可给错数
						: (num(f[37]) as number) * 10000,
			turnover: num(f[38]),
			pe: num(f[39]),
			date: when.date,
			time: when.time,
			source: TENCENT_NAME,
		});
	}
	return out;
}

async function fetchSina(codes: string[], signal?: AbortSignal): Promise<Quote[]> {
	const text = await fetchText(`https://hq.sinajs.cn/list=${codes.join(",")}`, {
		referer: "https://finance.sina.com.cn/",
		encoding: "gbk",
		signal,
	});
	const out: Quote[] = [];
	for (const line of text.split("\n")) {
		const m = line.match(/hq_str_([A-Za-z0-9_]+)\s*=\s*"([^"]*)"/);
		if (!m) continue;
		const f = m[2].split(",");
		const num = (v: string | undefined) => {
			const n = Number.parseFloat(String(v ?? "").replace(/,/g, ""));
			return Number.isFinite(n) ? n : undefined;
		};
		if (/^hf_/i.test(m[1])) {
			// 外盘期货格式: 现价,买价,卖价?,...,时间,昨结算,今开,最高,最低,日期,名称
			const price = num(f[0]);
			if (price === undefined) continue;
			const prev = num(f[7]);
			const change = prev !== undefined && prev > 0 ? price - prev : 0;
			out.push({
				code: m[1],
				name: String(f[13] ?? f[0] ?? "").trim(),
				price,
				open: num(f[8]) ?? 0,
				prevClose: prev ?? 0,
				high: num(f[4]) ?? 0,
				low: num(f[5]) ?? 0,
				change,
				changePct: prev ? (change / prev) * 100 : 0,
				date: f[12],
				time: f[6],
				source: SINA_NAME,
			});
			continue;
		}
		if (m[1] === "USDCNY" || /^fx_/i.test(m[1])) {
			const price = num(f[8]) ?? num(f[1]);
			if (price === undefined) continue;
			const prev = num(f[3]);
			const change = prev && prev > 0 ? price - prev : 0;
			out.push({
				code: m[1],
				name: String(f[9] ?? "美元人民币").trim(),
				price,
				open: num(f[2]) ?? 0,
				prevClose: prev ?? 0,
				high: num(f[6]) ?? 0,
				low: num(f[7]) ?? 0,
				change,
				changePct: prev ? (change / prev) * 100 : 0,
				date: f[10],
				time: f[0],
				source: SINA_NAME,
			});
			continue;
		}
		// 国内股票/指数: 名称,今开,昨收,现价,最高,最低,买一,卖一,成交量,成交额,...,日期,时间
		const price = num(f[3]);
		if (price === undefined) continue;
		const prevClose = num(f[2]) ?? 0;
		const change = prevClose > 0 ? price - prevClose : 0;
		out.push({
			code: m[1],
			name: String(f[0] ?? "").trim(),
			price,
			open: num(f[1]) ?? 0,
			prevClose,
			high: num(f[4]) ?? 0,
			low: num(f[5]) ?? 0,
			change,
			changePct: prevClose > 0 ? (change / prevClose) * 100 : 0,
			volume: num(f[8]),
			amount: num(f[9]),
			date: f[30],
			time: f[31],
			source: SINA_NAME,
		});
	}
	return out;
}

/** 批量取实时行情。自动分流到腾讯/新浪, 单边失败会自动降级重试。 */
export async function getQuotes(inputs: string[], signal?: AbortSignal): Promise<Quote[]> {
	const codes = [...new Set(inputs.map(normalizeSymbol).filter(Boolean))];
	if (codes.length === 0) return [];
	const primary = codes.filter((c) => !isSinaOnly(c));
	const secondary = codes.filter(isSinaOnly);
	const results: Quote[] = [];
	const errors: string[] = [];

	if (primary.length) {
		try {
			results.push(...(await fetchTencent(primary, signal)));
		} catch (err) {
			errors.push(err instanceof Error ? err.message : String(err));
		}
		const got = new Set(results.map((q) => q.code.toUpperCase()));
		const missing = primary.filter((c) => !got.has(c.toUpperCase()));
		if (missing.length) {
			try {
				results.push(...(await fetchSina(missing, signal)));
			} catch (err) {
				errors.push(err instanceof Error ? err.message : String(err));
			}
		}
	}
	if (secondary.length) {
		try {
			results.push(...(await fetchSina(secondary, signal)));
		} catch (err) {
			errors.push(err instanceof Error ? err.message : String(err));
		}
	}
	if (results.length === 0 && errors.length) throw new Error(errors.join(" | "));
	return results;
}

// ---------------------------------------------------------------------------
// 指数估值 (蛋卷)
// ---------------------------------------------------------------------------

export interface Valuation {
	code: string;
	name: string;
	pe?: number;
	pb?: number;
	/** PE 历史分位 0-100 */
	pePct?: number;
	/** PB 历史分位 0-100 */
	pbPct?: number;
	roe?: number;
	dividendYield?: number;
	evaType?: string;
	date?: string;
}

/** 综合分位: PE 有效用 PE, 否则退到 PB */
export function valuationPct(v: Valuation): number {
	if (v.pePct !== undefined && v.pe !== undefined && v.pe > 0) return v.pePct;
	if (v.pbPct !== undefined) return v.pbPct;
	return Number.NaN;
}

export async function getValuations(signal?: AbortSignal): Promise<Valuation[]> {
	const raw = await cached<any>("valuation_danjuan", 6 * 3600 * 1000, async () => {
		const data = await fetchJson("https://danjuanfunds.com/djapi/index_eva/dj", { signal });
		const items = data?.data?.items;
		if (!Array.isArray(items)) throw new Error("蛋卷估值接口返回结构异常");
		return items.map(
			(it: any): Valuation => ({
				code: String(it.index_code ?? ""),
				name: String(it.name ?? ""),
				pe: Number(it.pe) || undefined,
				pb: Number(it.pb) || undefined,
				pePct: Number.isFinite(Number(it.pe_percentile)) ? Number(it.pe_percentile) * 100 : undefined,
				pbPct: Number.isFinite(Number(it.pb_percentile)) ? Number(it.pb_percentile) * 100 : undefined,
				roe: Number(it.roe) || undefined,
				dividendYield: Number(it.yeild) || undefined,
				evaType: it.eva_type ? String(it.eva_type) : undefined,
				date: it.date ? String(it.date) : undefined,
			}),
		);
	});
	return raw as Valuation[];
}

export async function findValuations(codes: string[], signal?: AbortSignal): Promise<Valuation[]> {
	const all = await getValuations(signal);
	const want = new Set(codes.map((c) => c.toUpperCase()));
	return all.filter((v) => want.has(v.code.toUpperCase()));
}

/** 一组指数的平均分位; 无有效数据返回 undefined */
export async function valuationPercentile(codes: string[], signal?: AbortSignal): Promise<number | undefined> {
	if (!codes.length) return undefined;
	const items = await findValuations(codes, signal);
	const pcts = items.map(valuationPct).filter((n) => Number.isFinite(n));
	if (!pcts.length) return undefined;
	return pcts.reduce((a, b) => a + b, 0) / pcts.length;
}

// ---------------------------------------------------------------------------
// 基金基本概况 (跟踪标的 / 管理费 / 托管费 / 申赎费) 与 持仓明细
// ---------------------------------------------------------------------------

/**
 * 基金基本概况。来源: 天天基金「基金基本概况」页 jbgk_{code}.html
 * 这里才有**管理费/托管费**（年化持有成本）与**跟踪标的**（真实敞口）。
 * 之前只用 pingzhongdata 时的 fee 字段其实只是申购手续费，容易把它误当持有成本。
 */
export interface FundBasic {
	code: string;
	fullName?: string;
	/** 跟踪标的指数名称 —— 判断基金真实敞口的权威依据 */
	trackedIndex?: string;
	benchmark?: string;
	managementFeePct?: number;
	custodyFeePct?: number;
	salesServiceFeePct?: number;
	/** 年化管理成本 = 管理费 + 托管费 (+销售服务费) */
	holdingCostPct?: number;
	maxSubscribeFeePct?: number;
	discountedSubscribeFeePct?: number;
	maxRedeemFeePct?: number;
	manager?: string;
	inceptionDate?: string;
	isFeeder?: boolean;
	asOf?: string;
}

function flattenHtml(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/g, "")
		.replace(/<style[\s\S]*?<\/style>/g, "")
		.replace(/<[^>]+>/g, "|")
		.replace(/&nbsp;/g, " ")
		.replace(/\|{2,}/g, "|");
}

/** 取标签之后的非空片段（表格 flatten 后会变成「标签|值」，直接 split("|")[0] 会得到空串） */
function segmentsAfter(text: string, label: string, max = 4): string[] {
	const i = text.indexOf(label);
	if (i < 0) return [];
	return text
		.slice(i + label.length, i + label.length + 140)
		.split("|")
		.map((s) => s.replace(/\s+/g, " ").trim())
		.filter((s) => s.length > 0 && !/^[:：,，.。\-—_\s]+$/.test(s)) // 纯标点不算值（flatten 后常留下一个冒号）
		.slice(0, max);
}

function valueAfter(text: string, label: string, len = 70): string | undefined {
	const v = segmentsAfter(text, label, 1)[0];
	return v ? v.slice(0, len) : undefined;
}

/**
 * 只接受**紧跟标签的第一个片段**且该片段以「数字%」开头。
 * 绝不向后扫描其他字段——否则字段值为「---」时会把隔壁字段的数字（如最高认购费率）误当成它。
 * 宁可返回 undefined，也不给错数。
 */
function pctAfter(text: string, label: string): number | undefined {
	const seg = segmentsAfter(text, label, 1)[0];
	if (!seg) return undefined;
	const m = seg.match(/^[（(]?\s*([\d.]+)\s*%/);
	return m ? Number(m[1]) : undefined;
}

export async function getFundBasic(code: string, signal?: AbortSignal): Promise<FundBasic> {
	return (await cached<FundBasic>(`fundbasic_${code}`, 24 * 3600 * 1000, async () => {
		const html = await fetchText(`https://fundf10.eastmoney.com/jbgk_${code}.html`, {
			referer: `https://fundf10.eastmoney.com/jbgk_${code}.html`,
			signal,
		});
		const t = flattenHtml(html);
		const management = pctAfter(t, "管理费率");
		const custody = pctAfter(t, "托管费率");
		const salesService = pctAfter(t, "销售服务费率");
		// 「天天基金优惠费率」在申购费之后第一次出现即为折后申购费
		let discounted: number | undefined;
		{
			const i = t.indexOf("最高申购费率");
			if (i >= 0) {
				const seg = t.slice(i, i + 160);
				const m = seg.match(/天天基金优惠费率[\s:|：]*([\d.]+)\s*%/);
				if (m) discounted = Number(m[1]);
			}
		}
		const fullName = valueAfter(t, "基金全称", 90);
		const holdingCost =
			management === undefined && custody === undefined && salesService === undefined
				? undefined
				: round((management ?? 0) + (custody ?? 0) + (salesService ?? 0), 2);
		return {
			code,
			fullName,
			trackedIndex: valueAfter(t, "跟踪标的", 60),
			benchmark: valueAfter(t, "业绩比较基准", 90),
			managementFeePct: management,
			custodyFeePct: custody,
			salesServiceFeePct: salesService,
			holdingCostPct: holdingCost,
			maxSubscribeFeePct: pctAfter(t, "最高申购费率"),
			discountedSubscribeFeePct: discounted,
			maxRedeemFeePct: pctAfter(t, "最高赎回费率"),
			manager: valueAfter(t, "基金管理人", 30),
			inceptionDate: valueAfter(t, "成立日期", 24),
			isFeeder: /联接/.test(fullName ?? "") || /联接/.test(t.slice(0, 400)),
		};
	})) as FundBasic;
}

/**
 * 基金规模必须看 A+C 合计。
 * A/C 是同一只基金的两个收费方式（申购费 vs 销售服务费），规模分开披露；
 * 只看 A 类会系统性低估规模，把合格基金误判为不合格。
 * 做法：取本份额规模，再用「末位 A↔C 互换」找同门兄弟份额并相加。
 */
export interface FundScaleTotal {
	code: string;
	ownScaleYi?: number;
	siblingCode?: string;
	siblingScaleYi?: number;
	totalScaleYi?: number;
}

export async function getFundScaleTotal(code: string, signal?: AbortSignal): Promise<FundScaleTotal> {
	try {
		const own = await getFundSnapshot(code, signal);
		const ownScale = own.holdings?.scaleSeries?.at(-1)?.scaleYi;
		const name = own.name ?? "";
		let siblingCode: string | undefined;
		const candidates: string[] = [];
		if (/[AC]$/.test(name)) candidates.push(name.slice(0, -1) + (name.endsWith("A") ? "C" : "A"));
		for (const cn of candidates) {
			const hit = (await searchFunds(cn, { limit: 6, signal })).find((f) => f.name === cn);
			if (hit && hit.code !== code) {
				siblingCode = hit.code;
				break;
			}
		}
		let siblingScale: number | undefined;
		if (siblingCode) {
			try {
				const sib = await getFundSnapshot(siblingCode, signal);
				siblingScale = sib.holdings?.scaleSeries?.at(-1)?.scaleYi;
			} catch {
				siblingScale = undefined;
			}
		}
		return {
			code,
			ownScaleYi: ownScale,
			siblingCode,
			siblingScaleYi: siblingScale,
			totalScaleYi:
				ownScale === undefined ? undefined : round(ownScale + (siblingScale ?? 0), 2),
		};
	} catch {
		return { code };
	}
}

// ---------------------------------------------------------------------------
// 个股简要档案：所属行业 / 概念标签 / 主营业务
// ---------------------------------------------------------------------------

/**
 * 个股简要档案，用于回答“我买的基金里是些什么公司、干什么的”。
 * 来源：① 东财 f127(所属行业) f129(概念标签) f162/f167(动态PE/PB)
 *       ② 新浪公司资料页的“主营业务”一句话（仅 A股）
 * 注意：概念标签是数据商打的标签，不是官方行业分类，仅供参考。
 */
export interface StockProfile {
	code: string;
	name: string;
	/** 东财所属行业 */
	industry?: string;
	/** 概念标签（最多保留前 6 个） */
	concepts?: string[];
	/** 动态市盈率 */
	pe?: number;
	pb?: number;
	/** 主营业务一句话（仅 A股） */
	business?: string;
	/** 数据源 */
	source?: string;
}

const stockProfileMem = new Map<string, { at: number; data: StockProfile }>();
const STOCK_PROFILE_TTL = 24 * 3600 * 1000;

/** 由 6 位代码猜东财 secid（1=沪市 0=深市）；非 A股返回 undefined */
export function guessSecid(code: string): string | undefined {
	if (!/^\d{6}$/.test(code)) return undefined;
	const head = code[0];
	return head === "6" || head === "5" || head === "9" ? `1.${code}` : `0.${code}`;
}

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function getStockProfile(
	code: string,
	opts: { secid?: string; signal?: AbortSignal } = {},
): Promise<StockProfile> {
	const key = `${opts.secid ?? guessSecid(code) ?? code}`;
	const hit = stockProfileMem.get(key);
	if (hit && Date.now() - hit.at < STOCK_PROFILE_TTL) return hit.data;

	const profile: StockProfile = { code, name: code };
	const secid = opts.secid ?? guessSecid(code);

	// ① 东财：行业 / 概念 / PE / PB
	if (secid) {
		try {
			const j = await fetchJson<any>(
				`https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f57,f58,f127,f129,f162,f167`,
				{ referer: "https://quote.eastmoney.com/", retries: 2, timeoutMs: 15000, signal: opts.signal },
			);
			const d = j?.data;
			if (d) {
				profile.name = String(d.f58 ?? profile.name);
				if (d.f127 && d.f127 !== "-") profile.industry = String(d.f127);
				if (typeof d.f129 === "string" && d.f129.trim()) {
					profile.concepts = d.f129.split(",").map((s: string) => s.trim()).filter(Boolean).slice(0, 6);
				}
				const num = (v: unknown) => {
					const n = Number(v);
					return Number.isFinite(n) && n !== 0 ? round(n / 100, 2) : undefined; // 东财该接口带回放比例
				};
				profile.pe = num(d.f162);
				profile.pb = num(d.f167);
				profile.source = "东财";
			}
		} catch {
			// 行业取不到不影响其它字段
		}
	}

	// ② 新浪：主营业务一句话（仅 A股；GBK 页面）
	if (/^\d{6}$/.test(code)) {
		try {
			await sleepMs(120); // 限速，避免被网关断连
			const html = await fetchText(
				`https://vip.stock.finance.sina.com.cn/corp/go.php/vCI_CorpInfo/stockid/${code}.phtml`,
				{ referer: "https://finance.sina.com.cn/", encoding: "gbk", retries: 1, timeoutMs: 15000, signal: opts.signal },
			);
			const t = html.replace(/<[^>]+>/g, "|").replace(/&nbsp;/g, " ").replace(/\|{2,}/g, "|");
			const i = t.indexOf("主营业务");
			if (i >= 0) {
				const seg = t.slice(i + 4, i + 220).split("|").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
				const val = seg.find((s) => s !== ":" && s !== "：" && !/^[:：]$/.test(s));
				if (val) profile.business = val.replace(/^[:：\s]+/, "").slice(0, 80);
			}
			if (!profile.name || profile.name === code) {
				const nm = html.match(/<title>([^<(]+)\(\d{6}\)/) ?? html.match(/<title>([^<(]+)/);
				if (nm) profile.name = nm[1].trim();
			}
		} catch {
			// 主营业务取不到就算了
		}
	}

	stockProfileMem.set(key, { at: Date.now(), data: profile });
	return profile;
}

// ---------------------------------------------------------------------------
// 基金股票持仓明细 (前十大, 季度披露)
// ---------------------------------------------------------------------------

export interface FundHolding {
	code: string;
	name: string;
	/** 占净值比例 % */
	weightPct?: number;
	sharesWan?: number;
	valueWan?: number;
	/** 东财 secid（如 105.NVDA / 1.600900），用于查行业与主营 */
	secid?: string;
}

export interface FundHoldings {
	code: string;
	/** 报告期, 如 2026年2季度 */
	period?: string;
	/** 截止日, 如 2026-06-30 */
	asOf?: string;
	holdings: FundHolding[];
	/** 前十大合计权重 % */
	top10WeightPct?: number;
	/** 报告期是否已过于陈旧（超过 15 个月），联接基金常见 */
	stale?: boolean;
	note?: string;
}

export async function getFundHoldings(code: string, signal?: AbortSignal): Promise<FundHoldings> {
	return (await cached<FundHoldings>(`fundhold_${code}`, 24 * 3600 * 1000, async () => {
		const text = await fetchText(
			`https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${code}&topline=10&year=&month=`,
			{ referer: `https://fundf10.eastmoney.com/ccmx_${code}.html`, signal },
		);
		const contentMatch = text.match(/content:"([\s\S]*?)",arryear/);
		const contentAll = contentMatch ? contentMatch[1].replace(/\\"/g, '"') : "";
		// 持仓页会**同时返回多个报告期（最新在前）**。若不分块，会把两期权重重复累加，
		// 得出 "前十大合计 114%" 这种不可能的怪数。只取第一块。
		const hdrRe = /\d{4}年\d季度股票投资明细/g;
		const firstHdr = hdrRe.exec(contentAll);
		let content = contentAll;
		if (firstHdr) {
			hdrRe.lastIndex = firstHdr.index + firstHdr[0].length;
			const secondHdr = hdrRe.exec(contentAll);
			content = contentAll.slice(firstHdr.index, secondHdr ? secondHdr.index : contentAll.length);
		}
		const contentText = content.replace(/<[^>]+>/g, "|").replace(/\|{2,}/g, "|");
		if (!content.trim()) {
			return {
				code,
				holdings: [],
				note:
					"该基金未披露股票投资明细。常见原因：① 它是 ETF 联接基金，主要持有目标 ETF 而非直接持股；" +
					"② 是债券/货币基金；③ 报告期尚未披露。联接基金的敞口应看「跟踪标的」指数。",
			};
		}
		const period = contentText.match(/(\d{4}年\d季度)股票投资明细/)?.[1] ?? undefined;
		const asOf = contentText.match(/截止至[:：]?\s*\|?\s*([\d-]{8,10})/)?.[1];
		const holdings: FundHolding[] = [];
		for (const row of content.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
			const tds = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
				m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, "").trim(),
			);
			// 序号 | 代码 | 名称 | 最新价 | 涨跌幅 | 相关资讯 | 占净值比例 | 持股数 | 持仓市值
			if (tds.length < 7) continue;
			const stockCode = tds[1];
			// 不能只认 6 位数字: 美股是 NVDA/MSFT 这类字母代码, 港股是 00700。
			// 之前用 ^\d{6}$ 会把所有美股持仓静默丢掉, 导致纳指类基金显示「未披露」。
			if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,9}$/.test(stockCode)) continue;
			const num = (v: string | undefined) => {
				const n = Number.parseFloat(String(v ?? "").replace(/[,%]/g, ""));
				return Number.isFinite(n) ? n : undefined;
			};
			holdings.push({
				code: stockCode,
				name: tds[2] ?? "",
				weightPct: num(tds.find((x) => /%$/.test(x))),
				sharesWan: num(tds[tds.length - 2]),
				valueWan: num(tds[tds.length - 1]),
				// 行内链接形如 //quote.eastmoney.com/unify/r/105.NVDA，取出 secid 以便查美股/港股
				secid: row[1].match(/unify\/r\/(\d+\.[A-Za-z0-9]+)/)?.[1],
			});
		}
		const top10 = holdings.reduce((a, h) => a + (h.weightPct ?? 0), 0);
		// 陈旧披露检测：报告期超过 15 个月基本无参考价值
		let stale = false;
		if (period) {
			const y = Number(period.slice(0, 4));
			const q = Number(period.match(/(\d)季度/)?.[1] ?? "0");
			if (y > 0 && q > 0) {
				const monthsAgo = (new Date().getFullYear() - y) * 12 + 12 - q * 3;
				if (monthsAgo > 15) stale = true;
			}
		}
		return {
			code,
			period,
			asOf,
			holdings: holdings.slice(0, 10),
			top10WeightPct: top10 > 0 ? round(top10, 2) : undefined,
			stale,
			note:
				"季度披露，存在 2-4 个月滞后；只含前十大重仓股。持仓会变（尤其主动基金），不能据此推断未来持仓。" +
				(stale
					? ` ⚠️ 本条报告期（${period}）已超过 15 个月，参考价值极低；ETF 联接基金常见此情况，应改看「跟踪标的」。`
					: ""),
		};
	})) as FundHoldings;
}

// ---------------------------------------------------------------------------
// 东财行业/概念板块估值 (含半导体等细分行业, 蛋卷无覆盖时的替代来源)
// ---------------------------------------------------------------------------

/**
 * 东财板块估值快照。
 * 说明: 该接口提供 PE(动态, f9)、总市值、涨跌幅, **不提供 PB**（返回空）。
 * 板块 PE 为整体法口径（板块总市值 / 板块总净利润）, 与指数 PE 不完全等价。
 */
export interface BoardValuation {
	code: string;
	name: string;
	/** 行业大盘 / 概念 */
	kind: "industry" | "concept";
	pe?: number;
	marketCap?: number;
	changePct?: number;
}

const BOARD_HEADERS = { "User-Agent": UA, Referer: "https://quote.eastmoney.com/" };

async function fetchBoardPage(kind: "industry" | "concept", pn: number, signal?: AbortSignal): Promise<any[]> {
	const t = kind === "industry" ? 2 : 3;
	const url =
		`https://push2.eastmoney.com/api/qt/clist/get?pn=${pn}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f20` +
		`&fs=m:90+t:${t}&fields=f12,f14,f9,f20,f3`;
	// 走带重试/超时的统一通道；直连在网关下容易被掐断
	const j = await fetchJson<any>(url, { referer: BOARD_HEADERS.Referer, retries: 3, timeoutMs: 20000, signal });
	return (j?.data?.diff ?? []) as any[];
}

/**
 * 行业 / 概念板块估值。分页拉取（接口单页上限 100）。
 * 行业板块已含「半导体 / 数字芯片设计 / 集成电路制造 / 半导体设备 / 半导体材料」全链条，
 * 因此默认只拉行业板块（~~5 个请求）；概念板块按需再拉（限流更重、噪声更大）。
 */
export async function getBoardValuations(
	opts: { kind?: "industry" | "concept" | "both"; signal?: AbortSignal } = {},
): Promise<BoardValuation[]> {
	const kind = opts.kind ?? "industry";
	const key = `boards_em_${kind}`;
	return (await cached<BoardValuation[]>(key, 3 * 3600 * 1000, async () => {
		const kinds: Array<"industry" | "concept"> = kind === "both" ? ["industry", "concept"] : [kind];
		const out: BoardValuation[] = [];
		for (const k of kinds) {
			for (let pn = 1; pn <= 8; pn++) {
				let rows: any[] = [];
				try {
					rows = await fetchBoardPage(k, pn, opts.signal);
				} catch (err) {
					// 单页失败：不再往下翻，保留已拿到的部分（宁可少不可错）
					if (pn === 1) throw err;
					break;
				}
				if (!rows.length) break;
				for (const b of rows) {
					const pe = Number.parseFloat(String(b.f9));
					out.push({
						code: String(b.f12),
						name: String(b.f14 ?? ""),
						kind: k,
						pe: Number.isFinite(pe) ? pe : undefined,
						marketCap: Number.isFinite(Number(b.f20)) ? Number(b.f20) : undefined,
						changePct: Number.isFinite(Number(b.f3)) ? Number(b.f3) : undefined,
					});
				}
				if (rows.length < 100) break;
				await new Promise((r) => setTimeout(r, 250)); // 页间限速，避免被网关断连
			}
		}
		if (!out.length) throw new Error("板块估值接口未返回数据");
		return out;
	})) as BoardValuation[];
}

// ---------------------------------------------------------------------------
// 场外基金盘中估值 (新浪 fu_ 接口)
// ---------------------------------------------------------------------------

/**
 * 场外基金的盘中估算净值。
 * 注意: 估值是第三方估算(根据持仓拟合指数), 不是基金公司公布的官方净值,
 * 不能用于记账与市值计算, 只能用来回答"今天大概怎么样"。
 */
export interface FundEstimate {
	code: string;
	name: string;
	/** 盘中估算净值 (非官方) */
	estimateNav: number;
	/** 最近已公布单位净值 (官方) */
	publishedNav: number;
	/** 估算涨跌 % */
	estimatePct: number;
	/** 估值时间 */
	time?: string;
	date?: string;
}

const estimateMem = new Map<string, { at: number; data: FundEstimate | null }>();
const ESTIMATE_TTL = 5 * 60 * 1000;

/** 批量取场外基金盘中估值; 取不到估值的(如纯债基金)会从结果里略去 */
export async function getFundEstimates(codes: string[], signal?: AbortSignal): Promise<FundEstimate[]> {
	const now = Date.now();
	const out: FundEstimate[] = [];
	const need: string[] = [];
	for (const raw of [...new Set(codes)]) {
		const code = raw.trim();
		if (!/^\d{6}$/.test(code)) continue;
		const hit = estimateMem.get(code);
		if (hit && now - hit.at < ESTIMATE_TTL) {
			if (hit.data) out.push(hit.data);
		} else {
			need.push(code);
		}
	}
	if (need.length) {
		const text = await fetchText(`https://hq.sinajs.cn/list=${need.map((c) => `fu_${c}`).join(",")}`, {
			referer: "https://finance.sina.com.cn/",
			encoding: "gbk",
			signal,
		});
		for (const line of text.split("\n")) {
			const m = line.match(/hq_str_fu_(\d{6})\s*=\s*"([^"]*)"/);
			if (!m) continue;
			const f = m[2].split(",");
			const num = (v: string | undefined) => {
				const n = Number.parseFloat(String(v ?? ""));
				return Number.isFinite(n) ? n : undefined;
			};
			const estimateNav = num(f[2]);
			const publishedNav = num(f[3]);
			const estimatePct = num(f[6]);
			if (estimateNav === undefined || publishedNav === undefined || estimatePct === undefined) {
				estimateMem.set(m[1], { at: now, data: null });
				continue;
			}
			const est: FundEstimate = {
				code: m[1],
				name: String(f[0] ?? "").trim(),
				estimateNav,
				publishedNav,
				estimatePct: round(estimatePct, 2),
				time: f[1],
				date: f[7],
			};
			estimateMem.set(m[1], { at: now, data: est });
			out.push(est);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// 基金列表 / 搜索
// ---------------------------------------------------------------------------

export interface FundBrief {
	code: string;
	abbr: string;
	name: string;
	type: string;
	pinyin: string;
}

async function loadFundList(signal?: AbortSignal): Promise<FundBrief[]> {
	return (await cached<FundBrief[]>("fundlist", 7 * 24 * 3600 * 1000, async () => {
		const text = await fetchText("https://fund.eastmoney.com/js/fundcode_search.js", {
			referer: "https://fund.eastmoney.com/",
			signal,
		});
		const start = text.indexOf("[");
		const end = text.lastIndexOf("]");
		if (start < 0 || end < 0) throw new Error("基金列表解析失败");
		const rows = JSON.parse(text.slice(start, end + 1)) as string[][];
		return rows.map((r) => ({
			code: r[0],
			abbr: r[1],
			name: r[2],
			type: r[3],
			pinyin: r[4],
		}));
	})) as FundBrief[];
}

/** 归一化: 只保留中文字符与字母数字, 去括号/空格/连字符等干扰字符 */
function normName(s: string): string {
	return s.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "").toUpperCase();
}

/** 子序列匹配: q 的字符按顺序出现在 s 中 */
function isSubsequence(q: string, s: string): boolean {
	let i = 0;
	for (let j = 0; j < s.length && i < q.length; j++) if (s[j] === q[i]) i++;
	return i === q.length;
}

export async function searchFunds(
	query: string,
	opts: { limit?: number; typeKeyword?: string; signal?: AbortSignal } = {},
): Promise<FundBrief[]> {
	const { limit = 20, typeKeyword, signal } = opts;
	const list = await loadFundList(signal);
	const q = query.trim();
	const typeFilter = typeKeyword?.trim();
	const hit = (f: FundBrief) => !typeFilter || f.type.includes(typeFilter);
	if (!q) return list.filter(hit).slice(0, limit);

	const upper = q.toUpperCase();
	const nq = normName(q);
	const scored: Array<{ f: FundBrief; score: number }> = [];
	for (const f of list) {
		if (!hit(f)) continue;
		let score = -1;
		if (f.code === q) score = 100;
		else if (f.code.startsWith(q)) score = 90;
		else if (f.name === q) score = 88;
		else if (f.name.includes(q)) score = 75;
		else if (f.abbr.toUpperCase() === upper) score = 85;
		else if (f.abbr.toUpperCase().startsWith(upper)) score = 60;
		else if (nq.length >= 4 && normName(f.name).includes(nq)) score = 70;
		else if (nq.length >= 5 && isSubsequence(nq, normName(f.name))) score = 35;
		else if (f.pinyin.toUpperCase().includes(upper) && upper.length >= 3) score = 40;
		if (score > 0) scored.push({ f, score });
	}
	// 短名称优先(通常是主代码), 但不要埋没 C 类/I 类分支
	scored.sort((a, b) => b.score - a.score || a.f.code.localeCompare(b.f.code));
	return scored.slice(0, limit).map((s) => s.f);
}

// ---------------------------------------------------------------------------
// 基金档案 (pingzhongdata)
// ---------------------------------------------------------------------------

export interface NavPoint {
	date: string;
	nav: number;
	changePct: number;
}

export interface FundMetrics {
	days: number;
	annualizedReturn?: number;
	volatility?: number;
	maxDrawdown?: number;
	sharpe?: number;
	calmar?: number;
}

export interface FundSnapshot {
	code: string;
	name: string;
	type?: string;
	updatedAt: string;
	/** 成立日(净值序列首日) */
	inceptionDate?: string;
	nav?: { latest: number; date: string; latestAcc?: number; changePct?: number };
	fee?: { source?: string; current?: string; minPurchase?: string };
	returns?: { m1?: number; m3?: number; m6?: number; y1?: number; custom?: number };
	metrics?: { y1?: FundMetrics; y3?: FundMetrics; all?: FundMetrics };
	holdings?: { stockRatio?: number; stockCodes: string[]; scaleSeries?: Array<{ date: string; scaleYi: number }> };
	managers?: Array<{ name: string; workTime?: string; star?: number; fundSize?: string; profit?: string }>;
	rating?: { similarType?: number; similarPercent?: number };
	buyStatus?: { buy?: string; sell?: string };
	navHistory?: NavPoint[];
	cacheAgeMs?: number;
}

/** 解析 JS 文件里的 `var NAME = <literal>;` 声明 */
export function parseJsVars(text: string): Record<string, any> {
	const out: Record<string, any> = {};
	const re = /var\s+([A-Za-z_$][\w$]*)\s*=\s*/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text))) {
		const name = m[1];
		let i = m.index + m[0].length;
		const start = i;
		let depth = 0;
		let quote: string | null = null;
		let esc = false;
		for (; i < text.length; i++) {
			const c = text[i];
			if (esc) {
				esc = false;
				continue;
			}
			if (quote) {
				if (c === "\\") esc = true;
				else if (c === quote) quote = null;
				continue;
			}
			if (c === '"' || c === "'") {
				quote = c;
				continue;
			}
			if (c === "[" || c === "{") depth++;
			else if (c === "]" || c === "}") depth--;
			else if (c === ";" && depth === 0) break;
		}
		const raw = text.slice(start, i).trim();
		if (!raw) continue;
		try {
			out[name] = JSON.parse(raw);
		} catch {
			out[name] = raw;
		}
	}
	return out;
}

function daysBetween(a: number, b: number): number {
	return Math.round((b - a) / 86400000);
}

const DAY_MS = 86400000;

/** 从净值序列计算区间指标 (年化收益/波动/最大回撤/夏普/卡玛) */
export function computeMetrics(series: NavPoint[], windowDays: number, rf = 0.02): FundMetrics {
	if (series.length < 3) return { days: 0 };
	const endTs = new Date(`${series[series.length - 1].date}T00:00:00Z`).getTime();
	const startTs = endTs - windowDays * DAY_MS;
	let startIdx = series.findIndex((p) => new Date(`${p.date}T00:00:00Z`).getTime() >= startTs);
	if (startIdx < 0) startIdx = 0;
	const slice = series.slice(startIdx);
	if (slice.length < 3) return { days: 0 };

	const rets: number[] = [];
	for (let i = 1; i < slice.length; i++) {
		const prev = slice[i - 1].nav;
		if (prev > 0) rets.push(slice[i].nav / prev - 1);
	}
	const n = rets.length;
	const mean = rets.reduce((a, b) => a + b, 0) / n;
	const variance = n > 1 ? rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
	const volatility = Math.sqrt(variance) * Math.sqrt(252);

	const first = slice[0].nav;
	const last = slice[slice.length - 1].nav;
	const spanDays = Math.max(1, daysBetween(new Date(`${slice[0].date}T00:00:00Z`).getTime(), endTs));
	const totalReturn = last / first - 1;
	const annualizedReturn = Math.pow(1 + totalReturn, 365 / spanDays) - 1;

	let peak = -Infinity;
	let maxDrawdown = 0;
	for (const p of slice) {
		peak = Math.max(peak, p.nav);
		if (peak > 0) maxDrawdown = Math.min(maxDrawdown, p.nav / peak - 1);
	}
	maxDrawdown = Math.abs(maxDrawdown);

	const sharpe = volatility > 0 ? (annualizedReturn - rf) / volatility : undefined;
	const calmar = maxDrawdown > 0 ? annualizedReturn / maxDrawdown : undefined;

	return {
		days: spanDays,
		annualizedReturn: round(annualizedReturn * 100, 2),
		volatility: round(volatility * 100, 2),
		maxDrawdown: round(maxDrawdown * 100, 2),
		sharpe: sharpe === undefined ? undefined : round(sharpe, 2),
		calmar: calmar === undefined ? undefined : round(calmar, 2),
	};
}

export function round(n: number, digits = 2): number {
	const f = 10 ** digits;
	return Math.round(n * f) / f;
}

/** 东财时间戳是北京时间当日零点, 转日期需 +8h 后取 UTC 日期 */
const CN_OFFSET_MS = 8 * 3600 * 1000;

function tsToDateCN(ts: number): string {
	return new Date(ts + CN_OFFSET_MS).toISOString().slice(0, 10);
}

function buildNavHistory(trend: Array<{ x: number; y: number; equityReturn?: number }>): NavPoint[] {
	return trend
		.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
		.map((p) => ({
			date: tsToDateCN(p.x),
			nav: p.y,
			changePct: Number(p.equityReturn ?? 0),
		}));
}

/** 基金档案: 净值序列 + 规模 + 经理 + 持仓 + 风险指标 */
export async function getFundSnapshot(code: string, signal?: AbortSignal): Promise<FundSnapshot> {
	const key = `fund_${code}`;
	const snap = await cached<FundSnapshot>(key, 6 * 3600 * 1000, async () => {
		const text = await fetchText(`https://fund.eastmoney.com/pingzhongdata/${code}.js`, {
			referer: `https://fund.eastmoney.com/${code}.html`,
			signal,
		});
		const v = parseJsVars(text);
		if (!v.fS_name) throw new Error(`基金 ${code} 档案拉取失败(代码可能不存在)`);
		const trend = Array.isArray(v.Data_netWorthTrend) ? v.Data_netWorthTrend : [];
		const history = buildNavHistory(trend);
		const latest = history[history.length - 1];
		const acTrend: number[][] = Array.isArray(v.Data_ACWorthTrend) ? v.Data_ACWorthTrend : [];
		// Data_fluctuationScale = {categories:[...], series:[{y,mom}, ...]} 每季度一项
		const scaleSeries: Array<{ date: string; scaleYi: number }> = [];
		const scaleRaw = v.Data_fluctuationScale;
		if (Array.isArray(scaleRaw?.categories) && Array.isArray(scaleRaw?.series)) {
			const cats: string[] = scaleRaw.categories;
			for (let i = 0; i < scaleRaw.series.length; i++) {
				const y = scaleRaw.series[i]?.y;
				if (Number.isFinite(y)) scaleSeries.push({ date: cats[i] ?? "", scaleYi: y });
			}
		}
		const positions: number[][] = Array.isArray(v.Data_fundSharesPositions) ? v.Data_fundSharesPositions : [];
		const stockRatio = positions.length ? positions[positions.length - 1][1] : undefined;
		const managers = Array.isArray(v.Data_currentFundManager)
			? v.Data_currentFundManager.map((m: any) => ({
					name: String(m.name ?? ""),
					workTime: m.workTime ? String(m.workTime) : undefined,
					star: Number(m.star) || undefined,
					fundSize: m.fundSize ? String(m.fundSize) : undefined,
					profit: m.profit ? String(m.profit) : undefined,
				}))
			: [];
		const rate = Array.isArray(v.Data_rateInSimilarPersent) ? v.Data_rateInSimilarPersent : [];
		const snap: FundSnapshot = {
			code,
			name: String(v.fS_name),
			inceptionDate: history[0]?.date,
			updatedAt: new Date().toISOString(),
			nav: latest
				? {
						latest: latest.nav,
						date: latest.date,
						changePct: latest.changePct,
						latestAcc: acTrend.length ? acTrend[acTrend.length - 1][1] : undefined,
					}
				: undefined,
			fee: {
				source: v.fund_sourceRate ? `${v.fund_sourceRate}%` : undefined,
				current: v.fund_Rate ? `${v.fund_Rate}%` : undefined,
				minPurchase: v.fund_minsg ? `${v.fund_minsg}元` : undefined,
			},
			returns: {
				m1: numOrUndef(v.syl_1y),
				m3: numOrUndef(v.syl_3y),
				m6: numOrUndef(v.syl_6y),
				y1: numOrUndef(v.syl_1n),
			},
			metrics: {
				y1: computeMetrics(history, 365),
				y3: computeMetrics(history, 365 * 3),
				all: computeMetrics(history, 365 * 30),
			},
			holdings: {
				stockRatio: Number.isFinite(stockRatio as number) ? (stockRatio as number) : undefined,
				stockCodes: Array.isArray(v.stockCodesNew) ? v.stockCodesNew.map(String) : [],
				scaleSeries,
			},
			managers,
			rating: {
				similarType: rate.length ? rate[rate.length - 1][1] : undefined,
				similarPercent: Array.isArray(v.Data_rateInSimilarType) && v.Data_rateInSimilarType.length
					? v.Data_rateInSimilarType[v.Data_rateInSimilarType.length - 1]?.sc
					: undefined,
			},
			navHistory: history.slice(-260),
		};
		return snap;
	});
	const age = cacheAgeMs(key);
	return { ...snap, cacheAgeMs: age };
}

function numOrUndef(v: unknown): number | undefined {
	const n = Number.parseFloat(String(v ?? ""));
	return Number.isFinite(n) ? n : undefined;
}

/** 最新净值 + 申赎状态 (轻量接口) */
export async function getFundNavInfo(
	code: string,
	signal?: AbortSignal,
): Promise<{ nav: number; date: string; changePct?: number; accNav?: number; buy?: string; sell?: string } | undefined> {
	try {
		const data = await fetchJson<any>(
			`https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=1`,
			{ referer: `https://fundf10.eastmoney.com/jjjz_${code}.html`, signal },
		);
		const row = data?.Data?.LSJZList?.[0];
		if (!row) return undefined;
		return {
			nav: Number(row.DWJZ),
			accNav: Number(row.LJJZ) || undefined,
			date: String(row.FSRQ),
			changePct: Number(row.JZZZL) || undefined,
			buy: row.SGZT ? String(row.SGZT) : undefined,
			sell: row.SHZT ? String(row.SHZT) : undefined,
		};
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// 基金排行
// ---------------------------------------------------------------------------

export type RankCategory = "all" | "gp" | "hh" | "zq" | "zs" | "qdii" | "fof" | "lof";
/** 排序代码使用东财原始 sc 值 */
export type RankPeriod = "rzdf" | "zzf" | "1yzf" | "3yzf" | "6yzf" | "1nzf" | "2nzf" | "3nzf" | "5nzf" | "jnzf" | "lnzf";

export const RANK_CATEGORY_LABEL: Record<RankCategory, string> = {
	all: "全部",
	gp: "股票型",
	hh: "混合型",
	zq: "债券型",
	zs: "指数型",
	qdii: "QDII",
	fof: "FOF",
	lof: "LOF",
};

export const RANK_PERIOD_LABEL: Record<RankPeriod, string> = {
	rzdf: "日增长率",
	zzf: "近1周",
	"1yzf": "近1月",
	"3yzf": "近3月",
	"6yzf": "近6月",
	"1nzf": "近1年",
	"2nzf": "近2年",
	"3nzf": "近3年",
	"5nzf": "近5年",
	jnzf: "今年来",
	lnzf: "成立来",
};

export interface RankRow {
	code: string;
	name: string;
	navDate: string;
	nav: number;
	accNav?: number;
	dayPct?: number;
	weekPct?: number;
	m1?: number;
	m3?: number;
	m6?: number;
	y1?: number;
	y2?: number;
	y3?: number;
	/** 今年来 (东财第14列) */
	ytd?: number;
	sinceInception?: number;
	inceptionDate?: string;
}

/** 基金排行。period 决定排序依据, 返回区间收益全字段。 */
export async function getFundRank(
	opts: { category?: RankCategory; period?: RankPeriod; top?: number; page?: number; signal?: AbortSignal } = {},
): Promise<RankRow[]> {
	const { category = "all", period = "1nzf", top = 30, page = 1, signal } = opts;
	const now = new Date();
	const end = now.toISOString().slice(0, 10);
	const start = new Date(now.getTime() - 365 * DAY_MS).toISOString().slice(0, 10);
	const qs = new URLSearchParams({
		op: "ph",
		dt: "kf",
		ft: category,
		rs: "",
		gs: "0",
		sc: period,
		st: "desc",
		sd: start,
		ed: end,
		qdii: "",
		tabSubtype: ",,,,,",
		pi: String(page),
		pn: String(top),
		dx: "1",
	});
	const text = await fetchText(`https://fund.eastmoney.com/data/rankhandler.aspx?${qs}`, {
		referer: "https://fund.eastmoney.com/data/fundranking.html",
		signal,
	});
	const m = text.match(/datas:(\[[\s\S]*?\])\s*,\s*allRecords/);
	if (!m) throw new Error("基金排行接口返回结构异常");
	// 接口返回的 datas 是「逗号拼接字符串」数组, 每项一行
	const rawRows = JSON.parse(m[1].replace(/\\'/g, "'")) as string[];
	const rows = rawRows.map((r) => (typeof r === "string" ? r.split(",") : (r as unknown as string[])));
	const num = (v: string | undefined) => {
		const n = Number.parseFloat(String(v ?? ""));
		return Number.isFinite(n) ? n : undefined;
	};
	const out: RankRow[] = [];
	for (const f of rows) {
		// 用「成立日期」这一列做锚点, 避免列顺序变动导致错位
		let di = -1;
		for (let i = 8; i < f.length; i++) {
			if (/^\d{4}-\d{2}-\d{2}$/.test(f[i] ?? "")) {
				di = i;
				break;
			}
		}
		if (di < 13) continue;
		out.push({
			code: f[0],
			name: f[1],
			navDate: f[di - 13],
			nav: num(f[di - 12]) ?? 0,
			accNav: num(f[di - 11]),
			dayPct: num(f[di - 10]),
			weekPct: num(f[di - 9]),
			m1: num(f[di - 8]),
			m3: num(f[di - 7]),
			m6: num(f[di - 6]),
			y1: num(f[di - 5]),
			y2: num(f[di - 4]),
			y3: num(f[di - 3]),
			ytd: num(f[di - 2]),
			sinceInception: num(f[di - 1]),
			inceptionDate: f[di],
		});
	}
	return out;
}
