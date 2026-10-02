# dsh-sensenova — SenseNova Token Plan 账号池统一接入插件 · 最终设计

> **版本：v1.0 最终稿（2026-10-02）**
> 设计输入：`PLUGIN-DESIGN-CONTEXT.md`（2026-10-01/02 两轮限流与缓存实测 + round2 结论，与
> `D:\projects\temp\sensenova-ratelimit-report\` 同步）、`D:\projects\sensenova-usage-dashboard\`
> （登录与用量查询参考实现，关键接口已实测打通）、现有插件源码
> `dsh-zcode2api` / `dsh-free-search` / `dsh-usage-statistics-panel` / `dsh-quilt-compact`。
> 全部设计决策已定稿；**P0 接口验证已于 2026-10-02 完成**（function calling / SSE / 视觉 / usage 全部通过，见 §12）。
> 唯一开放参数是 429 终局策略的退避参数（§5.4，随实测回填）。

---

## 0. 结论速览

| 问题 | 最终结论 |
|---|---|
| 定位 | 把 SenseNova Token Plan（`https://token.sensenova.cn/v1`，OpenAI 兼容）注册为 dsh LLM provider（id=`sensenova`），多账号池调度，横向扩容限流。**主力模型 deepseek-v4-flash**（能力最优） |
| API key 抓取 | 账号密码 → OAuth2+PKCE 登录 → JWT（3h）→ `GET https://iam.sensecoreapi.cn/iam/idp/v1/apiKeys`，**已实测打通**（返回明文 `sk-`）；**只取第一个 enabled，纯文本保存** |
| 凭据存储 | **凭据中心为主**（`ctx.get('credentials')` → `~/.dsh/.credentials.yaml`，ref 命名 `SENSENOVA_ACC<N>_*`）；**用户名/密码/key 均可在设置页直填**，双轨并存、凭据中心优先。JWT 与 key 持久化进凭据中心，运行期只在内存使用 |
| 图片预解析 | **默认不必要，不做**。模态声明（flash-lite/kimi-k3/deepseek-flash 为视觉）+ 路由分流 + 纯文本模型占位降级；保留默认关闭的 `visionDescribe` 逃生舱（P2） |
| 用量统计 | 两层：① dsh 面板按 provider 自动聚合（含缓存命中率）；② 插件**按需**拉取 `pool-usage`（状态页打开/手动/重抓后），不做后台轮询 |
| function calling | **已实测可用**（`finish_reason: tool_calls` + 正确参数，2026-10-02），且长期使用验证；流式 `delta.content` / `delta.reasoning_content` 双通道、usage 含 `cached_tokens` 与 `reasoning_tokens` |
| 池耗尽 | **TPM 限制下积分池不会耗尽**（持续使用 deepseek-v4-flash 也如此）；余量仅通过平台接口（pool-usage）**按需**判断，不做后台轮询 |
| 429 终局策略 | 可切换 `rateLimitMode`，倾向 `wait-until-available`（重试直到可用或 signal 中止）；退避参数随实测回填（§5.4） |

---

## 1. 目标与非目标

**目标**
1. `sensenova` 成为 dsh 的一等模型供应商：流式、工具调用、多模态、usage/缓存命中率全链路正确。
2. 多账号池调度：额度感知、429 换号、会话粘性、连接亲和保前缀缓存。
3. 凭据全自动：登录抓 key、JWT 按需重登、key 失效重抓，零手动配置（手动直填仅作平级替代）。
4. 用量统计：dsh 面板自动聚合 + 每账号积分余量展示，余量参与调度决策。
5. Web 设置页/状态页：账号管理、池状态、积分余量。

**非目标**：不对外暴露通用反代端口；不做 AK/SK 大装置认证；不做多机共享状态。

---

## 2. 设计输入：已验证事实

### 2.1 平台接口（2026-10-02 实测）

