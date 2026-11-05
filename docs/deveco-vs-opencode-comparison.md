# DevEco Code vs OpenCode：免费模型通道对比分析

> 分析对象：`temp/deveco-code-develop`（DevEco Code v0.2.5 源码快照）、`temp/opencode-dev`（OpenCode V2 v2.2.5 源码）
> 上游背景：`docs/opencode-free-models-to-dsh.md`（OpenCode 免费模型如何引流进 DSH）
> 生成时间：2026-11-02
> 锚点约定：`文件:行号` 相对各自仓库根；标注「实测」者为本次真实请求验证，标注「推断」者为基于代码的推论。
>
> ⚠️ **史料说明**：本文的 `temp/...` 锚点指向当时的上游源码快照（DevEco Code v0.2.5 / OpenCode V2 v2.2.5），
> 这些快照已在仓库整理时移除。锚点保留作历史出处记录，如需复核请按版本号重新获取对应上游源码。
> 本文的结论与实机验证数据不依赖快照存续。

---

## 0. 结论先行：一句话说清本质差异

| | OpenCode | DevEco Code |
| --- | --- | --- |
| **免费模型的准入逻辑** | **没有凭据 → 自动给免费档** | **必须有凭据（华为账号）→ 才给免费档** |
| **凭据是什么** | 字面量字符串 `"public"`（写在源码里） | 华为账号 OAuth 换来的 Bearer token |
| **服务端校验什么** | 你**像不像** OpenCode 客户端 | 你**是不是**合法且实名的中国大陆华为账号 |
| **免费怎么定义** | 价格 = 0（客户端自己判） | 服务端目录 + `blacklist`（客户端无判定权） |
| **失败时的形态** | HTTP 状态码 | HTTP **200** + 错误藏在 SSE 里 |

**最关键的一句**：OpenCode 的"免费"是**匿名公开通道**（谁都能用，靠客户端特征识别）；DevEco 的"免费"是**账号权益**（必须是登录 + 实名 + 中国大陆的华为用户）。

这是两种完全不同的商业模式，也因此决定了第三方插件能不能做、能怎么做。

---

## 1. 认证对比总表（本报告核心）

| 维度 | OpenCode（Zen 免费档） | DevEco Code（内置通道） |
| --- | --- | --- |
| **是否需要登录** | ❌ 不需要 | ✅ **强制**，且必须实名 |
| **凭据内容** | 字面量 `"public"` | JWT + accessToken（Bearer） |
| **凭据来源** | 源码常量 `provider.ts:396` | 浏览器 OAuth 换取 |
| **用户操作** | 无 | 打开浏览器 → 华为账号登录 → 实名 → 签协议 |
| **凭据有效期** | 无限（公开常量） | accessToken **30 分钟**，JWT **30 天** |
| **刷新机制** | 无需刷新 | `GET jwToken/check` + 头 `refresh:true` |
| **存储方式** | SQLite 明文 JSON 列 | **双层 AES-256-GCM** 加密文件 |
| **存储位置** | `<data>/opencode.db` 的 `credential` 表 | `<data>/auth.json` + `<config>/token.enc` |
| **服务端门禁** | 客户端特征（session 形状 / UA / body 工具） | 身份 + 地区 + 实名 + 协议 |
| **违规返回** | `403 FreeTierError` | `451` / `403` / `401` |
| **配额限制** | 按**出口 IP** 限流（`429 FreeUsageLimitError`） | 按**账号**限流（README 明示 50 次/分钟） |
| **可否多账号轮换** | 无账号概念，只能换 IP | 有账号概念，可换账号（但违反协议） |
| **合规定位** | 官方开放给所有 OpenCode 用户 | 华为账号权益，限中国大陆 |

---

## 2. 认证机制逐层拆解

### 2.1 OpenCode：**"无凭据即免费"的反向逻辑**

这是最容易误解的一点。OpenCode 的免费档不是"申请来的"，而是**"没凭据时自动降级到的默认档"**：

```ts
// temp/opencode-dev/packages/core/src/plugin/provider/opencode.ts:388-399
const hasKey = Boolean(process.env.OPENCODE_API_KEY || snapshot.connection || item.provider.settings?.apiKey)
providers.update(item.provider.id, (provider) => {
  if (!hasKey && !disableFree) {
    provider.activation = "enabled"
    provider.settings = { ...provider.settings, apiKey: "public" }   // ← 凭空塞一个假 key
  }
})
```

