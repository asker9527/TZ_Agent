/**
 * pi-invest: 配置与工作区解析
 *
 * 配置优先级:
 *   1. 环境变量 PI_INVEST_DIR (直接指定工作区)
 *   2. ~/.pi/agent/invest/config.json 的 workspace 字段
 *   3. 默认 ~/.pi/agent/invest
 *
 * 工作区结构:
 *   profile.json    投资人画像 / 目标配置 / 约束
 *   portfolio.json  持仓 + 现金
 *   watchlist.json  候选基金池
 *   ledger.jsonl    交易流水 (append-only, 可审计)
 *   plans/          月度投入计划
 *   reports/        周报/月报归档
 *   cache/          行情缓存
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
export const CONFIG_FILE = join(AGENT_DIR, "invest", "config.json");

export interface NotifyConfig {
	channel: "feishu" | "none";
	/** 飞书 chat_id, 留空则自动从 bridge.pi.json 取最近活跃的会话 */
	chatId?: string;
	/** 报告同时以文件形式推送 */
	sendFile?: boolean;
}

export interface InvestConfig {
	workspace: string;
	notify: NotifyConfig;
}

const FALLBACK: InvestConfig = {
	workspace: join(AGENT_DIR, "invest"),
	notify: { channel: "none", sendFile: false },
};

let cached: { mtimeMs: number; cfg: InvestConfig } | null = null;

export function loadConfig(): InvestConfig {
	let cfg: InvestConfig = FALLBACK;
	try {
		const st = statSync(CONFIG_FILE);
		if (cached && cached.mtimeMs === st.mtimeMs) return cached.cfg;
		const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Partial<InvestConfig>;
		cfg = {
			workspace: raw.workspace ?? FALLBACK.workspace,
			notify: { ...FALLBACK.notify, ...(raw.notify ?? {}) },
		};
		cached = { mtimeMs: st.mtimeMs, cfg };
	} catch {
		cfg = FALLBACK;
	}
	if (process.env.PI_INVEST_DIR) cfg.workspace = process.env.PI_INVEST_DIR;
	return cfg;
}

export function getWorkspace(): string {
	return loadConfig().workspace;
}

/** 工作区内的文件路径 */
export function ws(...parts: string[]): string {
	return join(getWorkspace(), ...parts);
}

export function ensureDir(dir: string): void {
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function readJson<T>(path: string, fallback: T): T {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return fallback;
	}
}

export function writeJson(path: string, data: unknown): void {
	ensureDir(dirname(path));
	writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
}

export function fileExists(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}
