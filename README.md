# dsh-sensenova

SenseNova Token Plan 账号池 provider，用于 DeepSeek Harness（dsh）插件体系：多账号调度、前缀缓存亲和、按需凭据抓取。

- provider id：`sensenova-token-plans`，显示名 **SenseNova Token Plans**
- 端点：`https://token.sensenova.cn/v1`（OpenAI 兼容）

## 核心能力

- **模型目录**：从 `/v1/models` API 拉取； 设置页可勾选「启用」的模型，可手动勾选「图像模型」。
- **调度**：多账号轮换 + 单账号串行（账号级 SerialGate）、429 冷却换号（60s）、全池耗尽等待（指数退避）、会话粘性保前缀缓存。测试见 `sensenova-ratelimit-report/`。
- **凭据**：账号在设置页维护（落凭据中心 `SENSENOVA_ACC<N>_*` refs，保存即登录抓 key）；按需登录（OAuth2+PKCE → JWT → apiKeys），写回凭据中心，失效自动重抓。
- **余量**：打开设置页（`GET /status`）时惰性刷新积分池余量，缓存为空或过期才拉取。

## 安装

```bash
dsh plugin --profile web add github:bvbhu/dsh-sensenova
dsh plugin --profile desktop add github:bvbhu/dsh-sensenova
```

## 更新

```bash
dsh plugin --profile web update github:bvbhu/dsh-sensenova
dsh plugin --profile desktop update github:bvbhu/dsh-sensenova
```

## 开发

```bash
npm install
npm test           # node --test "test/unit/*.test.js"
npm run smoke      # 补丁冒烟（mock ctx，不发起网络请求）
```

> 在受限沙箱（禁止子进程 spawn）下运行单测需加 `--test-isolation=none`：
> `node --test --test-isolation=none "test/unit/*.test.js"`。

## 兼容性

- 宿主接口：`@deepseek-ai/dsh-llm` 0.1.7-rc.1 / 0.1.7-rc.2 / 0.2.0-rc.1 / 0.2.0-rc.2
  实测同契约（运行时 `index.js` 自 rc.2 起完全一致，rc.1→rc.2 变更为纯新增）；
  peer 范围 `^0.1.7-rc.1 || >=0.2.0-rc.1`
- `@deepseek-ai/cordis`：peer `^4.0.4`
- `offloadedImageText` 缺失时自动降级为通用占位文本（`images.js`）
