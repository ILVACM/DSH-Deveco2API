# OpenCode 免费模型如何被"引流"进 DSH —— 技术分析报告

> 分析对象：`temp/opencode-dev`（OpenCode V2 上游源码，v2.2.5）、`temp/opencode2dsh-master`（DSH 插件，v0.3.7）、`temp/.scan`（前期扫描结论）
> 分析方法：静态通读 + 本机实机验证（DSH 0.2.1-rc.5 宿主、真实上游端点）
> 生成时间：2026-11-02
> 说明：`文件:行号` 锚点均相对各源码仓库根目录；标注「实测」者为本次真实请求验证结果，标注「推断」者为基于代码的合理推论。
> **配套报告**：[deveco-vs-opencode-comparison.md](./deveco-vs-opencode-comparison.md) —— DevEco Code 与 OpenCode 的逐项差异，重点讲「免费模型」的认证方式。本文只讲 OpenCode → DSH 一条链路，不涉及 DevEco 细节。
>
> ⚠️ **史料说明**：本文的 `temp/...` 锚点指向当时的上游源码快照（`OpenCode v2.2.5` / `opencode2dsh v0.3.7`），
> 这些快照已在仓库整理时移除。锚点保留作历史出处记录，如需复核请按锚点中的版本号重新获取对应上游源码。
> 本文的结论与实机验证数据不依赖快照存续。

---

## 0. 一页纸结论

OpenCode 的免费模型能被 DSH 用上，靠的是**三方共同作用**，缺一不可：

| 角色 | 提供什么 | 关键点 |
| --- | --- | --- |
| **OpenCode 上游** | 一个 OpenAI 兼容的推理端点 + 一个模型目录端点 | 匿名通道的凭据是**字面量 `public`**，不是密钥 |
| **models.dev 元数据** | 判断"哪些模型是免费的" | 上游不告诉你免费与否，只告诉你价格；**`cost == 0` 就是免费** |
| **DSH 插件（opencode2dsh）** | 把上面两件事翻译成 DSH 的 `LlmAdapter` 契约 | 伪装成 OpenCode CLI、把 pi-ai 事件转成 DSH chunk、把 HTTP 错误转成 finish reason |

一句话概括机制：

> **插件冒充 OpenCode 官方 CLI，用 `Bearer public` 这个公开匿名凭证去调 OpenCode 的推理端点，用 models.dev 的价格数据筛出免费模型，再把整条 SSE 流转译成 DSH 能懂的事件序列。**

这条链路**不需要注册、不需要 API Key、不需要任何用户账号**——这是它与 DevEco Code 通道最本质的区别（后者要求华为账号 + 实名 + 中国大陆）。

---

## 1. 背景：先搞清 OpenCode 与 DevEco Code 的关系

DevEco Code 官方 README 明示「本项目基于开源项目 OpenCode 扩展开发」，并保留 OpenCode 的「终端交互、配置体系、Provider / MCP / Skill / Plugin 等能力」。代码层面也能印证：

- DevEco 的包名仍是 `@opencode-ai/*`（`temp/deveco-code-develop/packages/opencode/package.json`），只是对外品牌改成 `deveco`；
- 大量常量保留 `OPENCODE_*` 语义，另有平行的 `DEVECO_*` 覆盖层；
- 目录结构、Effect 服务分层、`State`/`Location` 模型与 OpenCode V2 一致。

**因此理解 OpenCode 的"免费模型是怎么被接出来的"，就理解了 DevEco 同类机制的骨架。** 但两者在模型通道上**并非只有"凭证来源"和"端点"两处差异**——目录来源、免费判定、门禁形态、错误语义都不同，详见配套报告 [deveco-vs-opencode-comparison.md](./deveco-vs-opencode-comparison.md)。

本报告因此只按「上游 OpenCode → 下游 DSH 插件」一条线展开。

---

## 2. OpenCode 侧：免费模型是怎么"存在"的

### 2.1 免费不是"另一种模型"，而是"价格为 0 的模型"

OpenCode 的模型目录里没有 `is_free` 字段。免费与付费的唯一区分是**价格**：

```jsonc
// temp/opencode-dev/packages/core/src/models-dev/snapshot.txt 中 big-pickle 条目
"cost": { "text": {
  "input":  { "price": 0, "cache": { "read": 0, "write": 0 } },
  "output": { "price": 0 }
}}
```

对应地，OpenCode 自己的判定逻辑就是"有没有任何一个输入价格为 0 的计价项"：

