/**
 * pi-invest: 估值历史库（自建分位）
 *
 * 背景（已实测）：
 *   - 蛋卷只覆盖 63 个宽基/主要行业指数的 PE/PB 历史分位，没有半导体/芯片/AI 等细分行业；
 *   - 雪球需要登录 token、乐咕乐股需要每日轮换 token、中证官网只给当前值/月度，
 *     即「现成的细分行业估值分位」拿不到，而且不该靠灰色抓取去拿；
 *   - 但「当前 PE」拿得到：东方财富行业/概念板块接口（含半导体细分）。
 *
 * 结论：分位自己攒。每天把「蛋卷指数估值 + 东财全部行业/概念板块 PE」落一次库，
 * 用时间换历史，一年后就有 250 个交易日样本，可以自己算分位，且不依赖任何第三方给分位。
 *
 * 存储：invest/valuation-history.jsonl，一天一行，紧凑格式控制体积
 *   {"date":"2026-09-24","ts":1790...,"indices":{"SH000300":[13.4,1.42,65.5,39.3]},
 *    "boards":{"BK1036":82.14,...},"names":{"BK1036":"半导体"}}
 */

import { appendFileSync, readFileSync, statSync } from "node:fs";
import { ensureDir, ws } from "./config";
import { getBoardValuations, getValuations, round, valuationPct, type BoardValuation } from "./datasource";

export interface DaySnapshot {
	date: string;
	ts: number;
	/** 蛋卷指数: [pe, pb, pe分位, pb分位] */
	indices?: Record<string, [number, number, number, number]>;
	/** 东财板块: code -> PE(动态); PB 该接口不提供 */
	boards?: Record<string, number>;
	/** 板块/指数名称 */
	names?: Record<string, string>;
}

export function historyPath(): string {
	return ws("valuation-history.jsonl");
}

let cache: { mtimeMs: number; rows: DaySnapshot[] } | null = null;

export function loadHistory(): DaySnapshot[] {
	try {
		const st = statSync(historyPath());
		if (cache && cache.mtimeMs === st.mtimeMs) return cache.rows;
		const raw = readFileSync(historyPath(), "utf8")
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => {
				try {
					return JSON.parse(l) as DaySnapshot;
				} catch {
					return null;
				}
			})
			.filter((r): r is DaySnapshot => !!r && typeof r.date === "string");
		// 同一天可能被重记（比如首次记录时板块接口挂了，稍后补记），以最后一条为准
		const byDate = new Map<string, DaySnapshot>();
		for (const r of raw) byDate.set(r.date, r);
		const rows = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
		cache = { mtimeMs: st.mtimeMs, rows };
		return rows;
	} catch {
		return [];
	}
}

export function hasSnapshotToday(date = todayCN()): boolean {
	// 只有当天的快照已经同时含指数与板块时才算「记完了」。
	// 否则允许重记：比如首次记录时板块接口正好被限流，稍后补记。
	const row = loadHistory().find((r) => r.date === date);
	if (!row) return false;
	return Object.keys(row.indices ?? {}).length > 0 && Object.keys(row.boards ?? {}).length > 0;
}

