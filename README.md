# dsh-sensenova

SenseNova Token Plan 账号池 provider，用于 DeepSeek Harness（dsh）插件体系：多账号调度、前缀缓存亲和、按需凭据抓取。

- provider id：`sensenova-token-plans`，显示名 **SenseNova Token Plans**
- 端点：`https://token.sensenova.cn/v1`（OpenAI 兼容）

## 核心能力

- **模型目录**：运行期从 `/v1/models` 发现（名称/上下文/输出上限/输入模态均取自 API），API 不可用时降级为内置 4 模型目录；设置页可勾选「启用」的模型，也可手动指定「图像模型」。
- **调度**：多账号轮换 + **单账号串行**（账号级 `SerialGate`）、**限流桶按 账号×模型** 记账与冷却、429 归因（TPM 冷却 / 服务繁忙固定同账号重试 / 未知换号）、会话粘性保前缀缓存。每账号一条 keep-alive 钉连（`maxSockets:1`）保缓存命中。测试见 `sensenova-ratelimit-report/`。
- **凭据**：账号在设置页维护（用户名/密码落凭据中心 `SENSENOVA_<LABEL>_*` refs，保存即登录抓 key）；按需登录（OAuth2+PKCE → JWT → apiKeys），写回凭据中心，失效自动重抓。**无后台定时器。**
- **余量**：打开设置页（`GET /status`）时惰性刷新积分池余量，缓存为空或过期才拉取。
- **管理面**：7 条 HTTP 路由（状态/刷新余量/重抓 key/模型目录/保存配置/账号管理/日志）+ 插件详情页状态卡片。

## 安装

```bash
dsh plugin --profile web add github:bvbhu/dsh-sensenova
dsh plugin --profile desktop add github:bvbhu/dsh-sensenova
```

## 更新

```bash
dsh plugin --profile web update dsh-sensenova
dsh plugin --profile desktop update dsh-sensenova
```

## 开发

```bash
npm install
npm test           # node --test "test/unit/*.test.js"
npm run smoke      # 补丁冒烟（mock ctx，不发起网络请求）
```

> 在受限沙箱下运行单测需加 `--test-isolation=none`：
> `node --test --test-isolation=none "test/unit/*.test.js"`。

探针脚本（需真实 key，手工运行）：`node test/probe/real-link.mjs`、`node test/probe/real-login.mjs`。

## 配置要点

- 账号清单**只**来自凭据中心注册表 `SENSENOVA_ACCOUNTS`（设置页「账号管理」维护）；
- 关键项：`enabledModels`（留空 = 全部启用）、`imageModels`、`rateLimitMode`（`wait-until-available` 默认）、`retryIntervalMs`（默认 5s）、`accountCooldownMs`（默认 60s）、`usagePollSeconds`。
- 无并发配置项（tpm限制下无意义）。

## 兼容性

- 宿主接口：`@deepseek-ai/dsh-llm` 0.1.7-rc.1 / 0.1.7-rc.2 / 0.2.0-rc.1 / 0.2.0-rc.2
  实测同契约（运行时 `index.js` 自 rc.2 起完全一致，rc.1→rc.2 变更为纯新增）；
  peer 范围 `^0.1.7-rc.1 || >=0.2.0-rc.1`
- `@deepseek-ai/cordis`：peer `^4.0.4`
- `offloadedImageText` 缺失时自动降级为通用占位文本（`images.js`）