```ts
// temp/opencode-dev/packages/core/src/plugin/provider/opencode.ts:403-413
const hasKey = Boolean(...)
if (hasKey) return
for (const model of models.list(item.provider.id)) {
  if (!model.cost.some((cost) => cost.input > 0)) continue   // ← 有任意非零输入价 = 付费
  models.update(item.provider.id, model.id, (draft) => {
    draft.enabled = false                                   // ← 付费模型直接禁用
  })
}
```

**这就是"免费模型"在 OpenCode 里的定义：`cost.input` 全为 0。** 插件侧完全复刻了这个语义（见 §3.3）。

### 2.2 匿名通道：`apiKey: "public"`

当用户**既没登录 Console 账号、也没配 `OPENCODE_API_KEY`、也没在设置里填 key**时，OpenCode 会把这个 provider 强行激活，并塞入一个假 key：

```ts
// temp/opencode-dev/packages/core/src/plugin/provider/opencode.ts:388-399
yield* ctx.provider.transform((providers) => {
  const item = providers.get(Provider.ID.opencode)
  if (!item) return
  const hasKey = Boolean(process.env.OPENCODE_API_KEY || snapshot.connection || item.provider.settings?.apiKey)
  providers.update(item.provider.id, (provider) => {
    if (!hasKey && !disableFree) {
      provider.activation = "enabled"
      provider.settings = { ...provider.settings, apiKey: "public" }   // ← 字面量 "public"
    }
  })
})
```

要点：

- `"public"` **不是密钥**，它是上游约定的"匿名档位"标记，会原样进 `Authorization: Bearer public`；
- 有逃生开关 `OPENCODE_DISABLE_FREE_MODELS`（`:177`、`model.ts:99`），说明这是**产品特性**而非灰色通道；
- 一旦用户有了真 key，这段逻辑不执行，且**付费模型才被放出来**（§2.1 的反向分支）。

### 2.3 模型目录从哪来：models.dev

OpenCode 的模型清单不是硬编码的，来自 **models.dev** 这份公共元数据（编译期打快照 + 运行期刷新）：

```ts
// temp/opencode-dev/packages/core/src/models-dev.ts:22
import snapshotText from "./models-dev/snapshot.txt" with { type: "text" }
```

- 快照约 **8.2 MB**，`opencode` provider 段含 **132 个模型条目**；
- 服务 `ModelsDev.Service` 负责加载、TTL 刷新、事件广播（`ModelsDev.Event.Refreshed`）；
- 插件 `ModelsDevPlugin`（`packages/core/src/plugin/models-dev.ts:33`）把每个 provider 的模型投影进 `ctx.provider.transform`，并**过滤掉 `deprecated` 与非文本模型**（`:86-110`）。

`opencode` provider 下每个模型都带一个 `api.chat-completions` 块，写明真正的推理端点：

```jsonc
"api": { "chat-completions": {
  "base_url": "https://opencode.ai/inference/openai/v1",
  "sdk": { "aisdk": "@ai-sdk/openai-compatible" },
  "compatibility": { "reasoning_field": "reasoning_content" }
}}
```

### 2.4 两代推理端点并存（实测）

上游现在同时存在两套路径，这点对移植很关键：

| 端点 | `/models` | `/chat/completions` | 用途 |
| --- | --- | --- | --- |
| `https://opencode.ai/zen/v1` | ✅ 200（实测 78 个模型） | ✅ 可推理 | **opencode2dsh 走这条**（旧/兼容路径） |
| `https://opencode.ai/inference/openai/v1` | ❌ 404（实测） | ✅ 可推理（实测 429，说明端点有效） | OpenCode V2 新客户端按快照 `base_url` 走这条 |
| `https://opencode.ai/inference/systemone/v1` | ❌ 404 | — | 只服务 System One 决策类请求（`packages/ai/src/providers/opencode.ts:8`） |

实测 `/zen/v1/models` 返回的每个模型自带 `api.chat-completions.base_url = https://opencode.ai/inference/openai/v1`——即**目录在 zen、推理在 inference**，两代并存。

### 2.5 会话关联头：CLI 的"身份证"

OpenCode 每次请求都会带一整套关联头，这是上游用来做**会话亲和、缓存命中、客户端识别**的依据：