逻辑链条：

```
用户没有任何 OpenCode 凭据
   └─► hasKey === false
        └─► 强制激活 provider，塞入 apiKey = "public"
             └─► 发请求时 Authorization: Bearer public
```

**"public" 不是密钥，是一个档位标记。** 上游认这个字面量，并把它路由到免费池。

反过来，一旦用户有了真凭据：

```ts
// 同文件 :403-413
if (hasKey) return
for (const model of models.list(item.provider.id)) {
  if (!model.cost.some((cost) => cost.input > 0)) continue
  models.update(item.provider.id, model.id, (draft) => { draft.enabled = false })  // 付费模型禁用
}
```

即：**有凭据时反而只放免费模型出来**（付费模型需要用户显式订阅）。这个分支方向容易被忽略。

### 2.2 OpenCode 的"真正的门"：客户端特征，不是凭据

既然凭据是公开常量，上游靠什么防止滥用？靠**识别你是不是官方客户端**。三道门（均为实测/实测记录佐证）：

**门 1 —— 会话 ID 形状**

```ts
// temp/opencode2dsh-master/packages/plugin/src/adapter/ids.ts:73
const CANONICAL_SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
```

注释记录了攻防时间线：**2026-09-16 起，非规范 session 一律 `403 FreeTierError`（"free tier can only be used from within OpenCode"）**——纯伪装 UA 已经失效。

**门 2 —— body 必须有 agent 形状**

```ts
// temp/opencode2dsh-master/packages/plugin/src/adapter/messages.ts:299
export const FREE_LANE_GATE_TOOL_NAMES = ['bash', 'read'] as const
```

注释：免费档要求 body 流式、且 `tools` 里同时存在 `bash` 与 `read` 两个函数工具，否则 403。

**门 3 —— 配额（按 IP）**

实测撞墙返回：

```json
HTTP 429
{ "error": { "type": "FreeUsageLimitError",
  "message": "Free usage limit reached. Free models work in OpenCode (https://opencode.ai);
              subscribe to OpenCode Go to keep going" } }
```

注意这句话本身就是官方立场的声明：**免费模型是"在 OpenCode 里用"的权益**。

### 2.3 DevEco：**"有凭据才免费"的正向逻辑**

DevEco 的 provider 注册分支明确要求 OAuth：

```ts
// temp/deveco-code-develop/packages/opencode/src/provider/provider.ts:849-860
deveco: Effect.fnUntraced(function* () {
  const auth = yield* dep.auth("deveco")
  if (!auth || auth.type !== "oauth") return { autoload: false }     // ← 没有 OAuth 就不加载
  return { autoload: true, options: { apiKey: auth.access } }
}),
```

启动时的注入分支（`:1424-1447`）：

```ts
const devecoAuth = yield* auth.get("deveco")...
if (devecoAuth?.type === "oauth" && !cfg.disabled_providers?.includes("deveco") && ...) {
  const useBuiltIn = cfg.model?.startsWith("deveco/") || (!cfg.model && !otherCredentials && !otherConfig && !otherEnv)
  ...
  const accessToken = cached ? undefined : useBuiltIn
    ? yield* Effect.promise(() => ensureValidToken())
    : devecoAuth.expires > Date.now() ? devecoAuth.access : undefined
```

**和 OpenCode 恰好相反**：OpenCode 是"没凭据 → 给免费档"；DevEco 是"有凭据 → 才给免费档"。

### 2.4 DevEco 的认证链路（四步换证）

```
① 拉起浏览器
   https://cn.devecostudio.huawei.com/console/DevEcoIDE/apply
     ?port=<本地端口>&appid=1008&code=<CSRF nonce>
   （temp/deveco-code-develop/packages/opencode/src/plugin/deveco/login-service.ts:195-236）

② 本机回调收 tempToken
   监听 127.0.0.1:10101（备选 34567-34570），路径 /callback
   校验 code === nonce；siteId 必须为 "1"（否则 UnsupportedRegionError）
   （local-auth-server.ts:30、:60、:200）

③ tempToken → JWT
   GET {base}/authrouter/auth/api/temptoken/check
     ?tempToken=<t>&site=CN&version=1.0.0&appid=1008
   响应体就是 JWT 明文（须 3 段）
   （login-service.ts:258-284）

④ JWT → accessToken
   GET {base}/authrouter/auth/api/jwToken/check
     header: jwtToken=<JWT>, refresh: "false"
   返回 {status, userInfo:{accessToken, refreshToken, nationalCode, realName}}
   （login-service.ts:312-333）

⑤ 准入断言
   nationalCode 必须 === "CN"（login-service.ts:468-475）
   realName 必须 === true（access.ts:22-23）
```

