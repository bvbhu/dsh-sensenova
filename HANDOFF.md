# dsh-sensenova 交接文档

> 更新：2026-10-02。下一会话从这里继续。
> 设计全稿见 `DESIGN.md`（M0–M4 已全部实现）；实测背景见 `PLUGIN-DESIGN-CONTEXT.md`
> 与 `sensenova-ratelimit-report/`。本文只记录**现状、环境、坑位与下一任务**。

---

## 一、项目现状（M0–M4 全部完成 + 单账号串行改造完成，50/50 单测，真实宿主全链路实测通过）

| 里程碑 | 状态 | 说明 |
|---|---|---|
| M0 P0 验证 | ✅ | tools 可用（`finish_reason:'tool_calls'`）、SSE 双通道（content/reasoning_content）、视觉真实有效（flash-lite/kimi-k3 答对左红右蓝）、usage 含 cached/reasoning tokens |
| M1 provider | ✅ | `provider id = sensenova-token-plans`，显示名 **SenseNova Token Plans**，4 模型（deepseek-v4-flash 主力 1M 窗口 / flash-lite 256k 视觉 / kimi-k3 256k 视觉 / glm-5.2 1M） |
| M2 调度 | ✅ | 多账号轮换、**单账号串行**（账号级 `SerialGate`，忙账号排除出候选池、多余请求排队、abort 即取消）、429 冷却换号（60s）、全池耗尽 `wait-until-available`（指数退避 500ms→8s 封顶）、会话粘性（+1000 分）、余量软约束（pool-usage 按需缓存）、钉连保前缀缓存；无并发配置项（`maxConcurrentPerAccount` 已删） |
| M3 凭据 | ✅ | 按需登录（OAuth2+PKCE → JWT 3h → apiKeys 枚举取第一个 enabled），写回凭据中心；key 失效自动重抓（限频 10 分钟/账号）；**无任何后台定时器** |
| M4 管理面 | ✅ | 4 条 HTTP 路由 + 插件详情页状态卡（表格 + 刷新余量/重抓 key 按钮 + 日志尾部，30s 轮询） |

实战验证记录：双账号同时 429 → 冷却 + 等待循环 → 约 1 分钟自动恢复；零配置账号（只有用户名/密码）请求时自动登录抓 key → 回复正常 → `SENSENOVA_ACC2_KEY/JWT` 成功写入凭据中心。

---

## 二、环境与文件布局

```
工作区：D:\projects\dsh-sensenova
软链安装：~/.dsh/profiles/web/node_modules/dsh-sensenova → 工作区
         （dsh plugin --profile web add D:\projects\dsh-sensenova，pnpm link:）
```

- **profile patch**（`~/.dsh/profiles/web/cordis.patch.yml`，备份 `.bak-sensenova`）：
  尾部有 file:// 覆盖行 `- id: dsh-sensenova / name: 'file:///D:/projects/dsh-sensenova/lib/index.js?v=12'`
  ——覆盖 bundle 层的包名行，**改 lib/ 代码后 ?v=N+1 再重启宿主即生效**。
  同一行 `config.accounts` 携带账号（ACC1：key 手动；ACC2：仅用户名密码）。
- **bundle patch**（项目 `cordis.patch.yml`）：安装模式（`name: dsh-sensenova` 包名寻址）。
- **lib/ 模块**：
  - `index.js` 入口（Config/apply/热更新 lastGood/钩子与路由装配）
  - `adapter.js`（LlmAdapter 实现）· `wire.js`（dsh↔OpenAI 载荷，纯函数）
  - `client.js`（`https.request` 钉连传输 + SSE→StreamChunk 状态机）
  - `scheduler.js`（账号池调度 + `snapshot()`）· `credentials.js`（三轨解析 + 按需抓取）
  - `auth.js`（OAuth2+PKCE 登录，jose JWE + cookie jar + 手动重定向链）
  - `usage.js`（pool-usage 按需拉取 + 内存缓存）· `models.js`（模型目录）
  - `logger.js`（文件日志 `logs/dsh-sensenova.log`，5MB 轮转，tee 宿主 logger）
  - `routes.js`（管理路由）
