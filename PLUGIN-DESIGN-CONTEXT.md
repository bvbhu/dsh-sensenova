# 上下文交接：设计「商汤 SenseNova 统一请求」dsh 插件

> 用途：在新的 ZCode 对话中设计一个 dsh 插件，统一管理对 `https://token.sensenova.cn/v1`（OpenAI 兼容）的请求。
> 本文档汇总了 2026-10-01/02 两轮实测得出的全部关键事实，可直接作为设计输入。
> 详细测试记录与可复现脚本：`D:\projects\temp\sensenova-ratelimit-report\`。

## 背景环境

- dsh（DeepSeek Harness）插件体系：cordis 4.x，插件通过 `ctx.llm` 接入供应商；已有插件 `dsh-quilt-compact`（压缩后端，D:\projects\dsh-quilt-compact）走同样的 `ctx.llm.providerRetryPolicy(provider)` 重试机制。
- 现有 3 个 sensenova 账号（Token Plan 免费公测）：acc1（hubuv）、acc2（huvhub）、acc3（第三账号，2 个 key）。key 存放于 `D:\projects\temp\sensenova-ratelimit-report\scripts\keys.json`（命名 `acc<N>key<M>`，前缀标识账号）。
- 积分模型：每账号每 5 小时 60,000 积分（通用池）+ flash-lite 专属池 60,000/5h，7 天池 600,000。

## 实测核心事实（设计约束）

### 1. 限流（HTTP 429，报文恒为 `inference exceeds tpm/rpm limit`）

| 模型 | RPM | TPM | 备注 |
|---|---|---|---|
| sensenova-6.8-flash-lite | ≥10 | 分钟级 ≥48k | 专属池，吞吐最优；429 恒为分钟级限流（**测试期间积分池从未耗尽**，池耗尽时的报错形态未实测） |
| deepseek-v4-flash | ≈8–10 | ≈50k | 通用池 |
| glm-5.2 | ≈8–9 | ≈30–35k | 通用池 |
| kimi-k3 | ≈8–10 | ≥15k（未触限） | 通用池，round2 确认可用 |
| deepseek-v4-pro | 突发 429 频繁（约半数） | ≥10k（未触限） | 可用但更紧 |
| deepseek-flash | 反复请求仍多数 429 | — | **容量饱和，不可用** |
| sensenova-u1-fast | — | — | **404 model not found，不可用** |
| deepseek-v4.1-flash | — | — | **403 不在 token plan 内，不可用** |

- **限流桶 = 账号**：同账号多 key 合并计算（已实验证实）；跨账号完全独立（k1 打挂后 k2 同秒可用）。→ 插件要横向扩容必须轮换**账号**，多 key 无用。
- 429 不带 `retry-after`、无任何 `x-ratelimit-*` 头 → 只能客户端计时退避。窗口约 1 分钟，429 后立即重试常能成功。
- 突发并发：空窗口 8 连发会拒 ~3 个，≤5 并发安全 → `maxConcurrent ≤ 4`。

### 2. 前缀缓存（TPM 豁免的关键杠杆）

- `usage.prompt_tokens_details.cached_tokens` 返回命中量；**命中的 tokens 不计 TPM**——这是在低 TPM 下做长上下文对话的唯一可行方式。
- 缓存按前缀存于**推理节点本地**，全账号可见（跨账号可命中）；命中与否取决于请求路由到哪个节点：
  - 单条 keep-alive 连接（`https.Agent{keepAlive:true, maxSockets:1}`）顺序请求 → 稳定命中（实测 6/6）；
  - 默认 fetch 连接池（socket 轮换）→ 交替/随机命中（~50%）。
- 命中块按 1024 tokens 对齐、多为部分命中（80–93%）；条目 TTL 10–15 分钟；未命中请求全额计 TPM。
- 增量多轮对话（前缀递增）：头 1–2 轮必 miss（冷启动），之后命中率 ~5/6。

### 3. 其他

- 服务端 `prompt_tokens` 与 DeepSeek V4 本地 tokenizer 偏差 <5%（中文 ≈2 字符/token）。
- 模型清单（GET /v1/models，9 个）：deepseek-v4-flash, glm-5.2, sensenova-u1-fast, sensenova-6.8-flash-lite, sensenova-u1.5-lite, deepseek-v4-pro, kimi-k3, deepseek-flash, deepseek-v4.1-flash（u1.5 系未测）。

## 对插件设计的直接建议（实测驱动）

1. **多账号轮换是扩容的唯一手段**：按 `acc<N>` 分组轮换 key 组；同组 key 换了也白换。
2. **每账号内保持连接亲和**：每个账号固定一条 keep-alive 连接（maxSockets=1），顺序请求以保住前缀缓存；账号与连接一一绑定，不要混用连接池。
3. **缓存感知调度**：读 `cached_tokens`；miss 时退避或重发一次，而不是连续堆请求（未命中也烧 TPM）；同一会话的连续轮次应走同一账号同一连接（保前缀温度）。
4. **并发 ≤4/账号**；超出的请求排队而不是并发打出。
5. **429 处理**：指数退避（500ms 起），与 dsh 的 `providerRetryPolicy` 机制对齐；同一分钟窗口内 429 后可立即小请求试探。
6. **模型池建议**：flash-lite 做主力（专属池独立计额）；glm-5.2 / kimi-k3 / deepseek-v4-flash 做第二梯队；deepseek-v4-pro 更紧；deepseek-flash / u1-fast / v4.1-flash 不可用，排除。
7. 长对话冷启动：新前缀头 1–2 轮 miss 全额计 TPM，可小上下文起步或预热请求。
8. 429 时先降速再换账号：分钟窗口约 1 分钟即恢复。**测试期间积分池从未耗尽**——"池耗尽也报同样 429"只是未实测的推断，插件不能靠报文区分两者，必须读 pool-usage 的 `remaining`/`reset_at` 主动规避（余量不足的账号不参与调度，等 reset_at 恢复）。

## 可复用的测试资产

- `scripts/lib.mjs`：key 加载（acc<N>key<M>）、`chat()`、`makePinnedCaller()`（keep-alive 钉连调用器——插件连接管理的参考实现）。
- `scripts/rpm-tpm-harness.mjs`：可用性预检 + RPM/TPM 探测框架（账号分摊预算）。
- `scripts/cache-cross-account.mjs`：跨账号交替对话缓存验证。