参数全部固化在 `plugin/deveco/types.ts:91-101`：

| 常量 | 值 |
| --- | --- |
| `baseUrl` | `https://cn.devecostudio.huawei.com` |
| `authUrl` | `console/DevEcoIDE/apply` |
| `tempTokenCheckUrl` | `authrouter/auth/api/temptoken/check` |
| `jwtTokenCheckUrl` | `authrouter/auth/api/jwToken/check` |
| `appId` | `1008` |
| `defaultPort` | `10101` |
| `timeout` | `600000`（10 分钟） |

### 2.5 DevEco 的刷新：一个 GET，不需要 refresh token

```ts
// temp/deveco-code-develop/packages/opencode/src/plugin/deveco/login-service.ts:382-422
async refreshToken(jwtToken: string) {
  const url = `${this.config.baseUrl}/${this.config.jwtTokenCheckUrl}`
  const headers = { refresh: "true", jwtToken }        // ← 全靠这两个头
  const response = await this.requestAuth(url, { headers })
  ...
  return { accessToken, refreshToken, isRealName }
}
```

**这是 DevEco 侧一个非常关键的简化**：刷新不需要 refresh token（实测 `auth.json` 里 `refresh` 字段解出来是空字符串），只需要长期 JWT。

刷新调度（`token-refresh.ts:68-105`）：

- accessToken 未过期 → 直接返回（`:81-84`）
- 过期 → 单飞刷新（模块级 `refreshPromise` 去重，`:91-100`）
- 刷新失败 → 30 秒冷却（`REFRESH_COOLDOWN_MS`，`:14`、`:86-89`）
- 刷新成功 → 写回磁盘，`expires = now + ACCESS_TOKEN_EXPIRES_MS`（`:32`）

`ACCESS_TOKEN_EXPIRES_MS = 30 * 60 * 1000`（`types.ts:84`）。

### 2.6 存储：明文 vs 双层加密（差异极大）

**OpenCode —— 不加密**：

```ts
// temp/opencode-dev/packages/core/src/credential/sql.ts
export const CredentialTable = sqliteTable("credential", {
  id: text().$type<Credential.ID>().primaryKey(),
  integration_id: text(),
  label: text().notNull(),
  value: text({ mode: "json" }).$type<Credential.Value>().notNull(),   // ← JSON 明文列
  connector_id: text(),
  method_id: text(),
  active: integer({ mode: "boolean" }),
  ...Timestamps,
})
```

全仓 grep `createCipheriv` / `aes-256` / `LocalCrypto` / `safeStorage` 在 `packages/core`、`packages/util`、`packages/schema` 中**零命中**——OpenCode 的凭据是**明文落在 SQLite 里**（数据库文件本身仅靠 `chmod 0600` 保护，见 `database.ts:86-93`）。

**DevEco —— 双层 AES-256-GCM**：

| 层 | 内容 | 位置 |
| --- | --- | --- |
| KEK（密钥加密密钥） | 3 个 32 字节随机密钥，`kek-v1/v2/v3` | `<config>/keys/kek-*.bin`（0600） |
| DEK（数据加密密钥） | 被 KEK 包裹 | `<config>/token.dek`（`WrappedDekData`） |
| 密文 | 逐字段加密的敏感值 | `<data>/auth.json` |

```ts
// temp/deveco-code-develop/packages/opencode/src/security/local-crypto.ts:25
const SENSITIVE_AUTH_KEYS = new Set(["access", "refresh", "key", "token"])
```

- 只加密敏感字段，`type` / `expires` / `isRealName` 保持明文（`:154-162`、`:180-196`）；
- 每次写盘 `tmp` + `rename` 原子替换、`mode 0o600`（`storage.ts:44-47`）；
- 带 `expectedAccess` CAS 校验，防止并发刷新互相覆盖（`storage.ts:28-33`）。

