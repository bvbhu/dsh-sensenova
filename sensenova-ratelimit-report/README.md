# SenseNova Token Plan（token.sensenova.cn）限流与前缀缓存测试报告

- 测试日期：2026-10-01 ~ 10-02（round 1 + round 2）
- 端点：`https://token.sensenova.cn/v1/chat/completions`（OpenAI 兼容）
- 原始数据：`data/results-round1.jsonl`（round 1，限流四阶段）、`data/results-round2.jsonl`（round 2，全部模型）

## 一、结论速览

### 模型可用性与限额（round 1 精测 + round 2 全模型普查）

| 模型 | RPM | TPM | 可用性判定 |
|---|---|---|---|
| sensenova-6.8-flash-lite | ≥10 | 分钟级 ≥48k；但**专属积分池 60k/5h 先到先卡** | 可用，吞吐最优 |
| deepseek-v4-flash | ≈8–10 | ≈50k（round1）；round2 未触限（≥15k） | 可用 |
| glm-5.2 | ≈8–9 | ≈30–35k（round1）；round2 未触限（≥15k） | 可用 |
| kimi-k3 | ≈8–10 | ≥15k（round2 未触限） | 可用 |
| deepseek-v4-pro | 突发频繁 429（6 中 3） | ≥10k（round2 未触限） | 可用但更紧 |
| deepseek-flash | 反复请求仍 3/4 以上 429 | 无法测 | **可用性差，不可测试/不可用** |
| sensenova-u1-fast | — | — | **不可用**（404 model is not found） |
| deepseek-v4.1-flash | — | — | **不可用**（403 not available in current token plan） |
| sensenova-u1.5-lite / u1.5-fast | 未测（按要求排除） | | |

### 限流机制（两轮一致）

1. **429 报文恒为 `inference exceeds tpm/rpm limit`，掩护三种不同原因**：分钟 RPM 超限、分钟 TPM 超限、**5 小时积分池耗尽**。报文无 `retry-after`、无任何 `x-ratelimit-*` 头，客户端无法区分原因，只能按节奏退避。
2. **限流桶 = 账号，不按 key**：同账号不同 key 合并计算（acc3key1 打挂 → acc3key2 立即 429）；跨账号完全独立（一个账号 429 后另一账号同秒可用，flash-lite/glm/deepseek-v4-flash 三个模型上复核）。多 key 不能扩容，多账号可以。
3. 突发并发：空窗口 8 连发拒 ~3 个，≤5 并发安全 → `maxConcurrent ≤ 4`。
4. 限流窗口约 1 分钟，滚动计数；429 后立即重试常能成功。
5. **命中 prompt cache 的 tokens 不计 TPM**（已实测确认）。
6. token 口径：服务端 `usage.prompt_tokens` 与本地 DeepSeek V4 tokenizer 偏差 <5%。文本密度差异巨大：现代中文对话 ≈2 字符/token，技术混合文本 ≈2 字符/token，繁体文言 ≈1.06 字符/token——**载荷绝不能按字符数换算 tokens**。

### 前缀缓存（`usage.prompt_tokens_details.cached_tokens`）

- 缓存按前缀存于**各推理节点本地**，对**所有账号/key 可见**（跨账号命中 3 组实验稳定复现）；不是账号私有资源。
- 命中与否取决于请求路由到哪个节点：单条 keep-alive 连接（maxSockets=1）稳定命中（6/6）；默认 fetch 连接池随机/交替命中（~50%）。亲和大幅提高命中但不构成 100% 保证。
- 命中粒度按 **1024-token 块**对齐，多为部分命中（80–93%）；条目 TTL **10–15 分钟**；未命中请求全额计 TPM；新前缀头 1–2 轮必 miss。
- 跨账号交替多轮对话（3 组一致）：头 2 轮 miss → 第 3 轮起命中率 ~5/6，两账号都能命中。**交替账号 = 限额翻倍且缓存照常工作**。

## 二、环境与账号

key 统一存放在 `scripts/keys.json`（**唯一来源**，明文，勿提交/外传），命名 `acc<N>key<M>`——`acc<N>` 前缀标识账号（同账号 key 共享限流桶）：

| key 名 | 账号 | 说明 |
|---|---|---|
| acc1key1 | hubuv | 通用池 + flash-lite 专属池 |
| acc2key1 | huvhub | 通用池 |
| acc3key1 / acc3key2 | 第三账号 | 同账号两 key（共享桶，实验用） |

环境变量 `SENSENOVA_KEY_<别名>`（如 `SENSENOVA_KEY_ACC3KEY1`）可临时覆盖文件值。
每账号配额：通用池 60,000 积分/5h + 600,000/7d；flash-lite 另有专属池 60,000/5h。

## 三、载荷文本

`data/text-pool.txt`（约 300 万字符）：现代中文白话 + 中文技术混合（含代码块，PyTorch 中文文档/CS-Notes/d2l-zh 等，Apache-2.0/MIT/CC-BY）+ 英文（技术书单、Gutenberg 公版文学）。全部公开/开放授权来源，已脱敏扫描。测试脚本按字符偏移切片，唯一计数前缀破坏缓存共享（缓存实验除外）。

## 四、复现步骤

```bash
cd scripts
# key 准备：编辑 keys.json（acc<N>key<M> 格式）
node step0-models.mjs                                # 模型清单 + 响应头检查
node rpm-tpm-harness.mjs                             # 全模型：预检→RPM→TPM→跨账号复核（~1h，15-25万 tokens）
node key-share-tpm.mjs                               # 同账号跨 key TPM 共享（~3万 tokens）
node cache-experiments.mjs repeat|affinity|incremental [offset]   # 缓存三模式
node cache-cross-account.mjs warm|conv [offset]      # 跨账号缓存
node build-text-pool.mjs                             # 可选：重建文本池（Gutenberg+MDN 组成，
                                                     #   会覆盖 data/text-pool.txt，注意与现有池组成不同）
```

## 五、局限

1. 429 边界按"请求发起时刻的 60s 滚动窗口"近似；数值视为 ±10% 区间。TPM 为下界或窄区间（预算受限，ramp 载荷 3×~5k tokens）。
2. 缓存命中是概率行为，重跑结果会不同；但大模式（亲和↑命中、跨账号可见、1024 块对齐、TTL 10–15 分钟）多组对照稳定复现。
3. **flash-lite 的 5h 专属池耗尽后与分钟限流不可区分**（同报文）——测试 flash-lite 前先看控制台积分池余量。
4. `deepseek-flash` 反复请求仍大部分 429（容量饱和），判定为可用性差；其余 404/403 模型为平台侧不可用。结论有效期为 2026-10 免费公测政策，平台调整后需重测。
