/**
 * pi-invest: 飞书推送
 *
 * 直连飞书开放平台 API, 不依赖 ax-feishu-bridge 是否在线,
 * 这样定时任务(Pi 未前台运行时)也能把报告推给你。
 *
 * 凭证来源: ~/.pi/agent/feishu/config.pi.json  (appId / appSecret)
 * 默认会话: ~/.pi/agent/feishu/bridge.pi.json  最近活跃的 p2p 会话
 *         可用 ~/.pi/agent/invest/config.json 的 notify.chatId 覆盖
 */

import { readFileSync } from "node:fs";
import { AGENT_DIR, loadConfig } from "./config";
import { join } from "node:path";

const FEISHU_CONFIG = join(AGENT_DIR, "feishu", "config.pi.json");
const FEISHU_BRIDGE = join(AGENT_DIR, "feishu", "bridge.pi.json");

export interface FeishuCreds {
	appId: string;
	appSecret: string;
	domain: string;
}

export function readCreds(): FeishuCreds | undefined {
	try {
		const raw = JSON.parse(readFileSync(FEISHU_CONFIG, "utf8")) as any;
		if (!raw.appId || !raw.appSecret) return undefined;
		return { appId: String(raw.appId), appSecret: String(raw.appSecret), domain: String(raw.domain ?? "feishu") };
	} catch {
		return undefined;
	}
}

function apiBase(domain: string): string {
	return domain === "lark" ? "https://open.larksuite.com/open-apis" : "https://open.feishu.cn/open-apis";
}

/** 自动挑选推送目标会话: 优先配置, 其次最近活跃的 p2p, 最后任意最近活跃会话 */
export function resolveChatId(): { chatId?: string; source: string; candidates: Array<{ key: string; chatId: string; updatedAt: number }> } {
	const configured = loadConfig().notify.chatId;
	if (configured) return { chatId: configured, source: "config.notify.chatId", candidates: [] };
	const candidates: Array<{ key: string; chatId: string; updatedAt: number }> = [];
	try {
		const bridge = JSON.parse(readFileSync(FEISHU_BRIDGE, "utf8")) as any;
		for (const [key, route] of Object.entries<any>(bridge.routes ?? {})) {
			if (route?.chatId) candidates.push({ key, chatId: String(route.chatId), updatedAt: Number(route.updatedAt ?? 0) });
		}
	} catch {
		return { source: "bridge.pi.json 不可读", candidates };
	}
	candidates.sort((a, b) => b.updatedAt - a.updatedAt);
	const p2p = candidates.find((c) => c.key.startsWith("p2p"));
	const pick = p2p ?? candidates[0];
	return { chatId: pick?.chatId, source: pick ? `bridge.pi.json ${pick.key}` : "未找到会话", candidates };
}

export interface SendResult {
	ok: boolean;
	detail: string;
	chatId?: string;
	source?: string;
}

async function tenantToken(creds: FeishuCreds): Promise<string> {
	const res = await fetch(`${apiBase(creds.domain)}/auth/v3/tenant_access_token/internal`, {
		method: "POST",
		headers: { "Content-Type": "application/json; charset=utf-8" },
		body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
	});
	const j = (await res.json()) as any;
	if (j.code !== 0 || !j.tenant_access_token) throw new Error(`飞书鉴权失败: ${j.code} ${j.msg ?? ""}`);
	return j.tenant_access_token as string;
}