> **实践含义**：OpenCode 的凭据（如果有）可被同机任何进程直接读取；DevEco 的 token 即使被读到文件，没有 `<config>/keys/` 也解不开。这也解释了为什么 DevEco 的凭据能"安全地被其他进程复用"——密钥和密文分在不同目录。

### 2.7 服务端门禁：谁在真正拦你

**OpenCode** 的门在**协议层**：

| 门 | 判据 | 失败码 |
| --- | --- | --- |
| 客户端特征 | session 形状 + UA + body 含 `bash`/`read` | `403 FreeTierError` |
| 配额 | 出口 IP 维度 | `429 FreeUsageLimitError` |
| 付费模型 | 凭据不是真 key | `401 AuthError: Missing API key`（实测） |

**DevEco** 的门在**身份层**，而且是客户端先自查、服务端再复核：

```ts
// temp/deveco-code-develop/packages/opencode/src/plugin/deveco/access.ts:12-25
export async function requireDevEcoAccess(_config?: AgreementConfig) {
  const region = await regionPolicy.checkAccess()               // ① 时区地区
  if (!region.allowed) throw new Error(MAINLAND_CHINA_ONLY_MESSAGE)
  const identity = await requireIdentity()                      // ② token + userId
  await requireRealName(JSON.stringify([identity.userId, identity.token]))   // ③ 实名
  await requireCurrentAccount(identity.userId)                  // ④ 账号未被切换
  await requireAgreements()                                     // ⑤ 产品协议
  const current = await requireCurrentAccount(identity.userId)  // ⑥ 再确认（防并发登出）
  if (loadIsRealNameFromDisk() !== true) throw new Error("Complete HUAWEI real-name authentication...")
  return current
}
```

对应的 HTTP 拒绝（在 OAuth `fetch` 包装器里，`auth-plugin.ts`）：

| 场景 | 状态码 | 位置 |
| --- | --- | --- |
| 时区属于欧洲区 | **451** `Unavailable For Legal Reasons` | `:50-57` |
| 未实名 / 协议未签 / 账号变更 | **403** | `:58-63` |
| 非 OAuth（拿 API key 冒充） | **401** | `:78-80` |
| token 刷新失败 | **401** | `:99-106` |

**注意 `auth-plugin.ts:78-80` 这条**：DevEco 明确拒绝"用 API key 冒充内置通道"，而 OpenCode 恰恰相反——它**主动塞假 key**。这是两种认证哲学最尖锐的对立点。

### 2.8 地区判定：只看时区（客户端自查，很弱）

```ts
// temp/deveco-code-develop/packages/opencode/src/plugin/deveco/region-policy.ts:113-135
function isEuropeanTimezone(timezone: string): boolean {
  return timezone.startsWith("Europe/") || EUROPEAN_TIMEZONES.has(timezone)
}
public async checkAccess(): Promise<RegionAccessResult> {
  const timezone = this.getTimezone()   // Intl.DateTimeFormat().resolvedOptions().timeZone
  if (timezone && isEuropeanTimezone(timezone)) return { allowed: false, reason: "timezone" }
  return { allowed: true }
}
```

- **只查时区，无 IP 校验、无服务端回传地区**；
- 账号真实国别由 `nationalCode === "CN"` 把关（`login-service.ts:468-475`）——这才是硬门；
- 时区检查更多是"产品合规姿态"，实际强度很弱（改时区即可绕过），真正的约束在账号国别。

---

## 3. "免费模型"的定义方式：价格标签 vs 服务端名单

### 3.1 OpenCode：客户端按价格判

```jsonc
// models.dev 快照中 big-pickle
"cost": { "text": { "input": {"price": 0}, "output": {"price": 0} } }
```

- 上游**不给** `is_free` 字段，只给价格；
- 客户端（或插件）按 `cost.input === 0 && cost.output === 0` 判定；
- 名称含 `free` 只是**元数据缺失时的兜底**（`catalog.ts:37`、`:73`）。

实测 `/zen/v1/models` 返回 78 个模型，其中 **8 个** `cost == 0`：

```
big-pickle (ctx 200k) / beam-free (1M) / flint-40b-free (262k) /
mimo-v2.6-flash-free / nemotron-3.5-super-vl-free (1M) /
nemotron-3.5-lightning-free / deepseek-v4.1-flash-free / glm-5.3-flash-free
```