| 接口 | 方法 | 认证 | 说明 |
|---|---|---|---|
| `platform.sensenova.cn/oauth2/auth` | GET | — | OAuth2 授权入口（须从该域发起，CSRF cookie 域随入口域名走） |
| `iam.sensecoreapi.cn/iam/authn/v1/auth/nova/login` | POST | — | 账号 + JWE 加密密码 + `login_challenge`；密码用 JWKS `public:hydra.openid.id-token` 做 RSA-OAEP + A256GCM |
| `signin.sensecore.cn/oauth2/token` | POST | — | code + PKCE verifier 换 `access_token`（**3h**）+ `refresh_token` |
| `iam.sensecoreapi.cn/iam/idp/v1/apiKeys` | GET | Bearer JWT | `?page_size=100&page_token=`，**返回明文 `sk-`**；字段 `{id, displayname, create_time, is_default, status, type, content, api_key}`，`next_page_token` 分页 |
| `iam.sensecoreapi.cn/iam/idp/v1/apiKeys` | POST | Bearer JWT | 创建 key（`autoCreateKey`，默认关闭） |
| `platform.sensenova.cn/lite/console/v1/tokenplan/pool-usage` | GET | Bearer JWT | 每池 `window_5h`/`window_7d`（limit/used/remaining/reset_at）、`grant_balance`、`pool_type`（default/dedicated）、`model_ids` |
| `token.sensenova.cn/v1/models`、`/v1/chat/completions` | GET/POST | Bearer key | 推理端点；`image_url`（data URL）字段被接受（HTTP 200，实测） |

