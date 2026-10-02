# SenseNova Token Plan 限流与前缀缓存实测报告（简要版）

- 测试日期：2026-10-02（round 1 限流精测 + round 2 全模型普查）
- 端点：`https://token.sensenova.cn/v1`（`/chat/completions`、`/models`，OpenAI 兼容）
- 仓库内跟踪内容：**本 README + `scripts/`（8 个实测脚本 + 脱敏 `keys.json` 示例）**

## 一、仓库里有什么、没有什么

跟踪的部分即「可复现」的部分：脚本 + key 配置示例。

| 路径 | 是否入库 | 说明 |
|---|---|---|
| `README.md` | ✅ | 本文件（结论 + 复现步骤） |
| `scripts/*.mjs` | ✅ | 8 个实测脚本，见第三节 |
| `scripts/keys.json` | ✅ | **仅脱敏示例**（`sk-xxxx****xxxx`），展示格式，**不含真实密钥** |
| `data/` | ❌ | 实测输出（`results-round*.jsonl`、`text-pool.txt` 约 3.9MB）。体积大，且是生成/实测产物，故不入库，避免拖慢仓库下载 |

> `data/` 不入库不代表无法复现：语料由公开来源重建、结果由脚本重跑生成，步骤见第二节。

## 二、复现实测

### 1. 准备密钥（必须）

`scripts/keys.json` 入库的版本是**脱敏示例**，直接跑会失败。放入真实 key 即可（命名为 `acc<N>key<M>`，`acc<N>` 前缀标识账号）：

```json
{
  "acc1key1": "sk-真实key...",
  "acc3key1": "sk-真实key...",
  "acc3key2": "sk-真实key..."
}
```

也可用环境变量（优先级高于文件）：`SENSENOVA_KEY_<NAME>`，例如 `SENSENOVA_KEY_ACC1KEY1`。
**密钥不会被任何脚本打印。**

### 2. 准备语料（依赖 `data/text-pool.txt` 的脚本需要它）

`key-share-tpm.mjs`、`rpm-tpm-harness.mjs` 等按字符偏移从 `data/text-pool.txt` 切片构造载荷。该文件未入库，用公开来源重建：

```bash
cd scripts
node build-text-pool.mjs
#   → 生成 data/text-pool-gutenberg-mdn.txt（中文典籍 + MDN 中文技术文档 + 英文公版书，纯文本）
#   注意：脚本刻意不覆盖 data/text-pool.txt，需手动复制为目标名
cp data/text-pool-gutenberg-mdn.txt data/text-pool.txt     # Linux/macOS
#   Windows: copy data\text-pool-gutenberg-mdn.txt data\text-pool.txt
```

> 也可自备任意中文长文本放入 `data/text-pool.txt`；只要足够长即可（切片工厂按素数步长取不同偏移，用于打破前缀共享）。

### 3. 跑脚本

```bash
cd scripts
node step0-models.mjs                                          # 各 key 的 /v1/models + 限流响应头检查
node rpm-tpm-harness.mjs [resultsFile]                         # 全模型：预检→RPM→TPM→跨账号复核（约 1 小时）
node key-share-tpm.mjs                                         # 同账号跨 key 是否共享 TPM 桶（需 acc3key1/acc3key2）
node cache-experiments.mjs repeat|incremental|affinity [offset] # 前缀缓存三模式
node cache-cross-account.mjs warm|conv [offset]                 # 跨账号/跨 key 缓存可见性
```

结果写入 `data/*.jsonl`（本地，不入库）。

**账号配额参考**：每账号通用池 60,000 积分/5h + 600,000/7d；`sensenova-6.8-flash-lite` 另有 60,000/5h 专属池。

## 三、脚本清单

| 脚本 | 用途 |
|---|---|
| `lib.mjs` | 公共库：key 加载、`chat()`（默认连接池）、`makePinnedCaller()`（单连接 keep-alive 钉连，缓存稳定模式）、`makePayloadFactory()`（唯一前缀载荷）、JSONL 日志 |

## 四、测试结论

（源自 2026-10-02 实测；原始 `data/results-round*.jsonl` 未入库，可用上述脚本重跑验证。）

### 1. 模型可用性与限额

| 模型 | RPM | TPM | 判定 |
|---|---|---|---|
| sensenova-6.8-flash-lite | ≥10 | 分钟级 ≥48k | 可用，吞吐最优（另有 60k/5h 专属池先到先卡） |
| deepseek-v4-flash | ≈8–10 | ≈50k | 可用 |
| glm-5.2 | ≈8–9 | ≈30–35k | 可用 |
| kimi-k3 | ≈8–10 | ≥15k（未触限） | 可用 |
| deepseek-v4-pro | 突发 429 频繁 | ≥10k（未触限） | 可用但更紧 |
| deepseek-flash | 反复请求仍多数 429 | — | 容量饱和，不可用 |
| sensenova-u1-fast / deepseek-v4.1-flash | — | — | 404 / 403，平台侧不可用 |

### 2. 限流机制

- 429 报文恒为 `inference exceeds tpm/rpm limit`，掩护「RPM 超限 / TPM 超限 / 5h 积分池耗尽」三种原因；无 `retry-after`、无 `x-ratelimit-*` 头，客户端只能计时退避。
- **限流桶 = 账号**：同账号多 key 合并计算，多 key 不能扩容；跨账号完全独立，多账号可横向扩容（这是本插件账号池设计的依据）。
- 限流窗口约 1 分钟滚动计数，429 后立即重试常能成功；突发并发 ≤5 安全。
- **命中 prompt cache 的 tokens 不计 TPM**；服务端 `usage.prompt_tokens` 与本地 tokenizer 偏差 <5%（中文 ≈2 字符/token），载荷不可按字符数换算。

### 3. 前缀缓存

- 缓存按前缀存于推理节点本地，**对所有账号/key 可见**（跨账号命中稳定复现）。
- 命中取决于路由：单条 keep-alive 连接（`maxSockets=1`）顺序请求稳定命中（6/6）；默认连接池约 50%（这是插件为每个账号固定一条 pinned agent 的原因）。
- 粒度按 1024-token 块对齐（多为 80–93% 部分命中）；TTL 10–15 分钟；新前缀头 1–2 轮必 miss。

## 五、局限

1. 429 边界按 60s 滚动窗口近似，数值视为 ±10% 区间；TPM 为下界或窄区间。
2. 缓存命中是概率行为，重跑结果会不同；但大模式（亲和↑命中、跨账号可见、1024 块对齐、TTL 10–15 分钟）多组对照稳定复现。
3. flash-lite 的 5h 专属池耗尽与分钟限流同报文、不可区分，测试前先看控制台余量。
4. 重建语料（`build-text-pool.mjs`）依赖 Gutenberg 与 GitHub API 可访问性，网络受限时会部分降级（脚本已内置重试与跳过）。