其中 `big-pickle` **id 不含 "free"**——证明纯名字匹配会漏。

### 3.2 DevEco：服务端说了算，客户端无判定权

DevEco 把**所有**内置模型的价格硬编码为 0，根本不做免费/付费区分：

```ts
// temp/deveco-code-develop/packages/opencode/src/plugin/deveco-models.ts:44
cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
```

暴露哪些模型由服务端目录的 `blacklist` 决定：

```ts
// deveco-models.ts:158-169
export const CLOUD_EXCLUDED_KEY = ["black", "list"].join("")   // 键名拼出来，避免源码扫描命中
function parseExcludedIds(map) {
  const raw = map?.[CLOUD_EXCLUDED_KEY]
  return raw ? raw.split(",").map(s => s.trim()).filter(Boolean) : []
}
```

实测 `GET /codeGenie/modelConfig` 返回 3 个模型，`task_default_model_map`：

```json
{ "ui_verification": "Qwen3_VL_235B_A22B_Instruct",
  "blacklist":       "Qwen3_VL_235B_A22B_Instruct",
  "small_model":     "GLM-5.3" }
```

**被 blacklist 的模型仍留在 catalog 里**（`excluded: true`），只在投影成 provider 时丢弃：

```ts
// deveco-models.ts:309-334  catalogToProvider
for (const group of catalog.groups) {
  for (const entry of group.models) {
    if (entry.excluded) continue      // ← 这里才丢
    ...
```

所以 `deveco models` 只显示 2 个（GLM-5.1 / GLM-5.3），但 API 原始响应里有 3 个。

### 3.3 对比小结

| | OpenCode | DevEco |
| --- | --- | --- |
| 谁定义"免费" | **客户端**（价格判据） | **服务端**（目录 + blacklist） |
| 免费范围是否可枚举 | 是（实时 `/v1/models`） | 是（`modelConfig`） |
| 是否需要价格元数据 | **必需**（models.dev） | 不需要（全部 cost 0） |
| 名称启发式 | 有（兜底） | 无 |
| 客户端能否"自行发现"新免费模型 | 能（S1 实时刷新） | 能（但受 blacklist 约束） |

---

## 4. 目录获取：三源合并 vs 单源

| | OpenCode | DevEco |
| --- | --- | --- |
| 主源 | `GET {zen}/v1/models`（实测 200，78 个模型） | `GET /codeGenie/modelConfig`（实测 200，3 个模型） |
| 元数据源 | `https://models.dev/api.json`（8.2 MB 快照 + 24h 刷新） | **无** |
| 兜底 | 编译期静态 id 表（7 条） | **无兜底**（失败返回 `null`） |
| 缓存 | `agent-config.json.models.dev.json`，7 天失效 | `<cache>/deveco-models-<sha256(jwt)>.json` |
| 鉴权 | `Bearer public` | `Bearer <accessToken>` |
| 失败行为 | 三级回退 | 直接 null（`deveco-models.ts:385-388`、`:402-405`） |

DevEco 的目录端点：

```ts
// temp/deveco-code-develop/packages/opencode/src/plugin/deveco-models.ts:347
const API_ENDPOINT = `${DEVECO_BASE_URL}/codeGenie/modelConfig?localVersion=0&pluginVersion=CLI.${InstallationVersion}`
```

注意 `pluginVersion=CLI.<version>` —— **目录请求本身就带客户端版本号**，这也是"像不像官方客户端"的一环。

---

## 5. 请求构造对比

### 5.1 端点与路径

| | OpenCode | DevEco |
| --- | --- | --- |
| Base | `https://opencode.ai/zen`（+ `inference/openai/v1`） | `https://cn.devecostudio.huawei.com/sse/codeGenie/maas/v2` |
| 流式路径 | `/v1/chat/completions` | `/chat/completions` |
| 非流式路径 | 同一路径 + `stream:false` | **必须改路径** `/no-stream/chat/completions` |

DevEco 的路径改写（`auth-plugin.ts:139-161`）有个易踩的细节：

```ts
if (body?.stream !== true) {        // ← stream 缺失也算非流式
  url.pathname = url.pathname.replace(/\/chat\/completions$/, "/no-stream/chat/completions")
}
```