登录流程移植：`auth_login.py`（Python）→ Node，用 [`jose`](https://github.com/panva/jose) 做 JWE/JWKS。

### 2.2 限流与前缀缓存（实测，设计约束）

- **限流桶 = 账号**：同账号多 key 合并计；跨账号完全独立。429 报文恒为 `inference exceeds tpm/rpm limit`，无 `retry-after` / `x-ratelimit-*` 头，窗口约 1 分钟滚动计数。
- **TPM 限制下积分池不会耗尽**：持续使用 deepseek-v4-flash 也远够不到池上限，池耗尽不构成实际约束；429 恒为分钟级 TPM/RPM 限制。余量仅通过平台接口（pool-usage）**按需**判断与展示，不做后台轮询、不参与调度硬约束。
- **突发并发（原始实测）**：空窗口 8 连发拒 ~3 个，≤5 并发未观察拒绝。但 TPM 才是首要瓶颈——账号内并发只会更快烧满分钟窗口引发 429，故**决策为单账号串行**（§5.2、§6）：每账号同一时刻只放行一个请求，多余请求排队；横向吞吐由多账号轮换提供。
- **前缀缓存**：命中 tokens 不计 TPM（经济杠杆）；缓存存于推理节点本地、**跨账号可见**；单条 keep-alive 连接（`maxSockets=1`）6/6 稳定命中，默认连接池 ~50%；条目 TTL 10–15 分钟；命中按 1024-token 块对齐、多为部分命中；增量多轮头 1–2 轮必 miss。

### 2.3 模型目录与模态（round2 实测 + 用户确认）

| 模型 | 模态 | 积分池 | 默认上架 |
|---|---|---|---|
| deepseek-v4-flash | text | 通用 | ✅ **主力**（能力最优；contextWindow 1M / maxTokens 384k，取自现网配置） |
| sensenova-6.8-flash-lite | **text+image** | 专属池（独立 60k/5h） | ✅ 视觉/高吞吐（contextWindow 256k） |
| kimi-k3 | **text+image** | 通用（round2 确认可用） | ✅ 视觉（contextWindow 256k） |
| glm-5.2 | text | 通用 | ✅（contextWindow 1M / maxTokens 384k） |
| deepseek-flash | **text+image** | 通用 | ❌ 容量饱和（反复请求多数 429），不使用 |

其余模型（deepseek-v4-pro、deepseek-v4.1-flash、sensenova-u1-fast / u1.5-lite）**不使用**，不进目录。

---

## 3. 架构总览与代码布局

```
dsh 会话/代理请求
        │  GenerateOptions (provider='sensenova', model, messages, tools, sessionId, signal)
        ▼
┌────────────────────────── dsh-sensenova（cordis fiber）──────────────────────────┐
│  SenseNovaAdapter extends LlmAdapter        [lib/adapter.js]                     │
│      │                                                                          │
│      ▼                                                                          │
│  Scheduler 调度器                           [lib/scheduler.js]                  │
│   ├─ 账号池: acc{ label, key, keyHealth, cooldownUntil, busy, gate,             │
│   │            pinnedAgent, credits }                                           │
│   ├─ 选号: 健康过滤 → 会话粘性 → 余量最大 → 轮转（忙账号排除出池）             │
│   └─ 失败域: key 失效(401/403) → 账号冷却(429) → 全池按 rateLimitMode 终局      │
│      │                                                                          │
│      ▼                                                                          │
│  SenseNovaClient                            [lib/client.js]                     │
│   ├─ 每账号一条 keep-alive 钉连（https.Agent{keepAlive:true, maxSockets:1}）    │
│   └─ POST /v1/chat/completions（SSE → StreamChunk）                             │
│                                                                                 │
│  AuthManager        [lib/auth.js]        UsageManager       [lib/usage.js]      │
│   ├─ OAuth2+PKCE(jose)（按需登录）        ├─ pool-usage 按需拉取                │
│   └─ apiKeys 枚举 → 取第一个             └─ 余量展示 + 极端保护（软约束）       │
│                                                                                 │
│  CredentialsRepo                            [lib/credentials.js]                │
│   └─ ACC<N>_USERNAME/PASSWORD/KEY/JWT 读写（ctx.get('credentials') 动态获取）   │
└──────────────────────────────────────────────────────────────────────────────────┘
```

```
dsh-sensenova/
├── package.json          # dsh.bundle.patch / dsh.client；peer 依赖照 quilt-compact
├── cordis.patch.yml      # insert 行（开发期 file:// URL + ?v=N 破缓存）
├── lib/
│   ├── index.js          # 入口：name/inject/Config/apply（照 zcode2api 热更新模式）
│   ├── adapter.js        # LlmAdapter 实现
│   ├── scheduler.js      # 账号池调度（可注入假 client 做确定性单测）
│   ├── client.js         # 钉连 HTTP + SSE 解析 → StreamChunk
│   ├── auth.js           # 登录（jose）+ apiKeys 抓取
│   ├── usage.js          # pool-usage 按需拉取器（状态页/手动触发，无后台定时器）
│   ├── credentials.js    # 凭据中心读写
│   ├── models.js         # 模型目录
│   └── images.js         # 图片块序列化（视觉 data URL / 占位文本）
├── client/client.js      # 设置页 + 状态页（M4）
└── test/                 # unit / e2e / probe（node --test，照 quilt-compact 结构）
```

插件骨架（照 `dsh-zcode2api` 成熟模式）：

```js
export const name = 'sensenova'
export const inject = ['llm']        // credentials 运行期 ctx.get() 动态取（可能晚挂载）
export const Config = z.object({ … }) // @deepseek-ai/schemastery，可变字段 .volatile()
export function apply(ctx, config) {
  // 热更新：resolveOptions + lastGood 兜底（照抄 zcode2api）
  ctx.llm.registerConfigurableProviders([{
    provider: 'sensenova',
    displayName: 'SenseNova Token Plan（账号池）',
    settingsNs: ctx.fiber?.entry?.options?.id ?? name, settingsPath: [],
  }])
  ctx.llm.registerAdapter(['sensenova'], adapter)
}
```

```yaml
# cordis.patch.yml
- insert:
    - id: dsh-sensenova
      name: 'file:///D:/projects/dsh-sensenova/lib/index.js?v=1'
```

---

## 4. LlmAdapter 契约与请求映射

### 4.1 契约映射

| dsh-llm 方法 | 实现 |
|---|---|
| `providerInfo(p)` | `{ id: 'sensenova', name: 'SenseNova Token Plan（账号池）' }` |
| `providerRetryPolicy(p)` | 429/5xx 退避参数（§5.4），`RetryPolicySchema` 声明 |
| `imageRequestPricing` | 不声明（`undefined`），调用方兜底 |
| `listModels(p)` | §2.3 目录（含 `inputModalities`、`contextWindow`） |
| `resolveModel(p, m, signal)` | 精确模型元数据 |
| `prepareCall(p, m, signal)` | 绑定当代 adapter 生成，防热更新串代 |
| `stream(options)` | 核心：调度取号 → 组装载荷 → SSE → StreamChunk → 归还号 |

### 4.2 GenerateOptions → OpenAI 载荷

- `system` → 首条 `role:'system'` 消息；messages 逐条映射（text / tool-call / tool-result）。
- `tools` → `tools:[{type:'function',function:{…}}]`。**已实测可用**（2026-10-02：`finish_reason:'tool_calls'` + 正确参数；用户长期使用亦验证）。
- **reasoning 预算**：这些模型默认产出 reasoning tokens（计入 completion 预算，实测 `reasoning_tokens` 19–86/次）——`max_tokens` 过小时 `finish_reason:'length'` 且 content 为空；adapter 的默认 maxTokens 配置须给 reasoning 留量。
- `sessionId` 不进载荷，仅作调度粘性键；`signal` 全链路透传。
- `purpose:'compaction' | 'session-title'` → 低优先级队列（不与交互请求争抢账号）。

### 4.3 SSE → StreamChunk

| 上游（字段名已实测确认） | StreamChunk |
|---|---|
| `delta.content` | `{type:'text-delta', index, text}` |
| `delta.reasoning_content`（实测存在） | `{type:'reasoning-delta', index, text}` |
| `delta.tool_calls` | `{type:'tool-call-delta', index, id, name?, argumentsDelta}` |
| `usage`（`stream_options.include_usage:true`，实测有独立 usage 块） | `{type:'usage', usage:{inputTokens, outputTokens, totalTokens?, cacheReadTokens: prompt_tokens_details.cached_tokens, reasoningTokens: completion_tokens_details.reasoning_tokens}}` |
| `finish_reason` / `data:[DONE]` | `{type:'finish', reason}` |

`cacheReadTokens` 让 dsh 面板的缓存命中率曲线直接可用，且命中不计 TPM 是本池经济杠杆——usage chunk 正确性是硬要求。

---

## 5. 账号池调度器

### 5.1 账号运行态

```js
{
  label: 'ACC1',
  username, passwordSource,            // credentials | settings | env
  key: { value, status: 'ok'|'dead', deadAt },   // 单 key：同账号多 key 共享限流（实测），取第一个即可
  cooldownUntil: 0,                    // 账号级 429 微冷却
  busy: false,
  gate: SerialGate(),                  // 单账号串行闸门：忙账号排除出池，多余请求排队等待
  agent: new https.Agent({ keepAlive: true, maxSockets: 1 }),  // 钉连！账号↔连接 1:1
  credits: { default: {remaining, resetAt}, dedicated: {…} },
  lastUsedAt, lastSessionId,
}
```

### 5.2 选号策略（按序）

1. **健康过滤**：`enabled && cooldownUntil ≤ now && key.status==='ok'`；忙（闸门占用）账号排除出候选池而非按在途数降级——单账号串行（§6）。
2. **模型→池映射与余量**：TPM 限制下积分池不会成为实际瓶颈（持续使用 deepseek-v4-flash 也耗不尽），余量**仅通过 pool-usage 按需判断**（取最近一次缓存值；未拉取过则视为无限），不阻塞调度——余量数据的价值是状态页展示与极端保护，不是选号硬约束。
3. **评分**（高分优先）：会话粘性（`sessionId === acc.lastSessionId`，软粘性——跨账号缓存也 5/6 命中）> 5h 余量占比最大（**仅当存在 pool-usage 缓存值时参与**，否则自然跳过）> 轮转（`lastUsedAt` 最旧）。
4. **取号** = 占用该账号的串行闸门；全池都在忙 → 短暂重扫等待；全池不可用 → 等最近唤醒事件（冷却到期 / 释放 / 重抓完成），期间响应 `signal`。

### 5.3 失败域

```
请求失败
├─ 连接前 429 / 5xx / 网络错  → 账号微冷却(默认 60s) → 立即换下一账号（跨账号独立，实测秒级可用）
├─ 401 / 403(key)            → key 标 dead → 账号降级 + 后台重抓（重登→枚举→取第一个 enabled 覆写，
│                               限频 ≥10 分钟/账号）
├─ 流中途断                  → 不自动换号重放（块已外发，重放会重复输出）→ 终止 chunk
└─ 全部账号一轮耗尽           → 按 rateLimitMode 分派（§5.4）
```

两模式共同的前置行为相同（key 失效处理、账号冷却、换号顺序、`signal` 透传），只分歧在"全池耗尽后怎么办"。`purpose:'compaction'` 的请求在拥挤时主动让路。

### 5.4 429 终局策略（可切换；默认值随实测回填，当前倾向 A）

| 模式 | 行为 | 适用 |
|---|---|---|
| **A. `wait-until-available`**（暂定默认） | 指数退避 500ms×2ⁿ（封顶 8s）循环重扫账号池，**直到拿到可用号或 `signal` 中止**，不设尝试上限 | 交互式会话：宁等 30s 也不让 turn 直接报错 |
| B. `failover-then-fail` | 退避预算（对齐 `providerRetryPolicy`）耗尽后 `throw LlmError('RATE_LIMIT')`，交 dsh 重试机制 | 后台批量/无人在场，快速失败让上层决策 |

实测回填清单（退避参数）：全池同时 429 的实际持续时间；退避节奏对 1 分钟滚动窗口的恢复速度；429 后立即小请求试探是否比纯退避更快。
> **现网实证（2026-10-02）**：现有 pi-ai 直连配置的 429 策略就是 `wait-until-available` 形态——固定 5s 间隔、maxRetries 1000、jitter 0，长期使用有效。插件默认指数退避 500ms×2ⁿ 封顶 8s 是同思路的更快变体，观感异常时回退 5s 固定即可。

---

## 6. 连接管理与前缀缓存

- **账号 ↔ 连接 1:1 钉死**：每账号常驻一条 `https.Agent({keepAlive:true, maxSockets:1})`，该账号请求顺序化（实测 6/6 命中 vs 池化 ~50%）。**单账号串行**——账号内并发只会更快烧满 TPM 分钟窗口，多余请求排队而非多开连接；横向吞吐由多账号轮换提供。排队换命中率，值得。
- 会话粘性（§5.2）叠加：同一对话大概率落回同账号同连接。
- TTL 10–15 分钟：空闲会话下一轮可能 miss，属正常冷启动；**不做主动预热**（烧积分），一切"额外请求"默认关闭同理。

---

## 7. 凭据管理

### 7.1 为什么是凭据中心 + 设置页双轨

| 维度 | 纯内存 | 凭据中心 + 设置页 |
|---|---|---|
| 重启后 | 全丢，每次冷启动重登 N 账号 | `ACC<N>_KEY`/`JWT` 直接可用，JWT 未过期则零登录 |
| dsh 生态 | 私有方案 | 官方接缝（free-search 同款），设置页表单直填即用 |
| 多账号 | 配置越堆越多 | ref 编号即账号清单 |

结论：**凭据中心持久层 + 运行期内存 + 设置页一等入口**。登录频次最低化：JWT（3h）与 key 一起缓存，启动校验 `exp`，仅过期或 401 时重登。

### 7.2 ref 布局（账号固定编号 `ACC<N>`，全部纯文本值）

| ref | 写入者 | 内容 |
|---|---|---|
| `SENSENOVA_ACC1_USERNAME` | 用户 | 登录用户名/邮箱（明文，如 `hubuv`） |
| `SENSENOVA_ACC1_PASSWORD` | 用户 | 登录密码 |
| `SENSENOVA_ACC1_KEY` | 插件抓取后覆写（也可手写） | **纯文本，只存第一个**：枚举结果里第一个 `status=enabled` 的 key，值为 `sk-…` 本身 |
| `SENSENOVA_ACC1_JWT` | 插件 | JWT 缓存（3h）。可随时删除，删除即强制重登 |

- **编号不使用账号名**：账号名是 `USERNAME` 的值，改名/换号不动 ref 结构。
- **key 只取第一个**：实测同账号多 key 合并计限流，多 key 只有冗余价值；失效对策不是换 key 而是重抓（枚举自然跳过 disabled）。手动与自动共用同一 ref。
- **JWT 独立成可丢弃缓存**：派生凭证与长期凭据分开，坏了删掉重登。

### 7.3 读取优先级与同步

```
账号可用 key = credentials SENSENOVA_ACC<N>_KEY（纯文本 sk-…）
             > settings.accounts[].key（设置页 role('secret')）
             > env SENSENOVA_KEY_<N>

账号可用用户名/密码 = credentials SENSENOVA_ACC<N>_USERNAME/PASSWORD
                   > settings.accounts[].username/password（设置页直填，schemastery 自动渲染表单）
                   > env SENSENOVA_ACC<N>_USERNAME/PASSWORD
```

- **设置页是一等入口**：`accounts[].username/password/key` 声明在 Config（`.volatile()`，secret 字段 `role('secret')`），填了即用，不必进凭据中心；两源都填时凭据中心 ref 优先。状态页标注每账号凭据来源（credentials / settings / env）。
- 登录成功后写回 `KEY`（取第一个 enabled）与 `JWT`（含 `exp`）；`describe(ref)` 做状态页展示（只回 configured 布尔，不回显值）。
- key 401/403 → 内存标 dead + 触发重抓（限频 ≥10 分钟/账号）→ `KEY` 覆写。

### 7.4 自动抓取流程（已实测打通）

```
login(label):
 1. GET  platform.sensenova.cn/oauth2/auth (PKCE S256, client_id=nova) → 跟随重定向取 login_challenge
 2. JWKS 取 public:hydra.openid.id-token → jose JWE 加密密码 (RSA-OAEP + A256GCM)
 3. POST iam.sensecoreapi.cn/iam/authn/v1/auth/nova/login → redirect → 跟随取 ?code=
 4. POST signin.sensecore.cn/oauth2/token → {access_token(3h), refresh_token}
 5. GET  iam.sensecoreapi.cn/iam/idp/v1/apiKeys?page_size=100 → api_keys[]
 6. 过滤 status=enabled 且有 api_key（优先 type='nova.tokenplan.v1'）→ 取第一个
    → 覆写 SENSENOVA_ACC<N>_KEY（纯文本），JWT 写 SENSENOVA_ACC<N>_JWT
```

- **平台层按需登录，无后台定时器**：JWT 仅在需要调控制台接口时才使用——key 缺失/失效需重抓、打开设置页或状态页、手动刷新。过期判断读 `ACC<N>_JWT` 的 `exp`，过期则重登（统一走重登——refresh_token 端点未验证，auth_login.py 即如此、实测稳定），成功后同步 `ACC<N>_JWT`。推理请求本身只用 sk- key，**永远不触发登录**。
- `autoCreateKey`（默认 false）：账号无可用 key 时 `POST /iam/idp/v1/apiKeys`（`displayname: 'dsh-sensenova'`）——代用户创建属敏感操作，显式开启。
- 登录流程依赖逆向的 OAuth 链路，诊断日志模式照搬 auth_login.py（每跳记录 URL/状态/Location/响应片段）。

---

## 8. 用量统计

### 8.1 dsh 层（零成本，自动）

provider 注册后，dsh token-meter 按 `request/header` 记录每次调用，usage-statistics-panel 直接按 **provider=sensenova** 聚合：Token 趋势、活跃热力图、模型/供应商占比、**缓存命中率曲线**（来自 `cacheReadTokens`）。

### 8.2 平台层（插件自有：账号积分池，纯按需）

- **拉取时机（无后台定时器）**：① 状态页打开时拉取并在页面存续期间按 `usagePollSeconds` 刷新，关闭即停；② 手动刷新；③ 重抓 key 成功后顺带一次。其余时间不登录、不请求控制台接口。
- **存储**：**除凭据（§7.2 refs）外无任何持久化**——余量、本地估算、统计全部内存态，进程重启归零（下次打开状态页重新拉取）。
- **Web 路由**（`ctx.webServer.register`，free-search bridge 模式）：
  - `GET …/status` — 各账号：key 健康、忙/闲、冷却状态、最近一次拉取的 5h/7d 余量与 reset_at（带拉取时间戳，未拉取过则标注）、最近 429 时间、凭据来源
  - `POST …/accounts/:label/refresh` — 强制刷新用量 / 重抓 key
  - `POST …/accounts` — 增删账号：用户名/密码直接写设置 `accounts[]`；可选动作"写入凭据中心 ref"
- **喂调度器**：`remaining` 仅在有缓存值时参与选号评分（§5.2），做极端低余量保护，非硬约束。
- **本地估算**：`(prompt_tokens − cached_tokens) + completion_tokens` 内存累计，与平台 `used` 对账展示（标注"估算"，平台数据为准）。

---

## 9. 图片处理：不做默认预解析

- **目录声明**：视觉模型（flash-lite / kimi-k3 / deepseek-flash）`inputModalities:['text','image']`；纯文本（deepseek-v4-flash / glm-5.2）`['text']`——dsh-llm 语义中显式缺 image 即负向能力，上游据此路由。
- **视觉模型**：image 块 → `attachments.readImage` / `imageHostPath` 取字节（zcode2api `materializeImages` 同款，免临时文件）→ base64 data URL `image_url`。
- **纯文本模型**：offloaded 块 → `offloadedImageText(block.attachment)`；未 offloaded → `[图片 #N（当前模型不支持图像；附件：<name>）]`——与 dsh-compaction-image-offload 的宿主级语义一致，agent 需要时可自行 Read 附件路径。
- **不做默认预解析的理由**：① 池内自有视觉模型，含图请求应路由过去，信息无损；② 预解析每次多烧一次积分（本池最紧缺的资源）、加延迟、新增失败面；③ 注入描述文本改变前缀，牺牲缓存命中率。
- **逃生舱（P2）**：`visionDescribe: { enabled:false, model:'sensenova-6.8-flash-lite', maxTokens:256 }`——仅对"目标为纯文本模型且消息含图"的请求，先用指定视觉模型生成描述（按 attachment id 去重，一图只描述一次），以 `[图片 #k 描述：…]` 注入。

---

## 10. 配置面

```js
const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  accounts: z.array(z.object({
    label: z.string().required(),                      // ref 编号段：'ACC1' → SENSENOVA_ACC1_USERNAME/PASSWORD/KEY/JWT
    username: z.string().volatile(),                   // 设置页直接填；与凭据中心 ref 双轨，ref 优先
    password: z.string().role('secret').volatile(),    // 同上
    key: z.string().role('secret').volatile(),         // 手动兜底（与 ACC<N>_KEY 二选一即可）
    enabled: z.boolean().default(true).volatile(),
  })).default([]).volatile(),
  models: z.array(catalogModel).default(DEFAULT_MODELS).volatile(),   // §2.3 目录可覆盖
  rateLimitMode: z.enum(['wait-until-available', 'failover-then-fail'])
    .default('wait-until-available').volatile(),       // 默认值随实测回填（§5.4）
  accountCooldownMs: z.number().min(0).default(60_000).volatile(),
  usagePollSeconds: z.number().min(60).default(300).volatile(),   // 状态页打开期间的刷新周期（关闭即停，无后台轮询）
  autoCreateKey: z.boolean().default(false).volatile(),
  visionDescribe: z.object({
    enabled: z.boolean().default(false),
    model: z.string().default('sensenova-6.8-flash-lite'),
    maxTokens: z.number().default(256),
  }).volatile(),
  retryPolicy: RetryPolicySchema,
})
```

全部 `.volatile()`（rc.1 Loader 传活引用，热更新不打断在途请求；需 scoped `@deepseek-ai/schemastery` ≥ 3.18.2）。热更新防打挂：照 zcode2api 的 `lastGood` 兜底——一次非法改动保留上一份可用配置。

---

## 11. 错误码映射

| 场景 | LlmError code | 说明 |
|---|---|---|
| 全池耗尽且 mode=failover-then-fail | `RATE_LIMIT` | 附 status=429 事实 |
| 所有账号凭据不可用（登录失败且无手动 key） | `MISSING_CREDENTIAL` | 指向设置页/凭据中心 |
| key 全部 401/403 且重抓失败 | `INVALID_CREDENTIAL` | 触发重抓的路径已先行 |
| 模型 404/403（目录外或不在 Token Plan） | `NO_ADAPTER` / 透传 status | 目录维护责任，不做静默降级 |
| 流中途断 | 终止 chunk（error/aborted） | 不重放，防重复输出 |

---

## 12. 实施里程碑与 P0 验证

**P0 接口验证（✅ 2026-10-02 完成，脚本归档 `test/probe/`）**

| # | 验证项 | 结果 |
|---|---|---|
| 1 | function calling（tools） | ✅ `finish_reason:'tool_calls'` + 正确参数（deepseek-v4-flash，非流式） |
| 2 | SSE 流格式 | ✅ `delta.content` + `delta.reasoning_content` 双通道；`data:[DONE]`；`include_usage:true` 时有独立 usage 块 |
| 3 | 视觉真实理解 | ✅ 左红右蓝图 32×32：flash-lite 与 kimi-k3 均正确回答（此前空 content 系 max_tokens 被 reasoning 耗尽） |
| 4 | usage 结构 | ✅ `prompt_tokens_details.cached_tokens` + `completion_tokens_details.reasoning_tokens` |
| 5 | 各模型 contextWindow | ⏳ 未测——目录按保守值配置，`models` 可覆盖 |

**里程碑**

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M0 | P0 验证 | ✅ 已完成（2026-10-02，结果见上表）；仅退避参数随日常观察回填 |
| M1 | MVP provider：静态账号（兼容导入 keys.json 式配置），单账号 adapter，SSE→StreamChunk，usage/cacheReadTokens 正确 | ✅ 已完成（2026-10-02）：31 单测全绿；真 key 实链路验证通过（文本流式 + 工具调用，reasoning/usage 块正确）；已接入 web profile（cordis.patch.yml 追加 insert 行，备份 `.bak-sensenova`），重启 dsh 生效；现网 pi-ai 的 sensenova-1/2 provider 与其并存互不影响 |
| M2 | 调度器：多账号轮换、单账号串行排队、429 换号、key 失效重抓、钉连与会话粘性、余量评分（pool-usage 按需缓存） | ✅ 已完成（2026-10-02）：粘性/余量/冷却切换/同账号串行单测覆盖；实战验证——双账号同时 429 时进入冷却+wait-until-available 等待循环，约 1 分钟后自动恢复完成回复；日志落插件目录 logs/dsh-sensenova.log |
| M3 | 凭据链路：jose 登录（按需）、apiKeys 抓取、凭据中心读写、pool-usage 按需拉取 + `/status` | ✅ 代码与联动完成（2026-10-02）：真实登录实测通过（JWT 3h + key 枚举）；零配置端到端验证通过（仅用户名/密码的账号在请求时自动登录抓 key，`SENSENOVA_ACC2_KEY/JWT` 成功写入凭据中心，长值写入无碍）；`/status` 状态页归 M4 |
| M4 | 客户端：设置页账号管理（用户名/密码/key 表单直填，凭据中心可选）+ 池状态页（手绘 SVG，对齐 usage-statistics-panel 风格） | ✅ 后端管理面完成（2026-10-02）：`GET /api/dsh-sensenova/status`（账号池快照+余量+日志尾部）、`POST …/refresh-usage`（实测返回真实池数据）、`POST …/refetch-key`（实测触发真实登录）、`GET …/log?tail=N`；宿主实测通过。✅ 客户端状态卡完成（2026-10-02）：手写 `window.__ModuleLoader__` 客户端模块（免构建链，raw jsx-runtime），注册 `plugins.bundle.config` / `plugins.row.config` 两个 slot；插件详情页渲染账号池状态表（key 健康/冷却/通用池余量/最近 429）+ 刷新余量与重抓 key 按钮，实测按钮可用（ACC2 余量实时显示 57,727/60,000）；插件以 `dsh plugin --profile web add` 装为 profile 依赖（link: 软链至工作区） |
| M5 | 打磨：visionDescribe 逃生舱、对账展示、`node --test` 单测（照 quilt-compact test/ 结构）、README | `npm run check` 全绿 |

测试基建照 `dsh-quilt-compact`：`node --test` + smoke（patch 挂载、双注册防护、client 渲染）；调度器注入假 client 做确定性单测（429 序列、冷却、粘性、mode A/B 终局）。

---

## 13. 风险与开放问题

1. **登录流程脆弱性**：依赖逆向的 OAuth 链路（JWKS kid、CSRF 域、JS 跳转解析），平台改版即断。缓解：auth_login.py 已稳定运行；诊断日志照搬；手动 key 路径永远可用（设置页直填）。
2. **凭据中心写放大**：`KEY`（~50 字符）与 `JWT`（~1–2KB）由插件写入 `.credentials.yaml`，需确认 `credentials.set` 对较长值与写入频次无异议（free-search 只写过短 key）。M3 首验。
3. **模型/限流随时变**：deepseek-flash 容量饱和即是先例——目录不做硬编码假设，`models` 可配置覆盖。
4. **JWT refresh_token 未验证**：统一重登；按需登录策略下最多 3h 一次/账号，可接受。
5. **`rateLimitMode` 退避参数**：500ms×2ⁿ 封顶 8s 为经验值，随日常使用观察回填（§5.4 清单）。
