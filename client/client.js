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

		// 配色照 sensenova-usage-dashboard：用量 <60% 绿 / <85% 黄 / 其余红
		const colorForPct = (pct) => (pct < 60 ? C.ok : pct < 85 ? "#faad14" : C.err);

		/** 圆环仪表（dashboard gauge 的 JSX 版）：pct = 已用百分比。 */
		function RingGauge({ pct, color, size = 68, caption }) {
			const r = size / 2 - 6;
			const c = 2 * Math.PI * r;
			return h("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", gap: 2, flexShrink: 0 } },
				h("svg", { width: size, height: size },
					h("circle", { cx: size / 2, cy: size / 2, r, fill: "none", stroke: "#eee", strokeWidth: 6 }),
					pct === null ? null :
						h("circle", {
							cx: size / 2, cy: size / 2, r, fill: "none", stroke: color, strokeWidth: 6,
							strokeDasharray: c, strokeDashoffset: c * (1 - pct / 100), strokeLinecap: "round",
							transform: `rotate(-90 ${size / 2} ${size / 2})`, style: { transition: "stroke-dashoffset 0.4s" },
						}),
					h("text", { x: size / 2, y: size / 2 + 5, textAnchor: "middle", fontSize: 14, fontWeight: 600, fill: pct === null ? "#bbb" : color },
						pct === null ? "—" : `${Math.round(pct)}%`)),
				h("span", { style: { fontSize: 10, opacity: 0.65 } }, caption));
		}

		/** 账号卡片：头部（标识符 + 用户名）+ 圆环（5h 池）+ 状态徽章堆栈。 */
		function AccountCard({ account }) {
			const credits = account.usage?.pools?.find((p) => p.poolType === "default");
			const usedPct = credits && typeof credits.ratio5h === "number" ? credits.ratio5h * 100 : null;
			const card = { border: "1px solid #f0f0f0", borderRadius: 8, overflow: "hidden", background: "#fff" };
			const cardHeader = { padding: "8px 12px", background: "#fafafa", borderBottom: "1px solid #f0f0f0", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 };
			const cardBody = { padding: "10px 12px", display: "flex", gap: 14, alignItems: "center" };
			const infoLine = { display: "flex", alignItems: "center", gap: 6, margin: "3px 0", fontSize: 12 };
			const muted = { color: "#888" };
			return h("div", { style: card },
				h("div", { style: cardHeader },
					h("span", null, h("strong", null, account.label), account.enabled ? null : " ", account.enabled ? null : badge("已停用", "#9ca3af")),
					h("span", { style: { fontSize: 12, ...muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
						account.username || "无用户名")),
				h("div", { style: cardBody },
					h(RingGauge, { pct: usedPct, color: usedPct === null ? "#bbb" : colorForPct(usedPct), caption: "5h 池已用" }),
					h("div", { style: { flex: 1, minWidth: 0 } },
						h("div", { style: infoLine },
							account.keyStatus === "ok" ? badge("key 正常", C.ok, C.okBg) : badge(`key ${account.keyStatus}`, C.err, C.errBg),
							h("span", { style: { fontSize: 11, opacity: 0.7 } }, account.keySource)),
						h("div", { style: infoLine },
							account.busy ? badge("忙", C.warn, C.warnBg) : badge("闲", C.ok, C.okBg),
							account.cooldownRemainingMs > 0 ? badge(`冷却 ${Math.ceil(account.cooldownRemainingMs / 1000)}s`, C.warn, C.warnBg) : null),
						h("div", { style: { ...infoLine, ...muted } },
							credits
								? `余量 ${credits.remaining.toLocaleString()} / ${credits.limit.toLocaleString()}`
								: "余量未拉取"),
						h("div", { style: { ...infoLine, ...muted } },
							`最近 429：${fmtTime(account.lastRateLimitAt)}`))));
		}

		/** 账号管理区（照 sensenova-usage-dashboard 的 config-row 交互）：
		 * 每行 = 凭据标识符 + 用户名 + 密码 +「保存并登录」+「删」；保存即落凭据中心。
		 * 凭据标识符 = 账号在凭据中心的命名前缀（如 ACC3 → SENSENOVA_ACC3_* refs）。 */
		function AccountManager({ onChanged, existingLabels = [] }) {
			const [rows, setRows] = react.useState(null);
			const [notice, setNotice] = react.useState(void 0);
			const [busy, setBusy] = react.useState(false);
			const [open, setOpen] = react.useState(false);

			// useCallback 捕获首帧闭包，而 existingLabels 异步加载——用 ref 保最新值
			const existingRef = react.useRef(existingLabels);
			existingRef.current = existingLabels;

			const load = react.useCallback(async () => {
				try {
					const value = await request("GET", ACCOUNTS_PATH);
					const accounts = value.accounts ?? [];
					const editable = accounts.filter((a) => a.source === "credentials");
					const list = editable.length > 0 ? editable : [];
					setRows(list.length > 0
						? list.map((a) => ({ label: a.label, username: a.hasUsername ? a.username ?? "" : "", password: "", hasPassword: a.hasPassword, hasKey: a.hasKey }))
						// 首次使用：预填一行默认凭据标识符（ACC1 起跳过已有）
						: [{ label: nextDefaultLabel(), username: "", password: "", hasPassword: false, hasKey: false }]);
				} catch (e) {
					setRows([]);
					setNotice(`账号清单加载失败：${e?.message ?? e}`);
				}
			}, []);
			react.useEffect(() => { if (open) load(); }, [open, load]);

			/** 新行的默认凭据标识符：ACC<n>，跳过已有（状态表 ∪ 已填行，忽略大小写）。 */
			const nextDefaultLabel = () => {
				const used = new Set(existingRef.current.map((label) => String(label).toUpperCase()));
				for (const row of rows ?? []) {
					if (row.label?.trim()) used.add(row.label.trim().toUpperCase());
				}
				let n = 1;
				while (used.has(`ACC${n}`)) n += 1;
				return `ACC${n}`;
			};
			const emptyRow = () => ({ label: nextDefaultLabel(), username: "", password: "", hasPassword: false, hasKey: false });
			const setRow = (index, patch) => setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));

			const saveRow = async (index) => {
				const row = rows[index];
				if (!row.label.trim() || !row.username.trim()) { setNotice("凭据标识符和用户名不能为空"); return; }
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

			return h(
        "details",
        {
          style: { marginTop: 12 },
          open,
          onToggle: (e) => setOpen(e.target.open),
        },
        h(
          "summary",
          {
            style: {
              fontSize: 12,
              cursor: "pointer",
              opacity: 0.85,
              userSelect: "none",
            },
          },
          "账号管理（保存在凭据中心，不进配置文件）",
        ),
        h(
          "div",
          { style: { padding: "8px 2px" } },
          notice
            ? h(
                "div",
                {
                  style: {
                    fontSize: 12,
                    color:
                      notice.includes("失败") || notice.includes("不能为空")
                        ? C.err
                        : C.ok,
                    margin: "4px 0 8px",
                  },
                },
                notice,
              )
            : null,
          rows === null
            ? h("div", { style: { fontSize: 12, opacity: 0.6 } }, "加载中…")
            : null,
          rows !== null
            ? rows.map((row, index) =>
                h(
                  "div",
                  {
                    key: index,
                    style: {
                      display: "flex",
                      gap: 6,
                      alignItems: "center",
                      marginBottom: 8,
                      paddingBottom: 8,
                      borderBottom: "1px solid rgba(127,127,127,0.15)",
                    },
                  },
                  h("input", {
                    style: { ...input, flex: "0 0 110px" },
                    placeholder: "凭据标识符（如 ACC3）",
                    title:
                      "账号在凭据中心的命名前缀，保存后凭据写入 SENSENOVA_<标识符>_USERNAME/_PASSWORD/_KEY refs（自动转大写）",
                    value: row.label,
                    onChange: (e) => setRow(index, { label: e.target.value }),
                  }),
                  h("input", {
                    style: { ...input, flex: 1 },
                    placeholder: "用户名",
                    value: row.username,
                    onChange: (e) =>
                      setRow(index, { username: e.target.value }),
                  }),
                  h("input", {
                    style: { ...input, flex: 1 },
                    type: "password",
                    placeholder: row.hasPassword
                      ? "已存凭据中心（留空不修改）"
                      : "密码",
                    value: row.password,
                    onChange: (e) =>
                      setRow(index, { password: e.target.value }),
                  }),
                  h(
                    "span",
                    { style: { fontSize: 11 } },
                    row.hasKey
                      ? badge("有 key", C.ok, C.okBg)
                      : badge("无 key", C.warn, C.warnBg),
                  ),
                  h(
                    "button",
                    {
                      style: btnPrimary,
                      disabled: busy,
                      onClick: () => saveRow(index),
                    },
                    "保存并登录",
                  ),
                  h(
                    "button",
                    {
                      style: { ...btn, color: C.err },
                      disabled: busy,
                      onClick: () => removeRow(index),
                    },
                    "删",
                  ),
                ),
              )
            : null,
          rows !== null
            ? h(
                "div",
                { style: { display: "flex", gap: 8, alignItems: "center" } },
                h(
                  "button",
                  {
                    style: btn,
                    disabled: busy,
                    onClick: () =>
                      setRows((prev) => [...(prev ?? []), emptyRow()]),
                  },
                  "＋ 添加账号",
                ),
                h(
                  "span",
                  { style: { fontSize: 11, opacity: 0.65 } },
                  "ACC1：标识符，用户名/密码写入 凭据中心SENSENOVA_<标识符>_USERNAME / _PASSWORD 并立即登录抓取 key，config 配置的账号（来源 settings）不在此显示，仍在配置里维护。",
                ),
              )
            : null,
        ),
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
					.then((value) => { setNotice(`${label} 完成${value ? `：${value}` : ""}`); load(); return value; })
					.catch((e) => setNotice(`${label} 失败：${e?.message ?? e}`))
					.finally(() => setBusy(false));
			};
			// 刷新 = 一个按钮做完整链路：逐个启用账号拉余量；余量拉不动
			// （JWT 过期/缺失）才自动重抓 key 再补拉一次，避免无谓的重复登录
			const enabledLabels = () => (status?.accounts ?? []).filter((a) => a.enabled).map((a) => a.label);
			const refreshAccount = async (label) => {
				try {
					await post(USAGE_PATH, { label });
					return `${label} ✓`;
				} catch (usageError) {
					try {
						await post(REFETCH_PATH, { label });
						await post(USAGE_PATH, { label });
						return `${label} ✓（已重抓 key）`;
					} catch (e) {
						return `${label} ✗ ${e?.message ?? usageError?.message ?? e}`;
					}
				}
			};
			const onRefreshAll = () => {
				const labels = enabledLabels();
				if (!labels.length) { setNotice("没有启用的账号"); return; }
				run(`刷新（${labels.length} 个账号）`, async () => {
					const results = [];
					for (const label of labels) results.push(await refreshAccount(label));
					return results.join("，");
				});
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
				h("div", { style: { display: "flex", alignItems: "center", gap: 8, margin: "4px 0 10px", flexWrap: "wrap" } },
					h("strong", null, "SenseNova Token Plans · 账号池状态"),
					h("button", { style: btn, disabled: busy, onClick: onRefreshAll, title: "逐个启用账号拉取积分池余量；余量拉取失败时自动重抓 key（重新登录）后重试" }, "刷新"),
					notice ? h("span", { style: { fontSize: 12, opacity: 0.8 } }, notice) : null),
				h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 } },
					accounts.map((a) => h(AccountCard, {
						key: a.label, account: { ...a, usage: status?.usage?.[a.label] }
					}))),
				accounts.length === 0
					? h("p", { style: { fontSize: 12, opacity: 0.7 } }, "还没有账号：展开下方「账号管理」填写用户名/密码（保存在凭据中心），或在 profile 的 cordis.patch.yml 中给 dsh-sensenova 行配置 accounts。")
					: null,
				view === "page"
					? h(AccountManager, { onChanged: load, existingLabels: accounts.map((a) => a.label) })
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