- **client/client.js**：浏览器半区（手写 `window.__ModuleLoader__.load` 包装，raw jsx-runtime，免构建链），注册 `plugins.bundle.config` / `plugins.row.config` 两个 slot。
- **测试**：`node --test test/unit/*.test.js`（49 个）；探针 `test/probe/real-link.mjs`（真 key 全链路）、`real-login.mjs`（真登录）。
- **日志**：`D:\projects\dsh-sensenova\logs\dsh-sensenova.log`。
- **管理路由**：`GET /api/dsh-sensenova/status`、`POST …/refresh-usage`、`POST …/refetch-key`、`GET …/log?tail=N`。
- 测试实例启动：`dsh --profile web --port 0 --no-open`（URL/token 在对应 stdout 日志；每次重启端口会变）。

---

## 三、关键实测事实（浓缩；详见 PLUGIN-DESIGN-CONTEXT.md）

- 限流桶 = **账号**（同账号多 key 合并计）；429 恒为分钟级 TPM/RPM，无 retry-after；窗口约 1 分钟滚动。
- **TPM 限制下积分池不会耗尽**（持续用 deepseek-v4-flash 也如此，实测通用池 60k 只用 2.3k）；余量仅通过 pool-usage 按需判断。
- 前缀缓存命中不计 TPM：单条 keep-alive 连接（`maxSockets:1`）顺序请求稳定命中（6/6）；跨账号也可见。
- 平台接口：登录链 `platform.sensenova.cn/oauth2/auth`（必须此域发起，CSRF cookie 域随入口）→ `iam.sensecoreapi.cn/iam/authn/v1/auth/nova/login`（JWE 密码）→ `signin.sensecore.cn/oauth2/token`；`GET iam.sensecoreapi.cn/iam/idp/v1/apiKeys` 返回明文 `sk-`；`GET platform.sensenova.cn/lite/console/v1/tokenplan/pool-usage` 积分池。

---

## 四、设计决策与理由（新会话不要推翻）

1. **多账号轮换是扩容唯一手段**；同账号内换 key 无意义（共享限流），每账号只取第一个 enabled key（纯文本存 `SENSENOVA_ACC<N>_KEY`）。
2. **按需登录，无定时器**：只在 key 缺失（空池回合）或 key 失效（401/403）时登录；内部限频 ≥10 分钟/账号 + 并发去重（`ensureAccountKey`）。
3. **凭据中心 refs**：`SENSENOVA_ACC<N>_USERNAME / _PASSWORD / _KEY / _JWT`，全部纯文本；JWT 是可丢弃缓存（3h）。优先级 credentials > settings > env。
4. **429 终局** `wait-until-available`（默认）：宁等不失败；现网 pi-ai 的 5s 固定 × 1000 次重试是同思路的实证。
5. **图片不做默认预解析**：目录声明模态（`inputModalities`）路由分流；纯文本模型占位文本降级；`visionDescribe` 逃生舱默认关。
6. **除凭据外零持久化**、无后台轮询/预热（一切"额外请求"默认关闭——低 TPM 池里积分最贵）。
7. 模型目录不做硬编码假设（deepseek-flash 容量饱和、u1 系 404 已是先例），`models` 可配置覆盖。

---

## 五、已完成：取消单账号并发（2026-10-02）

**决策**：TPM 是首要瓶颈，账号内并发只会更快烧满分钟窗口引发 429；钉连顺序化 + 多账号轮换已提供吞吐，账号内并发有害无益 → **单账号串行**。