```ts
// temp/opencode-dev/packages/core/src/session/model-request.ts:290-303
const affinity = SessionAffinity.get(session)
const base = ai.request({
  model: model.model,
  http: { headers: {
    "x-opencode-session-id": session.id,
    ...(session.parentID ? { "x-opencode-parent-session-id": session.parentID } : {}),
    "x-session-affinity": affinity,
    "X-Session-Id": affinity,
    ...(session.parentID ? { "x-parent-session-id": session.parentID } : {}),
    "User-Agent": App.useragent(app),
    "x-opencode-project": session.projectID,
    "x-opencode-session": affinity,
    "x-opencode-client": app.name,
  }},
  promptCacheKey: /^ses_[0-9a-f]{64}$/.test(affinity) ? affinity.slice(4) : affinity,
  ...
})
```

其中 `affinity` 的派生规则很关键——**子会话共享父会话的 affinity，fork 的会话共享 fork 源的**：

```ts
// temp/opencode-dev/packages/core/src/session/affinity.ts
export const get = (session: Pick<SessionSchema.Info, "id" | "parentID" | "fork">) =>
  session.parentID ?? session.fork?.sessionID ?? session.id
```

User-Agent 的构造：

```ts
// temp/opencode-dev/packages/core/src/app.ts
export function useragent(app: Info) {
  return `opencode/${app.channel}/${app.version}/${app.name}`
}
```

**这套头是上游识别"这是不是官方客户端"的主要依据**，也正是插件要伪造的对象。

### 2.6 上游的免费额度限制（实测）

匿名通道并非无限。实测在配额耗尽时返回：

```json
HTTP 429
{ "type": "error",
  "error": { "type": "FreeUsageLimitError",
    "message": "Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go" } }
```

注意措辞——**"Free models work in OpenCode"**：官方把免费模型定位为"在 OpenCode 客户端里使用"的权益。这既是技术事实，也是合规边界（详见 §7）。

---

## 3. DSH 侧：宿主要求插件交出什么

在讲插件之前，必须先钉死 DSH 的契约，否则看不懂插件为什么这样写。以下事实直接提取自本机安装的宿主包 `@deepseek-ai/dsh-llm@0.2.1-rc.5`（`app.asar` 内 `lib/index.js`），非二手转述。

### 3.1 `LlmAdapter` 是**结构契约**，不是基类继承

宿主只按方法名调用，不做 `instanceof` 校验。完整方法面是 **6 个 + 1 个隐含**：

| 方法 | 必要性 | 作用 |
| --- | --- | --- |
| `providerInfo(provider)` | **必需** | 返回 `{id, name}`；宿主校验 `id` 必须等于注册时的 provider 名、`name` 非空 |
| `providerRetryPolicy(provider)` | **必需**（可返回 `undefined`） | 宿主注册时**无条件调用**；返回 `undefined` = 用宿主默认策略 |
| `imageRequestPricing(provider, model)` | 建议 | `/compact` 等路径会调；须同步、无 IO |
| `imageRequestTarget(provider, model, image)` | 可选 | 默认透传图片尺寸 |
| `listModels(provider)` | 建议 | 模型选择器数据源；**advisory**，不参与请求校验 |
| `resolveModel(provider, model, signal)` | **必需** | 上下文窗口、输出上限、思考档位 |
| `prepareCall(provider, model, signal)` | **必需** | 返回 `{model, stream}`；`stream` 才是真正发请求的函数 |

宿主注册时的硬校验（实测自 `prepareRoutes`）：

```
provider 名非空；不得重复注册（DUPLICATE_ADAPTER）；
adapter.providerInfo(provider).id 必须 === provider，name 必须非空 —— 否则 INVALID_ADAPTER
```

**这意味着：`providerInfo` 或 `providerRetryPolicy` 写错，provider 会从选择器里静默消失**，而不是报错弹窗。这是移植时最容易踩的坑。

### 3.2 chunk 词汇表（流式协议）

适配器必须产出的 7 种事件，且**流必须以 `usage` → `finish` 收尾**：

```
block-start   { index, blockType: 'text' | 'reasoning' | 'tool-call' }
text-delta    { index, text }
reasoning-delta { index, text }
tool-call-delta { index, id, name?, argumentsDelta }
block-end     { index, block: {...} }
usage         { inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens? }
finish        { reason, replayState? }
```

`finish.reason` 5 种：`stop` / `max-tokens` / `tool-calls` / `aborted` / `error`（后两者带 `failure: {message, code}`）。

### 3.3 归属头（attribution）是硬要求

宿主注释明确：**每个 provider HTTP 请求都必须带 `attributionHeaders()`**。这对免费通道是个微妙点——插件要同时满足"归属 DSH"与"伪装 OpenCode CLI"，实践中是**用伪装 UA 覆盖归属 UA**（见 §4.4）。

