# SenseNova Token Plan 限流与前缀缓存测试报告（简要版）

- 测试日期：2026-10-01 ~ 10-02（round 1 限流精测 + round 2 全模型普查）
- 端点：`https://token.sensenova.cn/v1/chat/completions`（OpenAI 兼容）
- 实测数据：`data/results-round1.jsonl`、`data/results-round2.jsonl`（仅本地，不入库）

## 一、测试结论

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

- 429 报文恒为 `inference exceeds tpm/rpm limit`，掩护 RPM 超限 / TPM 超限 / 5h 积分池耗尽三种原因；无 `retry-after`、无 `x-ratelimit-*` 头，客户端只能计时退避。
- **限流桶 = 账号**：同账号多 key 合并计算，多 key 不能扩容；跨账号完全独立，多账号可横向扩容。
- 限流窗口约 1 分钟滚动计数，429 后立即重试常能成功；突发并发 ≤5 安全。
- **命中 prompt cache 的 tokens 不计 TPM**；服务端 `usage.prompt_tokens` 与本地 tokenizer 偏差 <5%（中文 ≈2 字符/token），载荷不可按字符数换算。

### 3. 前缀缓存

- 缓存按前缀存于推理节点本地，**对所有账号/key 可见**（跨账号命中稳定复现）。
- 命中取决于路由：单条 keep-alive 连接（maxSockets=1）顺序请求稳定命中（6/6）；默认连接池约 50%。
- 粒度按 1024-token 块对齐（多为 80–93% 部分命中）；TTL 10–15 分钟；新前缀头 1–2 轮必 miss。

## 二、复现方法

**准备**：`scripts/keys.json`（明文，唯一 key 来源，命名 `acc<N>key<M>`，**不入库**）；载荷文本 `data/text-pool.txt`（约 300 万字符，公开来源已脱敏，脚本按字符偏移切片）。

**账号配额**：每账号通用池 60,000 积分/5h + 600,000/7d；flash-lite 另有 60,000/5h 专属池。

```bash
cd scripts
node step0-models.mjs                                # 模型清单 + 响应头检查
node rpm-tpm-harness.mjs                             # 全模型：预检→RPM→TPM→跨账号复核（~1h）
node key-share-tpm.mjs                               # 同账号跨 key TPM 共享验证
node cache-experiments.mjs repeat|affinity|incremental [offset]   # 缓存三模式
node cache-cross-account.mjs warm|conv [offset]      # 跨账号缓存
node build-text-pool.mjs                             # 可选：重建文本池（组成与现有池不同）
```

## 三、局限

1. 429 边界按 60s 滚动窗口近似，数值视为 ±10% 区间；TPM 为下界或窄区间。
2. 缓存命中是概率行为，重跑结果会不同；但大模式（亲和↑命中、跨账号可见、1024 块对齐、TTL 10–15 分钟）多组对照稳定复现。
3. flash-lite 的 5h 专属池耗尽与分钟限流同报文、不可区分，测试前先看控制台余量。
4. 结论有效期为 2026-10 免费公测政策，平台调整后需重测。
