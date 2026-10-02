# dsh-sensenova

SenseNova Token Plan 账号池 provider，用于 DeepSeek Harness（dsh）插件体系：多账号调度、前缀缓存亲和、按需凭据抓取。

- provider id：`sensenova-token-plans`，显示名 **SenseNova Token Plans**
- 模型：deepseek-v4-flash（1M）/ flash-lite（256k，视觉）/ kimi-k3（256k，视觉）/ glm-5.2（1M）
- 调度：多账号轮换 + 单账号串行（账号级 SerialGate）、429 冷却换号（60s）、全池耗尽等待（指数退避）、会话粘性保前缀缓存
- 凭据：按需登录（OAuth2+PKCE → JWT → apiKeys），写回凭据中心，key 失效自动重抓；无后台定时器、零持久化

## 仓库布局

```
lib/       插件主体（index 入口 / adapter / wire / client / scheduler / credentials / auth / usage / models / logger / routes）
client/    浏览器半区（插件详情页状态卡）
test/      unit（node --test）· smoke · probe（真实链路探针）
sensenova-ratelimit-report/   限流与前缀缓存实测报告（仅 README 与 data/text-pool.txt 入库）
```

## 使用

```bash
npm install        # 安装依赖
npm test           # 运行单元测试
npm run smoke      # 补丁冒烟
```

安装到 dsh：`dsh plugin --profile web add D:\projects\dsh-sensenova`。

> 账号配置经 `config.accounts`（用户名/密码，key 可缺省按需抓取）或凭据中心 `SENSENOVA_ACC<N>_*` refs。完整设计文档与交接记录为本地资料，不入库（见 `.workbuddy/docs/`，仅本地保留）。

## 兼容性

- 宿主接口：`@deepseek-ai/dsh-llm` 0.1.7-rc.1 / 0.1.7-rc.2 / 0.2.0-rc.1 / 0.2.0-rc.2 实测同契约（运行时 `index.js` 在 rc.2 起完全一致，rc.1→rc.2 变更均为纯新增）；peer 范围 `^0.1.7-rc.1 || >=0.2.0-rc.1`，未来 0.x/后续版本按语义化接受
- `@deepseek-ai/cordis`：peer `^4.0.4`（cordis 4.x 插件约定稳定）
- 单测 50/50 跑在 0.2.0-rc.2 上；`offloadedImageText` 缺失时自动降级为通用占位文本（images.js）

## 入库范围说明

- `sensenova-ratelimit-report/scripts/keys.json` 含明文 key，**永不入库**；
- 报告目录仅跟踪 `README.md` 与参考测试文本 `data/text-pool.txt`，其余实测数据与脚本仅存本地。