---

## 4. opencode2dsh：把免费模型"引流"进 DSH 的六层机制

插件源码位于 `temp/opencode2dsh-master/packages/plugin/`。整体只有约 1200 行核心代码，分六层。

### 4.1 第 1 层：插件外壳（4 个导出）

```ts
// packages/plugin/src/index.ts
export const name = 'opencode2dsh'          // :62  —— cordis Loader 行 id，也是设置命名空间
export { Config } from './config.ts'        // :68  —— schemastery schema，DSH 据此生成设置页
export const inject = ['llm'] as const      // :80  —— 只声明 llm 一个硬依赖
export function apply(ctx, config) { ... }  // :81
```

`inject` 只写 `['llm']` 是有意为之：注释说明 DSH 0.1.7 的 `ctx.settings` 自身 inject `['configEditor','profileContext']`，在 headless 组合里被禁用；若在此声明，整个 fiber 永不激活，provider 路由一起消失。

`apply` 里最关键的一行，且**刻意排在最前**：

```ts
// packages/plugin/src/index.ts:150
ctx.llm.registerAdapter([PROVIDER_ID], adapter)
```

注释写明理由：「后续任何一层（IP 池装配、残留路由清理、目录刷新循环）抛错，都不能弄丢唯一的免费 provider」。

### 4.2 第 2 层：模型目录（S1 / S2 / S3 三源合并）

这是整个插件的"大脑"，位于 `packages/plugin/src/adapter/catalog.ts`。

```
S1  GET {zen}/v1/models          —— 实时在售全集（免费+付费）
S2  GET https://models.dev/api.json —— 价格元数据，判定谁免费
S3  编译期实测过的静态 id 表       —— 断网兜底
```

暴露面 = **S1 ∩ S2-allowed**；S1 还没就绪时用 S3 顶上。

**免费判定链**（`catalog.ts:73` `decide()`）：

```
元数据就绪？
├─ 否（pending / 该模型不在元数据里）→ 退回名称启发式：id 含 "free" 才算免费
└─ 是
   ├─ deprecated            → 拒
   ├─ input==0 && output==0 → 允（metadata_free / name_and_metadata_free）
   ├─ 价格字段缺失          → 拒（metadata_cost_unknown）
   └─ 否则                  → 拒（metadata_paid）
```

注意这里有一个**对上游实现的修正**：OpenCode 原版是先短路 `isFreeModel`（名字含 free 就直接放行），导致"已下架但仍在目录里"的 `deepseek-v4-flash-free` 永远暴露；插件把顺序改成"元数据裁决优先，名称只在元数据说不出话时兜底"。注释里写明了这个理由。

**名称启发式本身**（`catalog.ts:37`）：

```ts
export function isFreeModel(model: string): boolean {
  return model.toLowerCase().includes('free')
}
```

S1 的抓取还带伪装头（`catalog.ts:431` `fetchZenModels`）：

```ts
headers: {
  authorization: 'Bearer public',
  'user-agent': userAgent,
  'x-opencode-client': 'cli',
  accept: 'application/json',
}
```

**刷新与自愈**（`catalog.ts:235` `ModelCatalog`）：

- 启动立刻刷一轮；若 S1 为空，**每 15 秒重试一次、最多 4 次**（应对开机时 VPN/TUN 尚未就绪）；
- 之后按 `refreshSeconds`（默认 300 秒）周期刷新；
- S2 元数据 **24 小时**刷新一次，落盘缓存 `agent-config.json.models.dev.json`，缓存超过 **7 天**视为失效；
- 每轮刷新后写健康快照 `~/.opencode2dsh/adapter-status.json`（含 `status/total/exposed/lastError`）。

### 4.3 第 3 层：请求伪装（"我是官方 CLI"）

位于 `packages/plugin/src/adapter/ids.ts`。这是整套机制里**最脆弱也最关键**的一层。

**会话 ID 必须长成 OpenCode 的形状**：

```ts
// ids.ts:73
const CANONICAL_SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
```

注释记录了一次真实攻防：**2026-09-16 起，Zen 免费档开始拒绝非规范形状的 session（403 FreeTierError，"free tier can only be used from within OpenCode"）**——单纯伪装 User-Agent 已经不够了。所以插件把任意会话信号**确定性哈希**成规范形状：