**`stream` 字段缺失（而非显式 `false`）也会被改写**——第三方实现如果只判 `=== false` 就会踩坑。

### 5.2 请求头

| OpenCode（7 个伪装头） | DevEco（身份头 + 会话头） |
| --- | --- |
| `user-agent: opencode/1.18.31 (...)` | `User-Agent: deveco/<version>` |
| `x-opencode-client: cli` | `x-deveco-client: cli` |
| `x-opencode-session: ses_...` | `x-deveco-session: <sessionID>` |
| `x-opencode-request: req_...` | `x-deveco-request: <user message id>` |
| `x-opencode-project: prj_...` | `x-deveco-project: <projectID>`（可选） |
| `x-session-affinity` / `X-Session-Id` | `Session-Id` |
| — | **`Chat-Id`（必填，缺失直接 400）** |
| — | `lang: en`（可选，实测不传也能通） |
| — | `authorization: Bearer <accessToken>` |
| `authorization: Bearer public` | — |

DevEco 的头注入位置：

- `auth-plugin.ts:126-137` —— `authorization` / `lang` / `Chat-Id` / `Session-Id`
- `session/llm/request.ts:186-194` —— `User-Agent` / `x-deveco-*`

`Chat-Id` 的生成规则（`auth-plugin.ts:132-137`）：优先取会话映射里的稳定值，否则 `randomUUID()` 去横线（32 位 hex）。

### 5.3 流格式

| | OpenCode | DevEco（实测） |
| --- | --- | --- |
| 帧前缀 | `data: {...}` | **`id: N` + `data: {...}`** |
| usage | 通常在末尾帧 | **每一帧都带 `usage`** |
| 结束 | `data: [DONE]` | `data: [DONE]` |
| model 回显 | 请求的 id | 内部名（`GLM5_1_W4A8_PD-1.0.0`） |
| 错误 | HTTP 状态码 + JSON | **HTTP 200 + SSE 内 `event: error`** |

---

## 6. 错误语义：这是移植时最大的坑

| 场景 | OpenCode | DevEco（实测） |
| --- | --- | --- |
| token 无效 | 401 + JSON | **HTTP 200** + 裸 JSON `{"errorCode":4016,"errorMsg":"invalid accessToken."}` |
| 缺必填头 | 400 + JSON | **HTTP 400** + `{"error":{"param":{"originalMessage":"SSE request missing header:Chat-Id"}}}` |
| 模型繁忙/排队 | 429 或队列错误 | **HTTP 200** + SSE `{"error":{"type":"WaitingInLine","code":"406"}}` |
| 非流式打错路径 | — | **HTTP 200** + SSE `{"error":{"param":{"originalMessage":"argument stream is false"}}}` |
| 非法 `reasoning_effort` | — | **HTTP 200** + SSE `403 ModelServiceError`（实测 `off` 非法） |
| 地区拒绝 | — | 451（客户端拦截，请求不发出） |
| 未实名/未签协议 | — | 403（客户端拦截） |

**核心差异**：OpenCode 用 HTTP 状态码表达失败；DevEco **几乎全部用 HTTP 200 + body 里的错误**。

后果：如果照搬 OpenCode 那套"看 `response.ok`"的逻辑，DevEco 的所有错误都会被当成成功，然后在流式解析中途炸掉，或更糟——**静默返回空内容**。

DevEco 自己的错误建模（供参考）：

| 类型 | 触发 | 位置 |
| --- | --- | --- |
| `QueueError` | 文案含 `排队` / `position N of queue` | `session/message-v2.ts:753-759`，固定 5 秒重试 |
| `ModelServiceRateLimitError` | 限流 | `packages/core/src/v1/session.ts:65-68`，3 次 10/20/30 秒 |
| `FreeUsageLimitError` | （OpenCode 侧）配额耗尽 | `to-session-error.ts:44` |

> 注：实测抓到的 `WaitingInLine` 字符串在 DevEco 源码中**检索不到**——代码侧对应物是 `QueueError` 的正则匹配。以实测报文为准。

---

## 7. 合规对比：这是"能不能做"的分水岭

### 7.1 OpenCode：官方默许的匿名通道

- 凭证是**公开常量** `"public"`，写在开源仓库里；
- 官方文案：**"Free models work in OpenCode"** —— 定位是"在 OpenCode 客户端里用"；
- 限流维度是**出口 IP**，无账号概念；
- 插件伪装成官方 CLI 属于**客户端同形请求**，不是伪造凭证。

