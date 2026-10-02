# SenseNova Token Plan 限流与前缀缓存实测报告

- 测试日期：2026-10-02
- 端点：`https://token.sensenova.cn/v1`（`/chat/completions`、`/models`，OpenAI 兼容）

## 一、结论

### 1. 模型可用性与限额

| 模型                     | RPM                | TPM             |
| ------------------------ | ------------------ | --------------- |
| sensenova-6.8-flash-lite | ≥10               | ≥48k           |
| deepseek-v4-flash        | ≈8–10            | ≈50k           |
| glm-5.2                  | ≈8–9             | ≈30–35k       |
| kimi-k3                  | ≈8–10            | ≥15k（未触限） |
| deepseek-flash           | 反复请求仍多数 429 | —              |

### 2. 限流机制

- 429 报文恒为 `inference exceeds tpm/rpm limit`，掩护「RPM 超限 / TPM 超限 」；无 `retry-after`、无 `x-ratelimit-*` 头，客户端只能计时退避。
- **限流桶 = 账号**：同账号多 key 合并计算，多 key 不能扩容；跨账号完全独立，多账号可横向扩容（账号池设计的依据）。
- 限流窗口约 1 分钟滚动计数，429 后立即重试常能成功；突发并发 ≤5 安全。
- **命中 prompt cache 的 tokens 不计 TPM**；服务端 `usage.prompt_tokens` 与本地 tokenizer 偏差 <5%（中文 ≈2 字符/token），载荷不可按字符数换算。

### 3. 前缀缓存

- 缓存按前缀存于推理节点本地，**对所有账号/key 可见**（跨账号命中稳定复现）。
- 命中取决于路由：单条 keep-alive 连接（`maxSockets=1`）顺序请求稳定命中（6/6）；默认连接池约 50%（每账号固定一条 pinned agent 的原因）。
- 粒度按 1024-token 块对齐（多为 80–93% 部分命中）；TTL 10–15 分钟；新前缀头 1–2 轮必 miss。

## 二、复现步骤

> `data/`（实测数据和输出，约 4MB）未入库以免拖慢下载：语料由公开来源重建、结果由脚本重跑生成，步骤如下。

### 1. 准备密钥（必须）

入库的 `scripts/keys.json` 是**脱敏示例**（`sk-xxxx****xxxx`），直接跑会失败。放入真实 key（命名 `acc<N>key<M>`，`acc<N>` 前缀标识账号）：

```json
{
  "acc1key1": "sk-真实key...",
  "acc3key1": "sk-真实key...",
  "acc3key2": "sk-真实key..."
}
```

或使用环境变量（优先级高于文件）：`SENSENOVA_KEY_<NAME>`，如 `SENSENOVA_KEY_ACC1KEY1`。**任何脚本都不打印密钥。**

### 2. 准备语料

依赖语料的脚本（`key-share-tpm.mjs`、`rpm-tpm-harness.mjs`）按字符偏移从 `data/text-pool.txt` 切片构造载荷。用公开来源重建：

```bash
cd scripts
node build-text-pool.mjs
#   → 生成 data/text-pool-gutenberg-mdn.txt（中文典籍 + MDN 中文技术文档 + 英文公版书）
#   脚本刻意不覆盖 data/text-pool.txt，需复制为目标名：
cp data/text-pool-gutenberg-mdn.txt data/text-pool.txt        # Linux/macOS
#   Windows: copy data\text-pool-gutenberg-mdn.txt data\text-pool.txt
```

也可自备长文本放入 `data/text-pool.txt`（切片工厂按素数步长取偏移，用于打破前缀共享）。

### 3. 运行脚本

| 脚本                                                           | 用途                                                                                                                   |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `step0-models.mjs`                                           | 各 key 的`/v1/models` + 限流响应头检查                                                                               |
| `rpm-tpm-harness.mjs [resultsFile]`                          | 全模型：预检→RPM→TPM→跨账号复核（约 1 小时）                                                                        |
| `key-share-tpm.mjs`                                          | 同账号跨 key 是否共享 TPM 桶（需`acc3key1`/`acc3key2`）                                                            |
| `cache-experiments.mjs repeat\|incremental\|affinity [offset]` | 前缀缓存三模式                                                                                                         |
| `cache-cross-account.mjs warm\|conv [offset]`                 | 跨账号/跨 key 缓存可见性                                                                                               |
| `cross-model-tpm.mjs [key别名] [模型A] [模型B] [--wait]`      | 同账号 A 模型打满 429 后立即调 B——判定限流桶按账号还是按 账号×模型（约 1 分钟，`--wait` 加窗口释放验证）                |
| `lib.mjs`                                                    | 公共库：key 加载、`chat()`（默认连接池）、`makePinnedCaller()`（单连接钉连）、`makePayloadFactory()`、JSONL 日志 |

```bash
cd scripts
node step0-models.mjs
node rpm-tpm-harness.mjs
node key-share-tpm.mjs
node cross-model-tpm.mjs
node cache-experiments.mjs repeat
node cache-cross-account.mjs warm
```

结果写入 `data/*.jsonl`

**账号配额参考**：每账号通用池 60,000 积分/5h + 600,000/7d；`sensenova-6.8-flash-lite` 另有专属池。

## 三、局限

1. 429 边界按 60s 滚动窗口近似，数值视为 ±10% 区间；TPM 为下界或窄区间。
2. 缓存命中是概率行为，重跑结果会不同；但大模式（亲和↑命中、跨账号可见、1024 块对齐、TTL 10–15 分钟）多组对照稳定复现。
3. flash-lite 的 5h 专属池耗尽与分钟限流同报文、不可区分，测试前先看控制台余量。
4. 重建语料依赖 Gutenberg 与 GitHub API 可访问性，网络受限时会部分降级（脚本内置重试与跳过）。