```ts
// ids.ts:95
export function canonicalSessionID(signal: string): string {
  if (CANONICAL_SESSION_PATTERN.test(signal)) return signal   // 官方 id 直接放行（保留缓存亲和）
  const sum = createHash('sha256').update('ses\x00' + signal).digest()
  const timePart = sum.subarray(0, 6).toString('hex')          // 12 hex
  const randomPart = base62Fixed(BigInt('0x' + sum.subarray(6, 16).toString('hex')), 14)  // 14 base62
  return `ses_${timePart}${randomPart}`
}
```

会话信号取**首条 user 消息的内容**（`ids.ts:40` `conversationSeed`），这样多轮对话保持同一 session（利于上游 prompt cache），不同对话则天然分开。

**完整伪装头集**（`ids.ts:112`）：

```ts
{
  'user-agent': 'opencode/1.18.31 (<platform> <arch>; node<version>)',
  'x-opencode-client': 'cli',
  'x-opencode-session': ids.session,
  'x-session-affinity': ids.session,
  'X-Session-Id': ids.session,
  'x-opencode-request': ids.req,      // 每请求随机 req_<32hex>
  'x-opencode-project': ids.project,  // 由固定种子哈希出的 prj_<24hex>
}
```

**第二道门：body 形状**（`messages.ts:299`）。这是实机探测出的隐藏规则：

```ts
export const FREE_LANE_GATE_TOOL_NAMES = ['bash', 'read'] as const
```

注释原文：免费档会**拒绝不带"agent 形状"的 chat body**——除非 body 流式、且 `tools` 数组里同时有名为 `bash` 和 `read` 的函数工具，否则 403。所以插件在 `onPayload` 钩子里**动态补桩**：

```ts
// messages.ts:347 ensureFreeLaneShape
if (missing.length === 0) return undefined        // 已满足，不改
next.tools = [...tools, ...missing.map(freeLaneGateTool)]
if (tools.length === 0) next.tool_choice = 'none' // 没工具时禁掉调用，防模型乱调桩函数
```

> **这就是"引流"能成立的核心原因**：上游不是在验证密钥，而是在验证"你像不像 OpenCode 客户端在跑一个 agent"。插件把这两个特征都造了出来。

### 4.4 第 4 层：wire 层（复用 pi-ai，不自己写 SSE）

插件不手写 HTTP，而是复用 `@earendil-works/pi-ai`——**这正是 DSH 所有 OpenAI 兼容 provider 用的同一个实现**。

```ts
// packages/plugin/src/adapter/zen-adapter.ts:285-307
this.#provider = createProvider<Api>({
  id: PROVIDER_ID,
  name: PROVIDER_ID,
  baseUrl: `${ZEN_BASE_URL}/v1`,
  auth: { apiKey: { name: 'OpenCode Zen anonymous lane',
                    resolve: async () => ({ auth: { apiKey: 'public' } }) } },  // :131
  models: [],
  api: openaiCompletions,
})
```

关键收益：**流式解析、tool call 分片拼装、重试、超时全部免费获得**，插件只负责"给对 baseUrl / 给对头 / 给对 body"。

**双 provider 分流**（`routing.ts`）：`muse-spark-*` 系列只支持 Responses API，走 `openaiResponses`；其余走 `openaiCompletions`。

**每请求动态头**（`#eventsFor` 里）：

```ts
provider.streamSimple(model, context, {
  apiKey: 'public',
  sessionId,
  headers: disguiseHeaders(ids),   // ← 伪装头在这里注入，覆盖 pi-ai 自己的 UA
  onPayload: ensureFreeLaneShape,  // ← body 门在这里补齐
  signal, maxRetries: 0,           // ← 重试权交给 DSH
  ...
})
```

**流存活看门狗**（`zen-adapter.ts:144-153`）。这是长期实测踩出来的：pi-ai 与 fetch 都不管"响应头到了但 body 再也不吐字"的情况（实测有卡 70 分钟的记录），所以插件自己加两道超时：

```ts
DEFAULT_FIRST_EVENT_MS = 30_000    // 首个事件（连上但没内容）
DEFAULT_BODY_IDLE_MS   = 120_000   // 流中静默（普通 chat）
RESPONSES_BODY_IDLE_MS = 300_000   // Responses 模型静默下限（推理型流式呈突发节奏）
```

超时消息刻意带 `"timeout"` 字样，好让错误分类器归到 `transport`，从而触发换出口重试。

### 4.5 第 5 层：事件转译（pi-ai → DSH chunk）