**结论：可以做，但必须诚实标注"匿名配额受上游限流"，且不能做多 IP 轮换轰炸。**

### 7.2 DevEco：明确的账号权益 + 地区限制

四道闸全部写在代码里（§2.7）：

| 闸 | 判据 | 依据 |
| --- | --- | --- |
| 地区 | 时区非欧洲区 | `region-policy.ts:113-135` |
| 账号国别 | `nationalCode === "CN"` | `login-service.ts:468-475` |
| 实名 | `isRealName === true` | `access.ts:22-23` |
| 产品协议 | `product-agreement.json` version 1 | `deveco-product-agreement.ts:50-64` |

外加配额：README 明示 **"单账号默认每分钟 50 次请求"**（`README.md:152`），且客户端**无任何限流实现**——纯服务端约束。

协议号：`privacy_id=20000222`、`terms_id=10000351`（`deveco-legal.ts:16-18`）。

**结论：技术上可复用（无加密绑定、无客户端证书，就是普通 Bearer），但合规上不可自行其是。** 代码给不出许可结论——风险由复用方承担。

---

## 8. 对"做一个 DSH 插件"的实际含义

### 8.1 哪些能直接搬

| 模块 | 说明 |
| --- | --- |
| `events.ts` | pi-ai → DSH chunk 转译，**与上游无关，100% 可搬** |
| `messages.ts` 的 `toPiContext` | 消息转换层，可搬（删掉 bash/read 门） |
| `index.ts` 骨架 | `name` / `Config` / `inject=['llm']` / `registerAdapter` |
| `catalog.ts` 的状态机 | S1/S2/S3 降级为单源，但"启动重试 + 周期刷新 + 健康快照"结构保留 |
| 看门狗 | `firstEventMs` / `bodyIdleMs` 语义普适 |
| `config.ts` 的 volatile 设置语义 | 可搬 |

### 8.2 哪些必须重写

| 模块 | 原因 |
| --- | --- |
| **认证链路** | 从"塞 `public`"变成"读本地华为凭据 + 30 分钟刷新" |
| **请求头** | 换头集，且 `Chat-Id` 必填 |
| **错误识别** | 从"看状态码"变成"看 HTTP 200 里的 body/SSE" |
| **非流式路径** | 必须改写 `/no-stream/` |
| **目录** | 三源合并 → 单源 + blacklist |
| **免费判定** | 价格判据 → 全部暴露（无判定） |

### 8.3 认证部分的三种实现选择

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| **A. 复用本机凭据** | 读 `<data>/auth.json` + `<config>/keys/` + `token.dek` 解密，自己刷新 | 需要实现 LocalCrypto 双层解密；凭据随 `deveco` CLI 一起轮换，可能与 CLI 抢刷新 |
| **B. 自己走完整 OAuth** | 复刻浏览器 + 10101 回调 + 两次换证 + 三道闸 | 实现量大（约 800 行），但完全独立，不依赖已装的 CLI |
| **C. 转调 `deveco serve`** | 起 headless server，走它的 HTTP API | **它不是 OpenAI 兼容端点**（`packages/server/src` 无 `/v1/chat/completions`），需要自己写翻译层 |

**推荐 A**：本机已登录场景下成本最低。风险是"两个进程同时刷新 token"——DevEco 自己用 `expectedAccess` CAS + 30 秒冷却来防，插件侧需要对齐同样的策略（读 `expires`，过期才刷，刷新后写回）。

---

## 9. 一张表收尾

