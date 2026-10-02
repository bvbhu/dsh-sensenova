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
		const ACCOUNTS_PATH = "/api/dsh-sensenova/accounts";
		const POLL_MS = 30_000;

		// 配色照 sensenova-usage-dashboard（Ant 风格）：主色 #0958d9，
		// 成功 #52c41a / 警告 #faad14 / 错误 #f5222d + 对应浅底徽章。
		const C = { primary: "#0958d9", ok: "#52c41a", okBg: "#e6f7e6", warn: "#ad6800", warnBg: "#fffbe6", err: "#f5222d", errBg: "#fff1f0" };
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
		const request = async (method, path, body) => {
			const response = await fetch(path, {
				method,
				headers: body === undefined ? void 0 : { "Content-Type": "application/json" },
				body: body === undefined ? void 0 : JSON.stringify(body),
			});
			const data = await response.json().catch(() => ({}));
			if (!response.ok || data.ok === false) throw new Error(data.error ?? `HTTP ${response.status}`);
			return data.value;
		};

		const labelCell = { padding: "6px 10px", borderBottom: "1px solid var(--dsh-border, #e5e7eb)", whiteSpace: "nowrap", textAlign: "left" };
		const th = { ...labelCell, fontWeight: 600, fontSize: 12, opacity: 0.75, background: "rgba(127,127,127,0.06)" };
		const btn = {
			padding: "3px 12px", margin: "0 4px 0 0", fontSize: 12, cursor: "pointer",
			border: "1px solid #d9d9d9", borderRadius: 6, background: "#fff", transition: "all 0.2s"
		};
		const btnPrimary = { ...btn, background: C.primary, borderColor: C.primary, color: "#fff" };
		const input = {
			padding: "4px 8px", border: "1px solid #d9d9d9", borderRadius: 4,
			fontSize: 12, width: "100%", boxSizing: "border-box"
		};
		const badge = (text, fg, bg) => h("span", {
			style: {
				fontSize: 11, padding: "1px 8px", borderRadius: 999,
				border: `1px solid ${fg}`, color: fg, background: bg ?? "transparent"
			}
		}, text);

		function AccountRow({ account, busy, onRefreshUsage, onRefetchKey }) {
			const credits = account.usage?.pools?.find((p) => p.poolType === "default");
			return h("tr", null,
				h("td", { style: labelCell }, h("strong", null, account.label),
					account.enabled ? null : badge("已停用", "#9ca3af")),
				h("td", { style: labelCell },
					account.keyStatus === "ok"
						? badge("key 正常", C.ok, C.okBg)
						: badge(`key ${account.keyStatus}`, C.err, C.errBg), " ",
					h("span", { style: { fontSize: 11, opacity: 0.7 } }, account.keySource)),
				h("td", { style: labelCell }, account.credSource),
				h("td", { style: labelCell },
					account.busy ? badge("忙", C.warn, C.warnBg) : badge("闲", C.ok, C.okBg)),
				h("td", { style: labelCell },
					account.cooldownRemainingMs > 0
						? badge(`${Math.ceil(account.cooldownRemainingMs / 1000)}s`, C.warn, C.warnBg)
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

		/** 账号管理区（照 sensenova-usage-dashboard 的 config-row 交互）：
		 * 每行 = 账号名 + 用户名 + 密码 +「保存并登录」+「删」；保存即落凭据中心。 */
		function AccountManager({ onChanged }) {
			const [rows, setRows] = react.useState(null);
			const [notice, setNotice] = react.useState(void 0);
			const [busy, setBusy] = react.useState(false);
			const [open, setOpen] = react.useState(false);

			const load = react.useCallback(async () => {
				try {
					const value = await request("GET", ACCOUNTS_PATH);
					const accounts = value.accounts ?? [];
					const editable = accounts.filter((a) => a.source === "credentials");
					const list = editable.length > 0 ? editable : [];
					setRows(list.map((a) => ({ label: a.label, username: a.hasUsername ? a.username ?? "" : "", password: "", hasPassword: a.hasPassword, hasKey: a.hasKey })));
				} catch (e) {
					setRows([]);
					setNotice(`账号清单加载失败：${e?.message ?? e}`);
				}
			}, []);
			react.useEffect(() => { if (open) load(); }, [open, load]);

			const emptyRow = () => ({ label: "", username: "", password: "", hasPassword: false, hasKey: false });
			const setRow = (index, patch) => setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));

			const saveRow = async (index) => {
				const row = rows[index];
				if (!row.label.trim() || !row.username.trim()) { setNotice("账号名和用户名不能为空"); return; }
				if (!row.password && !row.hasPassword) { setNotice("密码不能为空（首次保存必填）"); return; }
				setBusy(true); setNotice("保存中…");
				try {
					const result = await request("POST", ACCOUNTS_PATH, {
						label: row.label.trim(), username: row.username.trim(), password: row.password || undefined,
					});
					setNotice(result.keyUpdated
						? `账号 ${result.label} 已保存并登录成功（key 已落凭据中心）`
						: `账号 ${result.label} 凭据已保存，但登录抓 key 失败：${result.loginError}（空池回合会自动重试）`);
					await load();
					onChanged?.();
				} catch (e) {
					setNotice(`保存失败：${e?.message ?? e}`);
				} finally { setBusy(false); }
			};

			const removeRow = async (index) => {
				const row = rows[index];
				if (!window.confirm(`从账号清单移除 ${row.label}？（凭据中心 refs 保留）`)) return;
				setBusy(true); setNotice(void 0);
				try {
					await request("DELETE", ACCOUNTS_PATH, { label: row.label });
					await load();
					onChanged?.();
				} catch (e) {
					setNotice(`移除失败：${e?.message ?? e}`);
				} finally { setBusy(false); }
			};

			return h("details", { style: { marginTop: 12 }, open, onToggle: (e) => setOpen(e.target.open) },
				h("summary", { style: { fontSize: 12, cursor: "pointer", opacity: 0.85, userSelect: "none" } }, "账号管理（保存在凭据中心，不进配置文件）"),
				h("div", { style: { padding: "8px 2px" } },
					notice ? h("div", { style: { fontSize: 12, color: notice.includes("失败") || notice.includes("不能为空") ? C.err : C.ok, margin: "4px 0 8px" } }, notice) : null,
					rows === null ? h("div", { style: { fontSize: 12, opacity: 0.6 } }, "加载中…") : null,
					rows !== null ? rows.map((row, index) =>
						h("div", { key: index, style: { display: "flex", gap: 6, alignItems: "center", marginBottom: 8, paddingBottom: 8, borderBottom: "1px solid rgba(127,127,127,0.15)" } },
							h("input", { style: { ...input, flex: "0 0 90px" }, placeholder: "账号名", value: row.label, onChange: (e) => setRow(index, { label: e.target.value }) }),
							h("input", { style: { ...input, flex: 1 }, placeholder: "用户名", value: row.username, onChange: (e) => setRow(index, { username: e.target.value }) }),
							h("input", { style: { ...input, flex: 1 }, type: "password", placeholder: row.hasPassword ? "已存凭据中心（留空不修改）" : "密码", value: row.password, onChange: (e) => setRow(index, { password: e.target.value }) }),
							h("span", { style: { fontSize: 11 } },
								row.hasKey ? badge("有 key", C.ok, C.okBg) : badge("无 key", C.warn, C.warnBg)),
							h("button", { style: btnPrimary, disabled: busy, onClick: () => saveRow(index) }, "保存并登录"),
							h("button", { style: { ...btn, color: C.err }, disabled: busy, onClick: () => removeRow(index) }, "删")))
						: null,
					rows !== null
						? h("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
							h("button", { style: btn, disabled: busy, onClick: () => setRows((prev) => [...(prev ?? []), emptyRow()]) }, "＋ 添加账号"),
							h("span", { style: { fontSize: 11, opacity: 0.65 } }, "保存在设置页填写的账号密码会写入凭据中心（SENSENOVA_* refs）并立即登录抓取 key；config 配置的账号（来源 settings）不在此显示，仍在配置里维护。"))
						: null));
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
					? h("p", { style: { fontSize: 12, opacity: 0.7 } }, "还没有账号：展开下方「账号管理」填写用户名/密码（保存在凭据中心），或在 profile 的 cordis.patch.yml 中给 dsh-sensenova 行配置 accounts。")
					: null,
				view === "page"
					? h(AccountManager, { onChanged: load })
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