`packages/plugin/src/adapter/events.ts:132` `toStreamChunks`，约 100 行，是**净室移植**（对齐 DSH 自带的 `dsh-llm-pi-ai` 实现）：

| pi-ai 事件 | DSH chunk |
| --- | --- |
| `text_start` / `text_delta` / `text_end` | `block-start(text)` / `text-delta` / `block-end(text)` |
| `thinking_*` | `block-start(reasoning)` / `reasoning-delta` / `block-end(reasoning)` |
| `toolcall_start` / `_delta` / `_end` | `block-start(tool-call)` / `tool-call-delta` / `block-end(tool-call)` |
| `done` / `error` | `usage` + `finish` |

**契约红线**：流若没收到 `done`/`error` 就结束，直接 `throw`（`events.ts:197`）——因为 DSH 侧要求流必须以 `usage`+`finish` 终止。

**错误分类**（`events.ts:63` `classifyError`），把上游五花八门的文案映射成稳定错误码：

```
RegionError / "not available in your country" → REGION_BLOCKED  ← 特意先于 AUTH，否则 DSH 会误报"API key 无效"
401 / 403                                     → AUTH
insufficient / quota / billing                → QUOTA_EXCEEDED
429 / rate limit                              → RATE_LIMIT
413 / payload too large                       → INVALID_REQUEST
5xx                                           → SERVER
timeout                                       → TIMEOUT
network / ECONN* / premature close            → TRANSPORT
```

**停止原因映射**（`events.ts:85` `mapStopReason`）还含一个细节：`stopReason === 'stop'` 但 `usage.input > contextWindow` 时，判为**上下文溢出**而非正常结束。

### 4.6 第 6 层：生命周期与可观测

```ts
// packages/plugin/src/index.ts
ctx.llm.registerAdapter([PROVIDER_ID], adapter)   // :150 先注册
try { applyIpPoolSettings(...) } catch { ... }    // :152 可选层，失败不影响路由
void catalog.start()                              // :166 后台预热
ctx.inject(['settings'], sctx => removeProviderRoute(...))  // :176 清理残留 sidecar 路由
maybeEffect(() => () => catalog.stop())           // :193 释放定时器
```

`registerAdapter` 本身由 dsh-llm 用 `ctx.effect` 自动注销，插件只需管自己的定时器。

---

## 5. 端到端时序（一次 DSH 对话）

```
DSH 会话
  │  GenerateOptions { provider:'opencode2dsh', model, messages, tools, ... }
  ▼
prepareCall()  ──►  resolveModel()  ──►  上下文窗口/输出上限/思考档位
  │
  ▼  stream(options)
toPiContext()          messages.ts:239   把 DSH 消息块转成 pi-ai Context
deriveRequestIDs()     ids.ts:53         从首条 user 消息派生 ses_/req_/prj_
toPiModel()                              组装 pi-ai Model（含 reasoning/limits）
  │
  ▼  streamSimple(model, context, { apiKey:'public', headers: disguiseHeaders(ids),
                                   onPayload: ensureFreeLaneShape })
pi-ai openai-completions
  │  POST https://opencode.ai/zen/v1/chat/completions
  │  Authorization: Bearer public
  │  user-agent: opencode/1.18.31 (win32 x64; node24)
  │  x-opencode-client: cli
  │  x-opencode-session / x-session-affinity / X-Session-Id: ses_<12hex><14base62>
  │  x-opencode-request: req_<32hex> ; x-opencode-project: prj_<24hex>
  │  body.tools 必含 bash + read（缺失则 onPayload 补桩，无工具时 tool_choice='none'）
  ▼
SSE 流（OpenAI chunk 格式）
  │
  ▼  pi-ai AssistantMessageEvent
toStreamChunks()       events.ts:132
  │
  ▼  DSH chunk 序列
block-start / text-delta / reasoning-delta / tool-call-delta / block-end
usage → finish(reason)
  ▼
DSH 渲染 + 下一轮工具调用
```

---

## 6. 实机验证记录（本次分析）