function splitMarkdown(md: string, limit: number): string[] {
	if (md.length <= limit) return [md];
	const blocks = md.split(/\n(?=#{1,3} )/);
	const out: string[] = [];
	let buf = "";
	for (const b of blocks) {
		if (buf && buf.length + b.length > limit) {
			out.push(buf);
			buf = "";
		}
		if (b.length > limit) {
			for (let i = 0; i < b.length; i += limit) out.push(b.slice(i, i + limit));
		} else {
			buf = buf ? `${buf}\n${b}` : b;
		}
	}
	if (buf) out.push(buf);
	return out;
}

async function sendCard(token: string, chatId: string, title: string, md: string, template = "blue"): Promise<any> {
	const res = await fetch(`${apiBase(readCreds()?.domain ?? "feishu")}/im/v1/messages?receive_id_type=chat_id`, {
		method: "POST",
		headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${token}` },
		body: JSON.stringify({
			receive_id: chatId,
			msg_type: "interactive",
			content: JSON.stringify({
				config: { wide_screen_mode: true },
				header: { title: { tag: "plain_text", content: title }, template },
				elements: [{ tag: "div", text: { tag: "lark_md", content: md } }],
			}),
		}),
	});
	return res.json();
}

async function sendText(token: string, chatId: string, text: string): Promise<any> {
	const res = await fetch(`${apiBase(readCreds()?.domain ?? "feishu")}/im/v1/messages?receive_id_type=chat_id`, {
		method: "POST",
		headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${token}` },
		body: JSON.stringify({ receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) }),
	});
	return res.json();
}

/** 发送 Markdown 报告到飞书(卡片渲染, 超长自动分条) */
export async function sendMarkdown(title: string, md: string): Promise<SendResult> {
	const creds = readCreds();
	if (!creds) return { ok: false, detail: "缺少飞书凭证 ~/.pi/agent/feishu/config.pi.json (appId/appSecret)" };
	const { chatId, source } = resolveChatId();
	if (!chatId) return { ok: false, detail: `未找到飞书会话目标 (${source})` };

	let token: string;
	try {
		token = await tenantToken(creds);
	} catch (err) {
		return { ok: false, detail: err instanceof Error ? err.message : String(err), chatId, source };
	}

	const chunks = splitMarkdown(md, 4000);
	for (let i = 0; i < chunks.length; i++) {
		const suffix = chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : "";
		let j = await sendCard(token, chatId, `${title}${suffix}`, chunks[i]);
		if (j.code !== 0) {
			j = await sendText(token, chatId, `【${title}${suffix}】\n${chunks[i]}`);
			if (j.code !== 0) return { ok: false, detail: `发送失败: ${j.code} ${j.msg ?? ""}`, chatId, source };
		}
	}
	return { ok: true, detail: `已推送 ${chunks.length} 条到飞书 (${source})`, chatId, source };
}

/** 上传并发送文件(用于归档完整报告) */
export async function sendFile(filePath: string, fileName?: string): Promise<SendResult> {
	const creds = readCreds();
	if (!creds) return { ok: false, detail: "缺少飞书凭证" };
	const { chatId, source } = resolveChatId();
	if (!chatId) return { ok: false, detail: `未找到飞书会话目标 (${source})` };
	const base = apiBase(creds.domain);
	const token = await tenantToken(creds);
	const name = fileName ?? filePath.split(/[\\/]/).pop() ?? "report.md";
	const buf = readFileSync(filePath);
	const form = new FormData();
	form.append("file_type", "stream");
	form.append("file_name", name);
	form.append("file", new Blob([new Uint8Array(buf)]), name);
	const up = await fetch(`${base}/im/v1/files`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
	const upJson = (await up.json()) as any;
	if (upJson.code !== 0 || !upJson.data?.file_key) return { ok: false, detail: `文件上传失败: ${upJson.code} ${upJson.msg ?? ""}` };
	const res = await fetch(`${base}/im/v1/messages?receive_id_type=chat_id`, {
		method: "POST",
		headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${token}` },
		body: JSON.stringify({ receive_id: chatId, msg_type: "file", content: JSON.stringify({ file_key: upJson.data.file_key }) }),
	});
	const j = (await res.json()) as any;
	if (j.code !== 0) return { ok: false, detail: `文件发送失败: ${j.code} ${j.msg ?? ""}` };
	return { ok: true, detail: `已发送文件 ${name}`, chatId, source };
}

export function feishuStatus(): string {
	const creds = readCreds();
	const { chatId, source, candidates } = resolveChatId();
	const lines = [
		`飞书凭证: ${creds ? `已配置 appId=${creds.appId.slice(0, 8)}… (domain=${creds.domain})` : "未配置"}`,
		`推送目标: ${chatId ?? "未找到"} (${source})`,
		`候选会话: ${candidates.length ? candidates.map((c) => `${c.key}`).join(", ") : "无"}`,
	];
	return lines.join("\n");
}
