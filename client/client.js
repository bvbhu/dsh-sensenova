/**
 * dsh-sensenova 客户端半区：插件页里的账号池状态与管理卡片。
 *
 * 手写的 ModuleLoader 包装（与宿主打包客户端同构，免构建链）：
 * 宿主提供 require("react") / require("react/jsx-runtime")；本文件注册
 * `plugins.row.config` / `plugins.bundle.config` 两个 slot，渲染账号池
 * 状态表（key 健康、冷却、通用池余量）与操作按钮（刷新余量 / 重抓 key）。
 * 数据来自宿主侧管理路由 /api/dsh-sensenova/*（仅本机 / 受信来源可访问）。
 *
 * @module client/client.js
 */

window.__ModuleLoader__.load({
	id: "dsh-sensenova",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");
		const jsxrt = require("react/jsx-runtime");
		/** JSX 助手：h(type, props, ...children)（自动运行时的薄封装）。 */
		const h = (type, props, ...children) => {
			const p = { ...(props ?? {}) };
			if (children.length === 1) p.children = children[0];
			else if (children.length > 1) p.children = children;
			return jsxrt.jsx(type, p);
		};

		const STATUS_PATH = "/api/dsh-sensenova/status";
		const USAGE_PATH = "/api/dsh-sensenova/refresh-usage";
		const REFETCH_PATH = "/api/dsh-sensenova/refetch-key";
		const POLL_MS = 30_000;

		const fmtTime = (ms) => {
			if (!ms) return "—";
			const d = new Date(ms);
			return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
		};
		const fmtPct = (ratio) => (ratio === undefined || ratio === null ? "—" : `${Math.round(ratio * 100)}%`);
		const post = async (path, body) => {
			const response = await fetch(path, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			const data = await response.json().catch(() => ({}));
			if (!response.ok || data.ok === false) throw new Error(data.error ?? `HTTP ${response.status}`);
			return data.value;
		};

		const labelCell = { padding: "6px 10px", borderBottom: "1px solid var(--dsh-border, #e5e7eb)", whiteSpace: "nowrap", textAlign: "left" };
		const th = { ...labelCell, fontWeight: 600, fontSize: 12, opacity: 0.75 };
		const btn = {
			padding: "2px 10px", margin: "0 4px 0 0", fontSize: 12, cursor: "pointer",
			border: "1px solid var(--dsh-border, #d1d5db)", borderRadius: 6, background: "transparent"
		};
		const badge = (text, color) => h("span", {
			style: {
				fontSize: 11, padding: "1px 8px", borderRadius: 999,
				border: `1px solid ${color}`, color
			}
		}, text);

		function AccountRow({ account, busy, onRefreshUsage, onRefetchKey }) {
			const keyColor = account.keyStatus === "ok" ? "#16a34a" : "#dc2626";
			const credits = account.usage?.pools?.find((p) => p.poolType === "default");
			return h("tr", null,
				h("td", { style: labelCell }, h("strong", null, account.label),
					account.enabled ? null : badge("已停用", "#9ca3af")),
				h("td", { style: labelCell },
					badge(account.keyStatus === "ok" ? "key 正常" : `key ${account.keyStatus}`, keyColor), " ",
					h("span", { style: { fontSize: 11, opacity: 0.7 } }, account.keySource)),
				h("td", { style: labelCell }, account.credSource),
				h("td", { style: labelCell },
					account.busy ? badge("忙", "#d97706") : badge("闲", "#16a34a")),
				h("td", { style: labelCell },
					account.cooldownRemainingMs > 0
						? badge(`${Math.ceil(account.cooldownRemainingMs / 1000)}s`, "#d97706")
						: "—"),
				h("td", { style: labelCell },
					credits
						? `${credits.remaining.toLocaleString()} / ${credits.limit.toLocaleString()}（${fmtPct(credits.ratio5h)}）`
						: `余量未拉取 ${fmtTime(account.lastRateLimitAt ? 0 : 0)}`.trim()),
				h("td", { style: labelCell }, fmtTime(account.lastRateLimitAt)),
				h("td", { style: labelCell },
					h("button", { style: btn, disabled: busy, onClick: () => onRefreshUsage(account.label) }, "刷新余量"),
					h("button", { style: btn, disabled: busy, onClick: () => onRefetchKey(account.label) }, "重抓 key"))
			);
		}

		function StatusCard({ view }) {
			const [status, setStatus] = react.useState(null);
			const [error, setError] = react.useState(void 0);
			const [busy, setBusy] = react.useState(false);
			const [notice, setNotice] = react.useState(void 0);

			const load = react.useCallback(async () => {
				try {
					const response = await fetch(STATUS_PATH);
					const data = await response.json();
					if (data.ok !== false) setStatus(data.value);
					setError(void 0);
				} catch (e) {
					setError(e?.message ?? String(e));
				}
			}, []);

			react.useEffect(() => {
				load();
				if (view !== "page") return void 0;
				const id = setInterval(load, POLL_MS);
				return () => clearInterval(id);
			}, [load, view]);

			const run = (label, action) => {
				setBusy(true);
				setNotice(void 0);
				Promise.resolve()
					.then(action)
					.then((value) => { setNotice(`${label} 完成`); load(); return value; })
					.catch((e) => setNotice(`${label} 失败：${e?.message ?? e}`))
					.finally(() => setBusy(false));
			};
			const onRefreshUsage = (label) => run(`[${label}] 刷新余量`, () => post(USAGE_PATH, { label }));
			const onRefetchKey = (label) => {
				if (!window.confirm(`重抓 ${label} 的 key 会重新登录该账号（限频 10 分钟）。继续？`)) return;
				run(`[${label}] 重抓 key`, () => post(REFETCH_PATH, { label }));
			};

			if (error !== undefined) {
				return h("div", { style: { padding: 12, color: "#dc2626" } }, "状态加载失败：", error, " ",
					h("button", { style: btn, onClick: load }, "重试"));
			}
			const accounts = status?.accounts ?? [];
			const logTail = status?.logTail ?? "";

			if (view === "summary") {
				const okCount = accounts.filter((a) => a.keyStatus === "ok" && a.enabled).length;
				const cooling = accounts.filter((a) => (a.cooldownRemainingMs ?? 0) > 0).length;
				return h("div", { style: { fontSize: 12, opacity: 0.85, padding: "4px 0" } },
					`账号池：${okCount}/${accounts.length} 可用`, cooling > 0 ? ` · ${cooling} 个冷却中` : null);
			}

			return h("div", { style: { padding: "8px 0" } },
				h("div", { style: { display: "flex", alignItems: "center", gap: 8, margin: "4px 0 10px" } },
					h("strong", null, "SenseNova Token Plans · 账号池状态"),
					h("button", { style: btn, disabled: busy, onClick: load }, "刷新"),
					notice ? h("span", { style: { fontSize: 12, opacity: 0.8 } }, notice) : null),
				h("table", { style: { borderCollapse: "collapse", fontSize: 13, width: "100%" } },
					h("thead", null, h("tr", null,
						h("th", { style: th }, "账号"), h("th", { style: th }, "key"), h("th", { style: th }, "凭据"),
						h("th", { style: th }, "状态"), h("th", { style: th }, "冷却"), h("th", { style: th }, "通用池余量（5h）"),
						h("th", { style: th }, "最近 429"), h("th", { style: th }, "操作"))),
					h("tbody", null, accounts.map((a) => h(AccountRow, {
						key: a.label, account: { ...a, usage: status?.usage?.[a.label] },
						busy, onRefreshUsage, onRefetchKey
					})))),
				accounts.length === 0
					? h("p", { style: { fontSize: 12, opacity: 0.7 } }, "还没有账号：在 profile 的 cordis.patch.yml 中给 dsh-sensenova 行配置 accounts（label + 用户名/密码，key 会自动登录抓取）。")
					: null,
				logTail
					? h("details", { style: { marginTop: 10 } },
						h("summary", { style: { fontSize: 12, cursor: "pointer", opacity: 0.8 } }, "最近日志"),
						h("pre", { style: { fontSize: 11, lineHeight: 1.5, overflow: "auto", maxHeight: 220, background: "rgba(127,127,127,0.08)", padding: 8, borderRadius: 6 } }, logTail))
					: null);
		}

		const inject = ["slots"];
		function apply(ctx) {
			try {
				document.body.dataset.dshSensenova = "apply-started";
				const register = (slotName, key) => {
					ctx.slots.inject(slotName, () => ctx.slots.register({
						name: slotName,
						key,
						priority: 30,
						inject: () => ({})
					}, StatusCard));
				};
				register("plugins.bundle.config", "dsh-sensenova");
				register("plugins.row.config", "dsh-sensenova#dsh-sensenova");
				document.body.dataset.dshSensenova = "registered";
			} catch (error) {
				document.body.dataset.dshSensenova = "error: " + (error?.message ?? error);
				console.error("[dsh-sensenova] 状态卡片注册失败（宿主 provider 不受影响）:", error);
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