| 验证项 | 结果 |
| --- | --- |
| `GET https://opencode.ai/zen/v1/models` + `Bearer public` | ✅ **200**，返回 **78** 个模型，94 KB |
| 其中 `cost.input.price == 0 && cost.output.price == 0` | **8 个**：`big-pickle`、`beam-free`、`flint-40b-free`、`mimo-v2.6-flash-free`、`nemotron-3.5-super-vl-free`、`nemotron-3.5-lightning-free`、`deepseek-v4.1-flash-free`、`glm-5.3-flash-free` |
| 其余 70 个为付费 | ✅ 与"免费=价格为0"的判定一致 |
| `POST /zen/v1/chat/completions` + 完整伪装头 + 门工具 | ⚠️ **429 `FreeUsageLimitError`**（本机出口 IP 配额已耗尽，非通道失效） |
| `POST /inference/openai/v1/chat/completions` 同参数 | ⚠️ 同样 429，证明该端点有效、限制同源 |
| `GET /inference/openai/v1/models` | ❌ 404（目录只在 zen 侧） |
| 用 `Bearer public` 打**付费**模型 | ❌ **401 `AuthError: Missing API key`** —— 印证"匿名只开免费档" |
| DSH 宿主 `LlmAdapter` 方法面 / 注册校验 | ✅ 从 `app.asar` 的 `dsh-llm@0.2.1-rc.5` 提取确认（§3） |
| 本机已装 `@opencode2dsh/dsh-plugin@0.3.12` | ✅ 健康快照 `status: ready, total 85, exposed 9` |

> 值得单独说明：`big-pickle` 的 id **不含 "free"**，但价格是 0。这正好证明 §4.2 的设计——**名称启发式只是兜底，元数据才是主判据**。若只靠名字匹配，这个模型会被漏掉。

---

## 7. 这套机制的可复用性评估

### 7.1 通用部分（换任何 OpenAI 兼容上游都能用）

| 模块 | 复用度 | 说明 |
| --- | --- | --- |
| `events.ts` | **100% 整搬** | pi-ai → DSH chunk 的净室实现，与上游无关 |
| `messages.ts` 的 `toPiContext` / 图片附件加载 | ~85% | 只删掉 `bash/read` 门 |
| `index.ts` 骨架 | ~90% | 只改 `name` / `PROVIDER_ID` / 数据目录 |
| `config.ts` 的 Config + volatile 语义 | ~90% | 改字段名与默认值 |
| `catalog.ts` 的 S1/S2/S3 状态机 | 结构可复用 | 数据源要换 |
| `zen-adapter.ts` 的五方法骨架 | 结构可复用 | wire 装配要换 |
| 看门狗、错误分类、usage 归并 | 可复用 | 语义普适 |

### 7.2 Zen 专属部分（必须替换）

| 硬编码假设 | 位置 |
| --- | --- |
| `ZEN_BASE_URL = 'https://opencode.ai/zen'` | `catalog.ts:17` |
| 匿名凭证字面量 `'public'` | `zen-adapter.ts:131`、`catalog.ts:439` |
| UA `opencode/1.18.31 (...)` | `ids.ts:104` |
| 7 个 `x-opencode-*` / `x-session-affinity` 伪装头 | `ids.ts:112` |
| 规范 session 形状 `ses_<12hex><14base62>` | `ids.ts:73` |
| body 必须含 `bash`+`read` 工具 | `messages.ts:299` |
| models.dev 的 `opencode` provider 段偏好 | `catalog.ts:97-152` |
| `isFreeModel` = id 含 `'free'` | `catalog.ts:37` |
| 7 条静态兜底 id | `catalog.ts:20` |
| `muse-spark*` 走 Responses | `routing.ts:1` |
| 默认 262144 / 32768 token | `zen-adapter.ts:47-48` |
| `PROVIDER_ID='opencode2dsh'`、`~/.opencode2dsh` | `zen-adapter.ts:26`、`index.ts:120` |

### 7.3 合规边界（必须诚实标注）

上游的 429 文案已经给出官方立场：**"Free models work in OpenCode"**。这意味着：

- 免费档是**面向 OpenCode 客户端用户**的权益，按**出口 IP** 限流；
- 插件通过伪装成官方 CLI 来使用它，属于**客户端同形请求**，不是伪造凭证（凭证本就是公开字面量）；
- 但**不能宣传为"无限免费"**，也不能做多 IP 轮换轰炸——opencode2dsh 的 IP 池默认就是关闭的（`enabled=false`），且文档要求诚实标注"匿名配额受上游限流"。

> 关于 DevEco Code 那条通道的认证、门禁与合规约束，见配套报告 [deveco-vs-opencode-comparison.md](./deveco-vs-opencode-comparison.md)。

---

## 8. 关键结论

1. **"免费模型"是一个价格标签，不是一个接口。** 上游只提供模型与价格，免费与否由客户端按 `cost == 0` 判定——这是整套设计的地基。