function todayCN(): string {
	return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 百分位: 历史样本中 <= value 的比例 (0-100) */
export function percentileOf(series: number[], value: number): number {
	if (!series.length) return Number.NaN;
	const below = series.filter((v) => v <= value).length;
	return round((below / series.length) * 100, 1);
}

export interface SelfPercentile {
	key: string;
	name?: string;
	kind: "index" | "board";
	value?: number;
	/** 自建分位 (0-100) */
	pct?: number;
	samples: number;
	firstDate?: string;
	lastDate?: string;
	/** 样本是否足够给出分位（默认要求 >= 60 个交易日） */
	sufficient: boolean;
	note: string;
}

const MIN_SAMPLES = 60;

function buildResult(
	key: string,
	kind: "index" | "board",
	rows: DaySnapshot[],
	name: string | undefined,
	extract: (r: DaySnapshot) => number | undefined,
	wantPct = true,
): SelfPercentile {
	const points: Array<{ date: string; v: number }> = [];
	for (const r of rows) {
		const v = extract(r);
		if (v !== undefined && Number.isFinite(v) && v > 0) points.push({ date: r.date, v });
	}
	const value = points.length ? points[points.length - 1].v : undefined;
	const samples = points.length;
	const sufficient = samples >= MIN_SAMPLES;
	const pct = wantPct && sufficient && value !== undefined ? percentileOf(points.map((p) => p.v), value) : undefined;
	return {
		key,
		name,
		kind,
		value,
		pct,
		samples,
		firstDate: points.length ? points[0].date : undefined,
		lastDate: points.length ? points[points.length - 1].date : undefined,
		sufficient,
		note: sufficient
			? `自建分位：样本 ${samples} 个交易日 (${points[0].date} ~ ${points[points.length - 1].date})，口径为「历史值 ≤ 当前值的比例」`
			: `样本仅 ${samples} 个交易日，不足 ${MIN_SAMPLES} 个，不给分位。继续每天记录即可累积（这是本工具的自建分位库，不是第三方分位）`,
	};
}

/** 自建分位：东财板块 PE */
export function boardPercentile(code: string): SelfPercentile {
	const rows = loadHistory();
	const name = rows.map((r) => r.names?.[code]).find(Boolean);
	return buildResult(code, "board", rows, name, (r) => r.boards?.[code]);
}

/** 自建分位：蛋卷指数 PE（第三方已有分位时优先用第三方，这里用于交叉核对或补充） */
export function indexPercentileFromHistory(code: string): SelfPercentile {
	const rows = loadHistory();
	return buildResult(code, "index", rows, code, (r) => r.indices?.[code]?.[0]);
}

export interface RecordResult {
	date: string;
	indices: number;
	boards: number;
	skipped: boolean;
	message: string;
}

/** 记录当日估值快照（幂等：同一天只记一次） */
export async function recordDailySnapshot(opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<RecordResult> {
	const date = todayCN();
	if (!opts.force && hasSnapshotToday(date)) {
		return { date, indices: 0, boards: 0, skipped: true, message: `${date} 已有快照，跳过` };
	}
	const snap: DaySnapshot = { date, ts: Date.now(), indices: {}, boards: {}, names: {} };
	const errs: string[] = [];

	try {
		const vals = await getValuations(opts.signal);
		for (const v of vals) {
			const p = valuationPct(v);
			snap.indices![v.code] = [v.pe ?? 0, v.pb ?? 0, Number.isFinite(p) ? round(p, 1) : 0, round(v.pbPct ?? 0, 1)];
			snap.names![v.code] = v.name;
		}
	} catch (err) {
		errs.push(`蛋卷指数: ${err instanceof Error ? err.message : String(err)}`);
	}

	let boards: BoardValuation[] = [];
	try {
		boards = await getBoardValuations({ kind: "industry", signal: opts.signal });
		for (const b of boards) {
			if (b.pe !== undefined && Number.isFinite(b.pe)) snap.boards![b.code] = round(b.pe, 2);
			snap.names![b.code] = b.name;
		}
	} catch (err) {
		errs.push(`东财板块: ${err instanceof Error ? err.message : String(err)}`);
	}

	if (!Object.keys(snap.indices!).length && !Object.keys(snap.boards!).length) {
		throw new Error(`估值快照记录失败（两个来源都没取到数据）: ${errs.join("; ")}`);
	}

	ensureDir(ws());
	const rows = loadHistory();
	appendFileSync(historyPath(), `${JSON.stringify(snap)}\n`, "utf8");
	cache = null; // 让下次读取重新加载

	const dates = new Set(rows.map((r) => r.date));
	dates.add(date);
	return {
		date,
		indices: Object.keys(snap.indices!).length,
		boards: Object.keys(snap.boards!).length,
		skipped: false,
		message:
			`已记录 ${date} 估值快照：指数 ${Object.keys(snap.indices!).length} 个，板块 ${Object.keys(snap.boards!).length} 个` +
			`（历史库累计 ${dates.size} 天）` +
			(errs.length ? `；部分来源失败: ${errs.join("; ")}（可稍后重跑本工具补记）` : ""),
	};
}

export interface HistorySummary {
	days: number;
	firstDate?: string;
	lastDate?: string;
	/** 已经够格给分位的板块数 */
	boardsReady: number;
	boardsTracked: number;
}

export function historySummary(): HistorySummary {
	const rows = loadHistory();
	const seen = new Map<string, number>();
	for (const r of rows) for (const code of Object.keys(r.boards ?? {})) seen.set(code, (seen.get(code) ?? 0) + 1);
	let ready = 0;
	for (const n of seen.values()) if (n >= MIN_SAMPLES) ready++;
	return {
		days: rows.length,
		firstDate: rows[0]?.date,
		lastDate: rows[rows.length - 1]?.date,
		boardsReady: ready,
		boardsTracked: seen.size,
	};
}