**落地**：
1. `lib/scheduler.js`：`Semaphore`/`acc.sem`/`acc.inFlight` 全部移除；新增账号级 `SerialGate`（单槽闸门，`acquire(signal)` 排队且 abort 即 reject）；`stream()` 把忙账号（`gate.busy`）排除出候选池，全池都忙时短睡重扫（busy ≠ 不可用）；评分只保留 粘性 > 余量 > 轮转。
2. `lib/index.js`：`Config.maxConcurrentPerAccount` 与 `resolveOptions` 对应项已删。
3. `client/client.js`：状态表用 `account.busy` 显示"忙/闲"（无独立"在途"列）。
4. 测试：`scheduler.test.js` 新增"同账号串行：并发请求不重叠、依次完成"（断言峰值并发 === 1）与"全部账号忙时等待重扫"；`scheduler-scoring.test.js` 删除遗留并发配置。
5. 文档：`DESIGN.md` §2.2/§3/§4.2/§5.1/§5.2/§6/§9 路由/§10 Config/§12 里程碑全部对齐"单账号串行"。
6. **验收**：`npm test` 50/50 全绿（含串行用例）；同账号并发请求被闸门串行化。

> 历史实测文档 `PLUGIN-DESIGN-CONTEXT.md` / `sensenova-ratelimit-report/` 中"并发 ≤4/账号"是**改造前的原始测量结论**，保留作记录，不再代表现行设计。

**无遗留 P0 任务**；后续可选打磨项见 `DESIGN.md` §12 M5（visionDescribe 逃生舱、对账展示、README）。

---

## 六、已知坑位（新会话必读，全部踩过）

1. **cordis 校验**：volatile 数组字段（accounts）内部不得再声明 `.volatile()` 子字段 → "invalid config: volatile fields require a fixed object path"。
2. **Node 全局 fetch 的 `dispatcher` 需要 undici Agent**，与 `node:https.Agent` 不兼容 → 推理传输必须用 `https.request`（限流报告 makePinnedCaller 模式）；控制台接口（登录/apiKeys/pool-usage）无钉连需求，用全局 fetch。
3. **schemastery 没有 `z.enum`**，枚举用 `z.union(['a','b'])`。
4. **凭据服务分层**（`dsh-credentials-local`）：`resolve()` 返回 `{value, source}`，顺序 = 进程环境 > `~/.dsh/.credentials.yaml` refs > .env；refs 是**明文**存储。`credentials.set` 对 ~1.7KB 的 JWT 长值写入无碍。
5. **schemastery 表单不渲染对象数组**（accounts）→ 自定义 client 卡片才是账号管理的正解；`credentials` 服务可能晚挂载，运行期 `ctx.get('credentials')` 动态取。
6. **客户端模块**：必须 `window.__ModuleLoader__.load({id, factory:(require)=>{...}})` 包装；client ctx 需要 `exports.inject = ["slots"]` 才能访问 `ctx.slots`；宿主提供 `require("react")` / `require("react/jsx-runtime")`。
7. **插件管理器 UI 的行名显示可能陈旧**（曾显示 ?v=5 而实际 v12）——以管理路由/日志判断实际运行版本。
8. **storageDomain**：`open()` 每进程一次且无 close——本项目现已零持久化，不碰它；若未来要持久化必须 globalThis 单例。
9. 插件 `logger.info` 不进宿主 stdout——统一走 `lib/logger.js` 文件日志查看。
10. `stream_options.include_usage:true` 必带；**reasoning tokens 计入 completion 预算**（实测 19–86+），maxTokens 过小会 `finish=length` 且 content 为空。

---

## 七、测试实例当前状态

- 最后一个测试实例：`dsh --profile web --port 0 --no-open`，端口 54934（宿主重启后端口会变，URL/token 在 `/tmp/dsh-web-test*.log`）。
- 用户浏览器曾打开 60831 端口实例。
- 用户 desktop 实例（DeepSeek Harness.exe）**不要动**；其重启后自动加载插件（profile patch 已就位）。
