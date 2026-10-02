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
		const MODELS_PATH = "/api/dsh-sensenova/models";
		const SAVE_CONFIG_PATH = "/api/dsh-sensenova/save-config";
		const POLL_MS = 30_000;

		// 配色照 sensenova-usage-dashboard（Ant 风格）：主色 #0958d9，
		// 成功 #52c41a / 警告 #faad14 / 错误 #f5222d + 对应浅底徽章。
		const C = { primary: "#0958d9", ok: "#52c41a", okBg: "#e6f7e6", warn: "#ad6800", warnBg: "#fffbe6", err: "#f5222d", errBg: "#fff1f0" };
		const fmtClock = (ms) => { if (!ms) return "—"; const d = new Date(ms); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`; };
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
		/** 解开 volatile 活引用（schemastery Loader 传 get() 对象）。 */
		const unwrapVolatile = (value) => {
			if (value === null || typeof value !== "object") return value;
			if (typeof value.get === "function") return value.get();
			if (Array.isArray(value)) return value.map(unwrapVolatile);
			const out = {};
			for (const [key, item] of Object.entries(value)) out[key] = unwrapVolatile(item);
			return out;
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
		const fmtNum = (n) => Number(n ?? 0).toLocaleString("zh-CN", { maximumFractionDigits: 1 });
		const fmtReset = (ms) => {
			if (!ms) return "—";
			const d = new Date(ms);
			return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
		};

		/** 用量进度条（dashboard 样式：细条 + 用量配色）。 */
		function Bar({ pct }) {
			return h("div", { style: { height: 6, borderRadius: 3, background: "#eee", overflow: "hidden" } },
				h("div", {
					style: {
						height: "100%", width: `${Math.min(100, Math.max(0, pct))}%`,
						background: colorForPct(pct), borderRadius: 3, transition: "width 0.4s",
					},
				}));
		}

		/** 单个积分池明细块（照 dashboard 账号明细）：5h/7d 用量条 + 剩余/使用率 + 重置时间。 */
		function PoolBlock({ pool, grantBalance }) {
			const isDefault = pool.poolType === "default";
			const tag = isDefault ? badge("通用", C.primary, "#e6f4ff") : badge("专属", "#389e0d", "#f6ffed");
			const h5limit = pool.limit ?? 0;
			const h5used = pool.used ?? 0;
			const h5pct = h5limit > 0 ? (h5used / h5limit) * 100 : 0;
			const h5remaining = pool.remaining ?? 0;
			const h5usagePct = 100 - (pool.ratio5h ?? 1) * 100;
			const d7limit = pool.limit7d ?? 0;
			const d7used = pool.used7d ?? 0;
			const d7pct = d7limit > 0 ? (d7used / d7limit) * 100 : 0;
			const d7remaining = pool.remaining7d ?? 0;
			const row = { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, fontSize: 11.5, margin: "2px 0" };
			const labelStyle = { opacity: 0.65 };
			const valueStyle = { fontWeight: 500, fontVariantNumeric: "tabular-nums" };
			return h("div", { style: { border: "1px solid #f0f0f0", borderRadius: 6, padding: "8px 10px", marginTop: 6 } },
				h("div", { style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 4 } },
					tag, h("strong", { style: { fontSize: 12 } }, pool.name || (isDefault ? "通用积分池" : "专属积分池"))),
				h("div", { style: row }, h("span", { style: labelStyle }, "5小时用量"), h("span", { style: valueStyle }, `${fmtNum(h5used)} / ${fmtNum(h5limit)}`)),
				h(Bar, { pct: h5pct }),
				h("div", { style: row }, h("span", { style: labelStyle }, "剩余 / 使用率"), h("span", { style: valueStyle }, `${fmtNum(h5remaining)} · ${h5usagePct.toFixed(1)}%`)),
				d7limit > 0 ? h("div", { style: { ...row, marginTop: 6 } }, h("span", { style: labelStyle }, "7天用量"), h("span", { style: valueStyle }, `${fmtNum(d7used)} / ${fmtNum(d7limit)}`)) : null,
				d7limit > 0 ? h(Bar, { pct: d7pct }) : null,
				d7limit > 0 ? h("div", { style: row }, h("span", { style: labelStyle }, "剩余 / 使用率"), h("span", { style: valueStyle }, `${fmtNum(d7remaining)} · ${(100 - d7pct).toFixed(1)}%`)) : null,
				h("div", { style: { ...row, marginTop: 4, opacity: 0.65 } },
					h("span", null, `重置 ${fmtReset(pool.resetAt)}${d7limit > 0 ? ` / ${pool.resetAt7d ? fmtReset(pool.resetAt7d) : "—"}` : ""}`)),
				isDefault && Number.isFinite(grantBalance)
					? h("div", { style: { ...row, borderTop: "1px dashed #f0f0f0", paddingTop: 4, marginTop: 4 } },
						h("span", { style: labelStyle }, "赠送余额"),
						h("span", { style: valueStyle }, fmtNum(grantBalance)))
					: null);
		}

		/** 合并状态徽章：冷却属于空闲的子态——key 异常时忙/闲/冷却都无意义。
		 *  key 正常 + 在跑请求 = 使用中（主色）；key 正常 + 冷却中 = 冷却中 Xs（黄）；
		 *  key 正常 + 空闲 = 空闲（绿）；key 失效/缺失 = 红色错误态。 */
		function statusBadge(account) {
			if (account.keyStatus !== "ok") return badge(`key ${account.keyStatus}`, C.err, C.errBg);
			if (account.cooldownRemainingMs > 0) return badge(`冷却中 ${Math.ceil(account.cooldownRemainingMs / 1000)}s`, C.warn, C.warnBg);
			return account.busy ? badge("使用中", C.primary, "#e6f4ff") : badge("空闲", C.ok, C.okBg);
		}

		/** 账号卡片：头部（标识符 + 用户名 + 状态徽章）+ 每积分池明细块（赠送余额并入通用池）。 */
		function AccountCard({ account }) {
			const usage = account.usage;
			const pools = usage?.pools ?? [];
			const card = { border: "1px solid #f0f0f0", borderRadius: 8, overflow: "hidden", background: "#fff", transition: "box-shadow 0.2s, border-color 0.2s" };
			const cardHeader = { padding: "8px 12px", background: "#fafafa", borderBottom: "1px solid #f0f0f0", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 };
			const cardBody = { padding: "8px 12px 10px" };
			const muted = { color: "#888" };
			return h("div", { style: card, className: "dsh-sensenova-card" },
				h("div", { style: cardHeader, className: "dsh-sensenova-card-header" },
					h("span", { style: { display: "flex", alignItems: "center", gap: 7, minWidth: 0 } },
						h("strong", null, account.username || account.label),
						account.enabled ? null : badge("已停用", "#9ca3af"),
						statusBadge(account)),
					h("span", { style: { fontSize: 11, ...muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
						account.username ? account.label : "无标识符")),
				h("div", { style: cardBody },
					h("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 2 } },
						h("span", { style: { fontSize: 11, opacity: 0.7 } }, `key 来源：${account.keySource}`),
						h("span", { style: { fontSize: 11, ...muted, marginLeft: "auto" } }, `最近 429：${fmtTime(account.lastRateLimitAt)}`)),
					pools.length === 0
						? h("div", { style: { fontSize: 12, ...muted, padding: "6px 0" } }, "余量未拉取：点上方「刷新」拉取积分池用量")
						: pools.map((pool, i) => h(PoolBlock, {
							key: i, pool,
							grantBalance: pool.poolType === "default" ? usage?.grantBalance : undefined,
						}))));
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
                    style: { ...btn, whiteSpace: "nowrap", flexShrink: 0 },
                    disabled: busy,
                    onClick: () =>
                      setRows((prev) => [...(prev ?? []), emptyRow()]),
                  },
                  "＋ 添加账号",
                ),
                h(
                  "span",
                  { style: { fontSize: 11, opacity: 0.65, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }, title: "凭据标识符 = 凭据中心 ref 的命名前缀（如 ACC1 → SENSENOVA_ACC1_USERNAME / _PASSWORD / _KEY）" },
                  "标识符 ACC<n> = 凭据中心 ref 前缀；保存即写入并登录抓 key；config 账号仍在配置里维护",
                ),
              )
            : null,
        ),
      );
		}

		/** 模型列表（设置页，照 dsh-connect-trae 的 dsm-trae-models 结构）：
		 *  数据来自 GET /api/dsh-sensenova/models（API 发现目录 + enabled 状态）；
		 *  勾选启用（enabledModels），保存走 Host save-config 端点
		 *  （settings.mutate），configForms scope 仅兜底。刷新目录会触发
		 *  后端重新从 /v1/models 拉取（listModels → discover）。 */
		function ModelsList({ settingsScope }) {
			const [models, setModels] = react.useState(null);
			const [error, setError] = react.useState(void 0);
			const [notice, setNotice] = react.useState(void 0);
			const [busy, setBusy] = react.useState(false);
			const [refreshing, setRefreshing] = react.useState(false);
			/** 草稿：id → { enabled, image }（保存前不落配置） */
			const [draft, setDraft] = react.useState(null);

			const applyFresh = react.useCallback((value, silent) => {
				const fresh = value?.models ?? [];
				// 后端 source='static' 且带 error 时，说明 API 拉取失败已降级，
				// 透出给用户（区别于“成功刷新”）
				if (value?.source === 'static' && value?.error) {
					setError(`API 目录拉取失败，已显示静态目录：${value.error}`);
				} else {
					setError(void 0);
				}
				setModels(fresh);
				setDraft(null);
				if (!silent) setNotice("模型目录已刷新");
			}, []);

			const load = react.useCallback(async (silent) => {
				try {
					const value = await request("GET", MODELS_PATH);
					applyFresh(value, silent);
				} catch (e) {
					setError(e?.message ?? String(e));
				}
			}, [applyFresh]);
			// 启动即拉一次（照 trae：status 加载后 visibleModels 即有数据），open 时再拉
			react.useEffect(() => { void load(true); }, [load]);
			react.useEffect(() => { if (open) void load(true); }, [open, load]);

			// 勾选状态：草稿优先，否则取当前配置状态
			const pick = (id) => draft?.[id] ?? (models?.find((m) => m.id === id)?.enabled ? { enabled: true, image: Boolean(models.find((m) => m.id === id)?.image) } : { enabled: false, image: false });
			const activeEnabledIds = new Set((models ?? []).filter((m) => pick(m.id).enabled).map((m) => m.id));
			const toggle = (id, field) => {
				setDraft((prev) => {
					const base = models.find((m) => m.id === id);
					const current = prev?.[id] ?? { enabled: Boolean(base?.enabled), image: Boolean(base?.image) };
					return { ...(prev ?? {}), [id]: { ...current, [field]: !current[field] } };
				});
			};

			const refreshModels = async () => {
				setRefreshing(true);
				try {
					const value = await request("GET", MODELS_PATH);
					const fresh = value?.models ?? [];
					const freshIds = new Set(fresh.map((m) => m.id));
					// 保留仍存在的勾选（照 trae refreshModels：只留 fresh 里的 id）
					setDraft((prev) => {
						if (!prev) return prev;
						const next = {};
						for (const [id, state] of Object.entries(prev)) if (freshIds.has(id)) next[id] = state;
						return next;
					});
					applyFresh(value, false);
				} catch (e) {
					setError(e?.message ?? String(e));
				} finally { setRefreshing(false); }
			};

			const save = async () => {
				if (!models) return;
				setBusy(true); setNotice(void 0);
				try {
const enabledIds = models.filter((m) => pick(m.id).enabled).map((m) => m.id);
					// 写回配置：Host 端点优先（settings.mutate 在宿主进程内执行，
					// 唯一可靠写者；照 dsh-connect-workbuddy 的 __save 模式），
					// scope.set 只作镜像刷新兜底。模态由 API 决定，只写 enabledModels。
					{
						const field = "enabledModels";
						let landed = false;
						try {
							const result = await post(SAVE_CONFIG_PATH, { field, value: enabledIds });
							landed = result?.ok !== false;
						} catch (hostError) {
							if (settingsScope === void 0) throw hostError;
							if (await settingsScope.set(field, enabledIds) === false) throw new Error(`${field} 写入被拒绝（Host 端点与 scope 均失败）`);
							const readBack = unwrapVolatile(settingsScope.getSnapshot().value)?.[field];
							landed = Array.isArray(readBack) && readBack.length === enabledIds.length && enabledIds.every((id) => readBack.includes(id));
							if (!landed) throw new Error(`${field} 未落盘（回读校验失败）`);
						}
						if (!landed) throw new Error(`${field} 写入未确认落盘`);
					}
					setNotice(`已保存：启用 ${enabledIds.length} 个模型`);
					setDraft(null);
					await load(true);
				} catch (e) {
					setNotice(`保存失败：${e?.message ?? e}`);
				} finally { setBusy(false); }
			};

			const fmtCapacity = (n) => n >= 1000000 ? `${(n / 1000000).toFixed(0)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n ?? "—");

			return h("div", { className: "dsm-trae-models", style: { marginTop: 12 } },
				h("div", { className: "dsm-trae-models-head" },
					h("div", null,
						h("h3", { className: "dsm-trae-models-title" }, "模型列表"),
						h("p", { className: "dsm-trae-models-summary" }, `已启用 ${activeEnabledIds.size} / ${models?.length ?? 0} 个模型`)),
					h("button", { type: "button", className: "dsm-btn dsm-btn-outline", disabled: refreshing || busy, onClick: refreshModels },
						refreshing ? "刷新中…" : "刷新目录")),
				error
					? h("p", { className: "dsm-trae-model-capability-note", style: { color: C.err } }, `模型目录加载失败：${error}`)
					: null,
				notice
					? h("p", { className: "dsm-trae-model-capability-note", style: { color: notice.includes("失败") ? C.err : "var(--dsw-alias-label-tertiary,#999)" } }, notice)
					: null,
				models === null
					? h("p", { className: "dsm-trae-model-capability-note" }, "加载中…")
					: h("div", { className: "dsm-trae-model-list" },
						models.map((m) => h("div", { key: m.id, className: `dsm-trae-model${pick(m.id).enabled ? "" : " dsm-trae-model-disabled"}` },
							h("div", { className: "dsm-trae-model-head" },
								h("label", { className: "dsm-trae-model-enabled" },
									h("input", { type: "checkbox", checked: pick(m.id).enabled, disabled: busy, onChange: () => toggle(m.id, "enabled") }),
									h("span", { className: "dsm-trae-model-copy" },
										h("span", { className: "dsm-trae-model-name" }, m.name || m.id))),
								h("div", { className: "dsm-trae-model-options" },
									m.inputModalities && m.inputModalities.includes("image")
										? h("span", { style: { fontSize: 11, opacity: 0.75 } }, "视觉输入")
										: null)),
							h("div", { className: "dsm-trae-model-meta" },
								m.contextWindow ? h("span", null, `上下文 ${fmtCapacity(m.contextWindow)}`) : null,
								m.maxTokens ? h("span", null, `输出 ${fmtCapacity(m.maxTokens)}`) : null)))));
h("div", { className: "dsm-trae-model-actions" },
					h("span", { className: "dsm-trae-model-capability-note" }, "勾选「启用」决定使用的模型；图像模态由 API 返回值自动判断。"),
					h("div", { className: "dsm-trae-model-actions-buttons" },
						h("button", { type: "button", className: "dsm-btn dsm-btn-primary", disabled: busy, onClick: save }, busy ? "保存中…" : "保存勾选")));
		}
		function StatusCard({ view, settingsScope }) {
			const [status, setStatus] = react.useState(null);
			const [error, setError] = react.useState(void 0);
			const [busy, setBusy] = react.useState(false);
			const [notice, setNotice] = react.useState(void 0);
			// 上次成功刷新时间（启动自动刷一次 + 手动/轮询都更新）
			const [lastRefreshAt, setLastRefreshAt] = react.useState(void 0);
			// scope 异步就绪：订阅 rebind 总线，scope 变化时强制重渲染（新 scope 经 inject() 传入）
			const [, setScopeVersion] = react.useState(0);
			react.useEffect(() => {
				const bus = window.__dshSensenovaScopeBus;
				if (!bus) return void 0;
				const fn = () => setScopeVersion((v) => v + 1);
				bus.add(fn);
				return () => bus.delete(fn);
			}, []);

			const load = react.useCallback(async () => {
				try {
					const response = await fetch(STATUS_PATH);
					const data = await response.json();
					if (data.ok !== false) {
						setStatus(data.value);
						setLastRefreshAt(Date.now());
					}
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
					lastRefreshAt ? h("span", { style: { fontSize: 11, opacity: 0.6 } }, `上次刷新 ${fmtClock(lastRefreshAt)}`) : null,
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
				view === "page"
					? h(ModelsList, { settingsScope })
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
				// 设置面 scope（configForms 服务，照 dsh-connect-trae/workbuddy 模式）：
				// 镜像（describe 的 namespaces）异步加载，须订阅 rebind，就绪后自动
				// 绑定到宿主实际服务的 namespace；绑定成功即可写（writable 标志不可靠）。
				let settingsScope;
				let scopeOff;
				const scopeListeners = new Set();
				const scopeNotify = () => { for (const l of [...scopeListeners]) l(); };
				const rebindScope = () => {
					let served;
					try {
						const forms = ctx.get("configForms");
						served = forms === void 0 ? void 0 : (forms.describe().getSnapshot().view?.namespaces ?? []).find((entry) => entry.ns === "dsh-sensenova" || /sensenova/i.test(entry.ns));
					} catch {}
					const next = served === void 0 ? void 0 : ctx.get("configForms")?.get(served.ns);
					if (next !== settingsScope) {
						scopeOff?.();
						settingsScope = next;
						scopeOff = settingsScope?.subscribe(scopeNotify);
						scopeNotify();
					}
				};
				rebindScope();
				try { ctx.get("configForms")?.describe().subscribe?.(rebindScope); } catch {}
				// scope 就绪/变化时通知卡片重渲染（EventsList/ModelsList 经此更新）
				window.__dshSensenovaScopeBus = window.__dshSensenovaScopeBus ?? new Set();
				const bus = window.__dshSensenovaScopeBus;
				const onScope = (fn) => { bus.add(fn); return () => bus.delete(fn); };
				scopeListeners.add(() => { for (const fn of [...bus]) fn(settingsScope); });
				// 卡片 hover 效果（raw JSX 无样式表文件，注入一次全局样式）
				if (!document.getElementById("dsh-sensenova-style")) {
					const style = document.createElement("style");
					style.id = "dsh-sensenova-style";
					style.textContent = [
						".dsh-sensenova-card:hover { border-color: #d9d9d9 !important; box-shadow: 0 2px 8px rgba(0,0,0,0.09); }",
						".dsh-sensenova-card:hover .dsh-sensenova-card-header { background: #f0f5ff !important; }",
						// dsm-trae-models 全套样式（照 dsh-connect-trae，含 dsm-btn 原语）
						".dsm-trae-models{display:flex;flex-direction:column;gap:10px;border-top:1px solid var(--dsw-alias-border-l2,#36373b);padding-top:14px}",
						".dsm-trae-models-head{display:flex;align-items:center;justify-content:space-between;gap:12px}",
						".dsm-trae-models-title{margin:0;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:14px;font-weight:600;line-height:20px}",
						".dsm-trae-models-summary{margin:2px 0 0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}",
						".dsm-trae-model-list{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:10px;overflow:hidden}",
						".dsm-trae-model{display:grid;grid-template-columns:minmax(0,1fr);gap:7px;padding:10px 12px;background:var(--dsw-alias-bg-layer-2,#232529);transition:opacity .16s}",
						".dsm-trae-model-disabled{opacity:.55}",
						".dsm-trae-model+.dsm-trae-model{border-top:1px solid var(--dsw-alias-border-l2,#36373b)}",
						".dsm-trae-model-head{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}",
						".dsm-trae-model-enabled{display:flex;align-items:center;gap:8px;min-width:0;cursor:pointer}",
						".dsm-trae-model-enabled input{margin:0;accent-color:var(--dsw-alias-brand-primary,#5686fe);flex:none}",
						".dsm-trae-model-copy{display:flex;align-items:baseline;gap:8px;min-width:0}",
						".dsm-trae-model-name{display:inline-flex;align-items:baseline;gap:7px;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;font-weight:500;line-height:19px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
						".dsm-trae-model-meta{display:flex;align-items:center;gap:7px 12px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary,#999);font-size:11px;line-height:16px}",
						".dsm-trae-model-options{display:flex;align-items:center;justify-content:flex-end;gap:12px;flex:none}",
						".dsm-trae-model-image{display:inline-flex;align-items:center;gap:4px;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:11px;line-height:16px;cursor:pointer}",
						".dsm-trae-model-image input{margin:0;accent-color:var(--dsw-alias-brand-primary,#5686fe)}",
						".dsm-trae-model-capability-note{margin:0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}",
						".dsm-trae-model-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;border-top:1px solid var(--dsw-alias-border-l2,#36373b);padding-top:12px}",
						".dsm-trae-model-actions-buttons{display:flex;align-items:center;justify-content:flex-end;gap:8px}",
						".dsm-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}",
						".dsm-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}",
						".dsm-btn:disabled{opacity:.4;cursor:default}",
						".dsm-btn-outline{border-color:var(--dsw-alias-border-l2,#36373b);background:transparent;color:var(--dsw-alias-label-primary,#e6e6e6)}",
						".dsm-btn-outline:hover{border-color:var(--dsw-alias-label-dimmed,#777)}",
						".dsm-btn-primary{background:var(--dsw-alias-brand-primary,#5686fe);color:#fff}",
						".dsm-btn-primary:hover{filter:brightness(1.06)}",
					].join("\n");
					document.head.appendChild(style);
				}
				document.body.dataset.dshSensenova = "apply-started";
				const register = (slotName, key) => {
					ctx.slots.inject(slotName, () => ctx.slots.register({
						name: slotName,
						key,
						priority: 30,
						inject: () => ({ settingsScope })
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