| 维度 | OpenCode（Zen 匿名） | DevEco Code（内置通道） |
| --- | --- | --- |
| 认证本质 | 公开字面量 `"public"` | 华为账号 OAuth + 实名 |
| 触发条件 | **无凭据** → 自动降级到免费档 | **有凭据** → 才启用内置通道 |
| 用户操作 | 零 | 浏览器登录 + 实名 + 签协议 |
| 凭据寿命 | 永久（常量） | access 30 min / JWT 30 day |
| 刷新 | 不需要 | `GET jwToken/check` + `refresh:true` |
| 存储加密 | ❌ 明文 SQLite | ✅ 双层 AES-256-GCM |
| 服务端识别 | 客户端特征（session 形状/UA/body 工具） | 账号身份 + 地区 + 实名 + 协议 |
| 免费定义 | 价格 = 0（客户端判） | 服务端 blacklist（客户端无判定权） |
| 目录 | `/v1/models` + models.dev + 静态表 | `/codeGenie/modelConfig` 单源 |
| 非流式 | 同路径 `stream:false` | 必须 `/no-stream/` |
| 错误表达 | HTTP 状态码 | **HTTP 200 + body/SSE 内错误** |
| 流帧 | `data:` | `id: N` + `data:`，每帧带 usage |
| 配额维度 | 出口 IP | 账号（50 req/min） |
| 合规 | 匿名，官方默许"在 OpenCode 里用" | 中国大陆 + 实名 + 协议，账号权益 |
| 第三方复用难度 | 低（抄常量 + 伪装头） | 中高（凭据链路 + 三道闸） |

---

## 附录：本报告引用的关键锚点

**OpenCode**（`temp/opencode-dev/`）

| 文件 | 关键位置 |
| --- | --- |
| `packages/core/src/plugin/provider/opencode.ts` | `apiKey:"public"` 注入 `:388-399`；付费模型禁用 `:403-413`；Console device OAuth `:106-160`、`:611-651` |
| `packages/core/src/credential/sql.ts` | `credential` 表结构（明文 JSON 列） |
| `packages/core/src/credential.ts` | 凭据服务接口 `:45-75` |
| `packages/core/src/session/to-session-error.ts` | `FreeUsageLimitError` → `provider.free-limit` `:44-45`；文案 `:28-29` |
| `packages/ai/src/provider-error.ts` | `QUOTA_CODES` 含 `freeusagelimiterror` `:90-97` |
| `packages/core/src/session/model-request.ts` | 请求头组装 `:290-303` |
| `packages/util/src/global.ts` | `app = "opencode"`，XDG 路径 |
| `packages/cli/src/database-path.ts` | `opencode.db` 解析 |

**DevEco Code**（`temp/deveco-code-develop/`）

| 文件 | 关键位置 |
| --- | --- |
| `packages/opencode/src/plugin/deveco/types.ts` | 登录常量 `:91-101`；`ACCESS_TOKEN_EXPIRES_MS` `:84` |
| `packages/opencode/src/plugin/deveco/login-service.ts` | 换 JWT `:258-284`；换 token `:312-333`；刷新 `:382-422`；国别校验 `:468-475` |
| `packages/opencode/src/plugin/deveco/local-auth-server.ts` | 端口 `:30`、监听 `:60`、`siteId` 校验 `:200` |
| `packages/opencode/src/plugin/deveco/auth-plugin.ts` | 451/403/401 `:50-63`、`:78-80`、`:99-106`；头注入 `:126-137`；路径改写 `:139-161` |
| `packages/opencode/src/plugin/deveco/access.ts` | 准入链 `:12-25`；实名节流 `:35-55` |
| `packages/opencode/src/plugin/deveco/token-refresh.ts` | 单飞 + 冷却 `:68-105`、`:14` |
| `packages/opencode/src/plugin/deveco/storage.ts` | 原子写 + CAS `:22-47`；读 access/realName `:54`、`:74` |
| `packages/opencode/src/plugin/deveco/region-policy.ts` | 时区判定 `:113-135` |
| `packages/opencode/src/security/local-crypto.ts` | 敏感键 `:25`；双层封装 `:65-98`；字段加解密 `:180-196` |
| `packages/opencode/src/plugin/deveco-models.ts` | 目录端点 `:347`；cost 全 0 `:44`；blacklist `:158-169`；投影丢排除 `:309-334`；缓存 `:410-411` |
| `packages/opencode/src/provider/provider.ts` | provider 注册 `:849-860`；启动注入 `:1424-1447`；懒加载 `:1905-1916` |
| `packages/opencode/src/session/llm/request.ts` | `x-deveco-*` 与 UA `:186-194`；`USER_AGENT` `:19` |
| `packages/opencode/src/session/exit-queue.ts` | 退出队列 `:42-56` |
| `packages/opencode/huawei-endpoints.json` | 全部华为端点 |
| `packages/core/src/database/database.ts` | `deveco.db` 命名 `:52-60` |
| `README.md` | 免费模型与 50 req/min 说明 `:150-154` |