2. **"引流"的本质是行为同形，不是凭证破解。** 匿名凭证 `public` 是公开的、写在源码里的常量；真正的门禁是**会话形状 + 请求头 + body 里必须有 agent 工具**这三道客户端特征。插件通过确定性哈希伪造会话 ID、补齐 `bash/read` 工具桩，从而通过门禁。

3. **DSH 插件的作用是"翻译"而非"代理"。** 它把 pi-ai 的事件流翻成 DSH 的 7 种 chunk，把 HTTP 语义翻成 5 种 finish reason。真正的网络与流式处理复用宿主同一个 pi-ai 实现，因此代码量极小（核心约 1200 行）。

4. **三源目录（S1/S2/S3）是对"上游不稳定"的工程化回答。** 实时列表 + 价格元数据 + 编译期静态表，配合启动快重试与 24h 缓存，覆盖了断网、上游改版、模型轮换三种失效场景。

5. **契约细节决定成败。** `providerInfo` 的 `id` 必须严格等于注册名、`providerRetryPolicy` 必须存在（哪怕返回 `undefined`）、流必须以 `usage`+`finish` 收尾——这些在文档里不显眼，但错一个 provider 就静默消失。

6. **合规不是脚注，是设计约束。** 免费档按出口 IP 限流且官方明示"work in OpenCode"；多 IP 轮换默认关闭、文档要求诚实标注。这条约束不是可以"实现完再补"的细节，而是决定了插件能力上限的前提。

---

## 附录 A：本报告引用的关键文件索引

**OpenCode 上游**（`temp/opencode-dev/`）

| 文件 | 作用 |
| --- | --- |
| `packages/core/src/plugin/provider/opencode.ts` | 匿名 `apiKey:"public"` 注入（:388-399）、付费模型禁用（:403-413）、Console OAuth 设备码登录 |
| `packages/core/src/model.ts` | 免费模型优先排序 `PREFERRED_FREE`（:327）、`preferFree`（:334） |
| `packages/core/src/models-dev.ts` | models.dev 加载/刷新/快照（8.2 MB，132 模型） |
| `packages/core/src/plugin/models-dev.ts` | 目录投影与过滤（:33、:86-110） |
| `packages/core/src/session/model-request.ts` | 请求头组装（:290-303） |
| `packages/core/src/session/affinity.ts` | 会话亲和派生 |
| `packages/core/src/app.ts` | `useragent()` 格式 |
| `packages/ai/src/providers/opencode.ts` | `inference/systemone/v1` 端点与 System One 路由 |
| `packages/console/app/src/middleware.ts` | `/zen/v1/*` 是推理 API、`/zen` 是展示页的路径区分 |

**DSH 插件**（`temp/opencode2dsh-master/packages/plugin/`）

| 文件 | 作用 |
| --- | --- |
| `src/index.ts` | 插件外壳、`registerAdapter` 优先注册（:62/68/80/81/150） |
| `src/adapter/catalog.ts` | S1/S2/S3 目录与免费判定（:17/20/37/73/97/235/431/479） |
| `src/adapter/ids.ts` | 会话 ID 规范形状与伪装头（:18/40/53/73/95/104/112） |
| `src/adapter/messages.ts` | DSH→pi-ai 消息转换（:239）、免费档 body 门（:299/318/347） |
| `src/adapter/events.ts` | pi-ai→DSH chunk 转译（:7/16/63/85/132） |
| `src/adapter/zen-adapter.ts` | 适配器六方法（:310/318/323/333/344/369/385）、看门狗（:144-153） |
| `src/adapter/routing.ts` | Responses/Completions 分流 |

**DSH 宿主**（`app.asar` → `@deepseek-ai/dsh-llm@0.2.1-rc.5`）

| 位置 | 作用 |
| --- | --- |
| `lib/index.js` → `LlmAdapter` 类 | 六方法契约与默认实现 |
| `lib/index.js` → `prepareRoutes` | 注册校验（id/name/重复/retryPolicy） |
| `lib/index.js` → `attributionHeaders` | 归属头硬要求 |

**前期扫描结论**（`temp/.scan/`）

| 文件 | 内容 |
| --- | --- |
| `00-project-understanding.md` | 仓库总览与路线判断 |
| `opencode2dsh-plugin-brief.md` | 插件骨架与 Zen 专属边界（66 处锚点） |
| `deveco-channel-brief.md` | DevEco 通道代码级简报 |
| `probe-findings.md` | DevEco 协议实测记录 |
