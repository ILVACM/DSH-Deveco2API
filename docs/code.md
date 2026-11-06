# dsh-deveco2api v5.1 —— 代码修改实施方案（code.md）

> 版本：v4.0（重写，替代 v3.0「GUI v4 设置页迁移」施工图）
> 日期：2026-11-06
> 上游方案：[docs/plan.md](./plan.md)（**v5.1 定稿**，决策 D1~D4 已确认）
> 代码根目录：`D:\dsh-deveco2api\packages\plugin`（下文相对路径均相对此目录，除非显式写绝对路径）
> 本文性质：**方案设计阶段文档，不含任何已执行操作**。本文是给「多 agent 协作执行」用的施工图。
> 设计目标：**无论使用何种模型、更换何种 agent 软件，只要严格按本文操作，得到的文件树与代码结果完全一致。**

---

## 0. 执行者必读（消除歧义的硬规则）

### 0.1 绝对规则（违反即视为执行错误）

1. **只改本文 §1 明确列出的文件**。其余一律不动，尤其：`src/adapter/events.ts` 只允许改**第 106 行一个字符串**（见 §3-T0），其它行一律不动。
2. **所有写入必须幂等**：每任务开始前先 `read` 目标文件；符合本文给定内容则跳过，不符合则整体覆盖。
3. **语言/风格**：TypeScript，ESM，单引号，2 空格缩进，无分号。禁止 `enum` / `namespace` / 构造函数参数属性。
4. **导入约定**：相对导入带 `.ts` 后缀；类型导入用 `import type`；**不 import 任何 `@deepseek-ai/*` 运行时类型**。
5. **不新增/删除依赖**：`dependencies` / `devDependencies` 保持现状。`package.json` 只改 `version` 一个字段。
6. **`wire.ts` 是整体重写**：不要做零散 `edit`，直接 `write` 完整文件（§5.1）。零散改动极易漏改，导致行为不一致。
7. **不改 DSH 宿主**：不动 `C:\Users\hbk\AppData\Local\Programs\DeepSeek Harness\**` 下任何文件。
8. **禁止执行**：`dsh plugin add/remove`、重启 DSH、改 `~/.dsh/profiles/*`、发真实上游请求。本方案只产出代码与单测；`typecheck`/`test`/`build`/`build:client`/`pack` 由集成 agent 统一执行（§6）。**重装与实机验证需用户另行明确授权**（plan D4 已授权实机验证，但不属本方案阶段）。

### 0.2 固定命名与常量（全局唯一，禁止各任务自行命名）

| 项 | 固定值 |
| --- | --- |
| 思考开标签字面量 | `<think>`（7 字符） |
| 思考闭标签字面量 | `</think>`（8 字符） |
| 权威块类型名 | `tool-call`（**连字符**，非 `toolCall`） |
| 思考块类型名 | `thinking`（`DoneMessage.content` 内） |
| 正文块类型名 | `text`（`DoneMessage.content` 内） |
| 工具参数降级键 | `__raw` |
| 新版本号 | `0.1.4` |
| 块编号规则 | `contentIndex === content.length`（推入前取） |
| 块顺序 | reasoning → text → tool-call |
| 每响应块数上限 | reasoning ≤ 1、text ≤ 1、tool-call 可多个 |

### 0.3 前置核验（集成 agent 派发前逐条确认，任一不满足则停止报告）

1. `node --version` ≥ 22；`corepack --version` 可用。
2. `packages/plugin/package.json` 当前 `version === "0.1.3"`、`name === "dsh-deveco2api-plugin"`。
3. `corepack pnpm typecheck` 当前 **EXIT 0**（基线不破）。
4. `corepack pnpm test` 当前 **55 pass / 0 fail**（基线不破）。
5. `src/adapter/wire.ts` 当前 **329 行**，且 `async function* parseUpstreamEvents` 存在但**未导出**。
6. `src/adapter/events.ts` 第 106 行含 `b.type === 'toolCall'`。
7. **多 agent 协作能力**：本环境为 Agent Teams（Lead + `spawn_teammate` + 共享工作目录 + 任务板）。集成 agent 必须用 `spawn_teammate` 派生工作者，不得自己串行写完。
8. **写作用域隔离**：见 §4；任意两个并行任务写文件路径集合**必须不相交**；`events.ts` 与 `package.json` 由集成 agent 独占。

### 0.4 多 agent 协作模式（强制引导）

```
Lead / 集成 agent
  ├─ 先做 §0.3 前置核验 → 建任务板（team_task_create），按 §4 依赖图切「可并行」组。
  ├─ 用 spawn_teammate 派生 3 个工作者：agent-wire / agent-test-think / agent-test-tool。
  │   每人：认领任务 → 只写自己作用域文件 → team_task_update(complete) + send_message 汇报。
  │   工作者之间禁止互写对方文件；需要对方常量/接口，以 §2「共享契约」为准，不读对方未提交代码。
  ├─ 集成 agent 独占：src/adapter/events.ts（1 行）/ package.json（1 字段）/ 全套验收（§6）。
  └─ 全部完成后集成 agent 执行 §6 验收；失败把具体失败点发回对应工作者修正。
```

**环境能力保证**：本会话已确认具备 Agent Teams（Lead + `spawn_teammate` + 共享工作目录 + 任务板）。若换到不支持 teammate 的 agent 软件，等价做法：把 §4 的 3 个「写作用域」当作 3 个独立子任务并行下发（`subagent` / `workflow` 均可），只要满足「写文件互不相交 + 共享契约固定 + 集成阶段统一验收」。**产物文件树与代码完全一致**。
**名额限制预案**：Agent Teams 成员上限 8。若 `spawn_teammate` 失败，改用 `subagent` 工具并行下发等价任务（prompt 与写作用域完全相同），集成阶段由 Lead 串行做接缝。

---

## 1. 目标文件树（最终形态，逐文件核对）

```
packages/plugin/
├─ package.json                          [改] 集成 agent 独占（version → 0.1.4，仅此一处）
├─ src/adapter/
│  ├─ wire.ts                            [整体重写] agent-wire（329 行 → 约 430 行）
│  └─ events.ts                          [改 1 行] 集成 agent 独占（第 106 行 'toolCall' → 'tool-call'）
└─ test/
   ├─ wire-thinking.test.ts              [新增] agent-test-think
   └─ wire-toolcall.test.ts              [新增] agent-test-tool
```

> §1 未列出的文件，任何 agent 不得创建或修改。

---

## 2. 共享契约（各 agent 共同依赖的精确接口，禁止自行改名）

> 三个 agent 只依赖本节文本，**不读对方文件**。本节即唯一事实源。

### 2.1 `src/adapter/wire.ts` 新增导出（agent-wire 产出）

```ts
/** 内联思考切分结果：字符串 + 在全文中的精确区间。 */
export interface InlineSplit {
  thinkingRaw: string
  textRaw: string
  hasTag: boolean
  thinkingStart: number
  thinkingEnd: number
  textStart: number
  textEnd: number
}

/** 纯函数：把整段 content 全文按 plan §4.3 规则切成「思考 / 正文」。 */
export function splitInlineThinking(full: string): InlineSplit

/** 已改为导出（原为私有）：解析上游 SSE 原文为事件流。 */
export async function* parseUpstreamEvents(
  rawText: Promise<string>,
  status: number,
  contentType: string,
): AsyncGenerator<UpstreamEvent>
```

**`splitInlineThinking` 精确行为（agent-test-think 按此断言，不得另作理解）**：

| 输入 `full` | `hasTag` | `thinkingRaw` | `textRaw` |
| --- | --- | --- | --- |
| `''` | false | `''` | `''` |
| `'纯正文'` | false | `''` | `'纯正文'` |
| `'思考</think>正文'` | true | `'思考'` | `'正文'` |
| `'<think>思考</think>正文'` | true | `'思考'` | `'正文'` |
| `'<think>思考'`（未闭合） | true | `'思考'` | `''` |
| `'思考</think>\n\n正文'` | true | `'思考'` | `'正文'` |
| `'</think>正文'`（前缀空） | true | `''` | `'正文'` |

### 2.2 事件契约（agent-wire 产出、agent-test-* 断言）

上游事件类型（`src/adapter/events.ts` 已定义，**不改**）：

```ts
{ type: 'thinking_start'; contentIndex: number; partial: PartialMessage }
{ type: 'thinking_delta'; contentIndex: number; delta: string; partial: PartialMessage }
{ type: 'thinking_end';   contentIndex: number; content: string; partial: PartialMessage }
{ type: 'text_start';     contentIndex: number; partial: PartialMessage }
{ type: 'text_delta';     contentIndex: number; delta: string; partial: PartialMessage }
{ type: 'text_end';       contentIndex: number; content: string; partial: PartialMessage }
{ type: 'toolcall_start'; contentIndex: number; partial: PartialMessage }
{ type: 'toolcall_delta'; contentIndex: number; delta: string; partial: PartialMessage }
{ type: 'toolcall_end';   contentIndex: number; toolCall: { id: string; name: string; arguments: Record<string, unknown> }; partial: PartialMessage }
{ type: 'done';           message: DoneMessage }
```

**块类型与参数形状（唯一权威）**：

| 载体 | `type` 值 | `arguments` 形状 |
| --- | --- | --- |
| `DoneMessage.content` 中的工具块 | `'tool-call'` | **JSON 字符串** |
| `DoneMessage.content` 中的思考块 | `'thinking'` | 无（用 `thinking` 字段） |
| `DoneMessage.content` 中的正文块 | `'text'` | 无（用 `text` 字段） |
| `toolcall_end.toolCall.arguments` | — | **已解析对象** |

> `events.ts` 第 190 行会把 `toolCall.arguments` 用 `JSON.stringify` 转成字符串发给 DSH。职责边界：`wire.ts` 内部传对象，`events.ts` 序列化。

### 2.3 `DoneMessage.content` 结构契约（agent-wire 产出、agent-test-tool 断言）

```
content[0] = { type: 'thinking', thinking: <思考全文> }      // 仅当有思考
content[1] = { type: 'text',     text:     <正文全文> }      // 仅当有正文
content[n] = { type: 'tool-call', id, name, arguments: <JSON 字符串> }   // 每个工具调用一块，按上游出现顺序
```

- 索引**严格等于**数组下标（`contentIndex === content.length` 于推入前取）。
- 文本块与工具块**绝不撞号**。
- 工具块一定排在思考/正文块之后。

### 2.4 服务端常量一致性

`wire.ts` 内 `URL_CHAT` 不变；`events.ts` 内 `provider: 'deveco2dsh'` 不变（由 `wire.ts` 的 `DoneMessage.provider` 提供）。

---

## 3. 精确改动点

> 标 `[覆盖]` = 直接 `write` 完整内容（见 §5）；标 `[替换]` = `edit` 文本级替换（old_string 必须唯一，见 §3.9）。

### T0 — `src/adapter/events.ts`（集成 agent 独占，**仅 1 行**）

替换 —— 第 106 行：
```
old:      const hasContent = message.content.some((b) => b.type === 'text' || b.type === 'toolCall')
new:      const hasContent = message.content.some((b) => b.type === 'text' || b.type === 'tool-call')
```

> **只改这一处**。`events.ts` 其余 207 行（映射表、usage、错误分类）**一字不动**。这是类型名笔误修正，不是改映射规则（plan §4.8）。

### T1 — `package.json`（集成 agent 独占，**仅 1 字段**）

替换：
```
old:  "version": "0.1.3",
new:  "version": "0.1.4",
```

> `dsh.client.inject`、`dsh.bundle`、scripts 等**一律不动**。

### T2 — `src/adapter/wire.ts`（agent-wire，`[覆盖]` 整体重写，见 §5.1）

**为什么整体重写**：改动涉及顶部新增常量与函数、中部 `parseUpstreamEvents` 全部逻辑、底部新增辅助函数。零散 `edit` 会因行号漂移与锚点重复而失败或漏改。完整内容已在 §5.1 给出，逐字覆盖即可。

改动摘要（供验收核对，不作为实施手段）：

| 位置 | 改动 |
| --- | --- |
| 顶部 | 新增 `THINK_OPEN` / `THINK_CLOSE` 常量；新增 `InlineSplit` 接口、`trimStartOf` / `trimEndOf` / `stripThinkTags` / `splitInlineThinking` / `classifyPosition` / `parseToolArguments` 函数 |
| `parseUpstreamEvents` | 改为 `export`；新增**第一遍**全文扫描（`fullContent` + `hasStructuredReasoning`）；新增**第二遍**切分（`split` + `dropInlineThinking` + `toolBlockBase`）；主循环 tool_calls 分支改为**参数缓冲**（T2）；content 分支改为**按区间片段分发**（§4.6）；收尾改为**统一编号建块**（§4.5 + T1 + T3） |
| `partial` | 与 `content` **同一数组引用**（T3） |
| 其余函数 | `streamChat` / `parseSseFrames` / `parseJsonSafe` / `extractUsage` / `extractChoice` / `makeErrorEvent` / `describeUpstreamError` / `uuid32` **全部原样保留** |

### T3 — `test/wire-thinking.test.ts`（agent-test-think，`[覆盖]` 新增，见 §5.2）

### T4 — `test/wire-toolcall.test.ts`（agent-test-tool，`[覆盖]` 新增，见 §5.3）

### 3.9 old_string 唯一性核验表（集成 agent 派发前逐条验证）

| 替换 | 文件 | old_string 关键片段 | 期望命中 |
| --- | --- | --- | --- |
| T0 | src/adapter/events.ts | `message.content.some((b) => b.type === 'text' \|\| b.type === 'toolCall')` | 1 |
| T1 | package.json | `"version": "0.1.3",` | 1 |

任一不是 1 → 停止报告，不得猜测改写。

---

## 4. 并行切分与写作用域（强制，任务板依赖图）

### 4.1 三个并行工作者 + 一个集成 agent

| 任务 ID | 工作者 | 写作用域（**独占，禁止交叉**） | 依赖 |
| --- | --- | --- | --- |
| `task-wire` | agent-wire | `src/adapter/wire.ts` | 按 §2.1 / §2.3 契约编码 |
| `task-test-think` | agent-test-think | `test/wire-thinking.test.ts` | 只依赖 §2.1 / §2.2 契约文本 |
| `task-test-tool` | agent-test-tool | `test/wire-toolcall.test.ts` | 只依赖 §2.2 / §2.3 契约文本 |
| `task-seam` | 集成 agent（Lead） | `src/adapter/events.ts`、`package.json` | 依赖前 3 个任务完成 |

### 4.2 依赖图

```
[起点] ─┬─→ task-wire ────────┐
        ├─→ task-test-think ──┼─→ task-seam（全部完成后）─→ [验收 §6]
        └─→ task-test-tool ───┘
```

`task-seam` 的 `blocked_by` = 三个任务 id。

### 4.3 并行执行指令（给集成 agent 的精确动作序列）

1. `team_task_create` 四个任务（按 §4.1 subject/description/写作用域）。
2. `spawn_teammate` 派生 3 个工作者 `agent-wire` / `agent-test-think` / `agent-test-tool`，每人 prompt **原样附上** §0 硬规则 + §2 共享契约 + 对应 §5 代码。prompt 必须自包含。
3. 三个工作者只写自己作用域文件，完成后 `team_task_update(complete)` + `send_message` 汇报。
4. 集成 agent 等三个 `completed`（`wait_agent`），再独占改 `events.ts`（T0）与 `package.json`（T1）。
5. 执行 §6 验收。

### 4.4 环境能力保证

- Agent Teams 环境下：Lead 用 `spawn_teammate` / `team_task_*` / `send_message` / `wait_agent`（本会话已核实可用）。
- 无 teammate 的软件：把 §4.1 三个写作用域当 3 个独立 `subagent` 并行下发，集成阶段主 agent 串行做 `task-seam`。**产物完全一致**。
- **名额已满（上限 8）**：用 `subagent` 工具并行下发等价任务；写作用域与 prompt 完全相同。

---

## 5. 各任务完整代码内容（agent 直接照抄写入）

### 5.1 `src/adapter/wire.ts`（agent-wire `[覆盖]` 整体重写）

```ts
/**
 * 自写 HTTP 流式请求层：直接对接 DevEco MaaS 端点。
 *
 * 为什么不用 pi-ai 的 openai-completions 模块（对齐计划 §6 偏差说明）：
 * DevEco 的协议与 pi-ai 内置的 openai SDK 假设有 4 处冲突（全部 P0 实测）：
 * 1. SSE 帧前有 `id: N` 行（标准 OpenAI 客户端忽略此行，但 pi-ai 的 SDK 假设无此行）
 * 2. 每帧都带 `usage`（OpenAI 只在末尾带一次）
 * 3. 坏 token 返回 HTTP 200 + 裸 JSON `errorCode:4016`（OpenAI SDK 期望 401 + error 字段）
 * 4. 未知模型静默回落到 deepseek-v4-flash（无错误）
 *
 * 自写约 300 行，全部行为已由 P0 probe.ts 逐项验证，且省掉 openai SDK 依赖。
 *
 * v5.1 变更（plan.md v5.1）：
 * - 内联思考分离：上游把推理写进 content 时，按 `<think>` / `</think>` 切成 reasoning 块
 * - 工具调用修复：块进入 content、参数分片累积并解析、partial 与 content 同源、类型名统一
 *
 * @module src/adapter/wire.ts
 */

import { randomUUID } from 'node:crypto'
import type { UpstreamEvent, PartialMessage, DoneMessage } from './events.ts'
import type { UpstreamRequestBody } from './messages.ts'

const URL_CHAT = 'https://cn.devecostudio.huawei.com/sse/codeGenie/maas/v2/chat/completions'

/** 思考开标签字面量（P0 实测：GLM-5.3 会把推理写进 content）。 */
const THINK_OPEN = '<think>'
/** 思考闭标签字面量（P0 实测主流形态：只有闭合标签，无开标签）。 */
const THINK_CLOSE = '</think>'

/** 32 位小写 hex（Chat-Id / Session-Id 形状，对齐 deveco 的 randomUUID().replace(/-/g,'')）。 */
function uuid32(): string {
  return randomUUID().replace(/-/g, '')
}

export interface WireOptions {
  access: string
  body: UpstreamRequestBody
  signal?: AbortSignal
  timeoutMs?: number
}

export interface WireResult {
  status: number
  contentType: string
  events: AsyncIterable<UpstreamEvent>
  rawText: Promise<string>
}

/**
 * 发起流式对话请求，返回事件流。
 *
 * 最小必需头三件套（P0 实测）：
 *   authorization + Chat-Id + content-type
 * 可选：Session-Id / lang
 */
export async function streamChat(options: WireOptions): Promise<WireResult> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${options.access}`,
    'Chat-Id': uuid32(),
    'Session-Id': uuid32(),
    lang: 'en',
  }

  const response = await fetch(URL_CHAT, {
    method: 'POST',
    headers,
    body: JSON.stringify(options.body),
    signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 60_000),
  })

  const contentType = response.headers.get('content-type') ?? ''
  const rawText = response.text()

  return {
    status: response.status,
    contentType,
    events: parseUpstreamEvents(rawText, response.status, contentType),
    rawText,
  }
}

/** 内联思考切分结果：字符串 + 在全文中的精确区间（区间供逐帧分发，避免二次实现）。 */
export interface InlineSplit {
  thinkingRaw: string
  textRaw: string
  hasTag: boolean
  /** 思考区间 [thinkingStart, thinkingEnd)；为空时两者相等且为 0 */
  thinkingStart: number
  thinkingEnd: number
  /** 正文区间 [textStart, textEnd) */
  textStart: number
  textEnd: number
}

/** 去掉所有思考标签字面量（防御性清理，plan §4.3 第 4 步）。 */
function stripThinkTags(text: string): string {
  return text.split(THINK_OPEN).join('').split(THINK_CLOSE).join('')
}

/** 区间内首个非空白字符下标；全空白则返回 end。 */
function trimStartOf(text: string, start: number, end: number): number {
  let i = start
  while (i < end && /\s/.test(text[i] as string)) i += 1
  return i
}

/** 区间内末个非空白字符的下一个下标；全空白则返回 start。 */
function trimEndOf(text: string, start: number, end: number): number {
  let i = end
  while (i > start && /\s/.test(text[i - 1] as string)) i -= 1
  return i
}

/**
 * 把整段 content 全文按 plan §4.3 规则切成「思考 / 正文」两部分。
 * 纯函数、无副作用、可单测。区间与字符串由同一次计算得出，不会互相矛盾。
 */
export function splitInlineThinking(full: string): InlineSplit {
  if (full.length === 0) {
    return { thinkingRaw: '', textRaw: '', hasTag: false, thinkingStart: 0, thinkingEnd: 0, textStart: 0, textEnd: 0 }
  }

  const closeIdx = full.indexOf(THINK_CLOSE)
  if (closeIdx >= 0) {
    // 形态 1（P0 主流）：闭合标签之前全是思考，之后是正文
    const tStart = trimStartOf(full, 0, closeIdx)
    const tEnd = trimEndOf(full, tStart, closeIdx)
    const xStart = trimStartOf(full, closeIdx + THINK_CLOSE.length, full.length)
    const xEnd = full.length
    const thinkingEmpty = tStart >= tEnd
    return {
      thinkingRaw: thinkingEmpty ? '' : stripThinkTags(full.slice(tStart, tEnd)),
      textRaw: stripThinkTags(full.slice(xStart, xEnd)),
      hasTag: true,
      thinkingStart: thinkingEmpty ? 0 : tStart,
      thinkingEnd: thinkingEmpty ? 0 : tEnd,
      textStart: xStart,
      textEnd: xEnd,
    }
  }

  const openIdx = full.indexOf(THINK_OPEN)
  if (openIdx >= 0) {
    // 形态 2：只有开标签、未闭合 → 开标签之前是正文，之后是思考
    const xStart = trimStartOf(full, 0, openIdx)
    const xEnd = openIdx
    const tRegionStart = openIdx + THINK_OPEN.length
    const tStart = trimStartOf(full, tRegionStart, full.length)
    const tEnd = trimEndOf(full, tStart, full.length)
    const thinkingEmpty = tStart >= tEnd
    return {
      thinkingRaw: thinkingEmpty ? '' : stripThinkTags(full.slice(tStart, tEnd)),
      textRaw: stripThinkTags(full.slice(xStart, xEnd)),
      hasTag: true,
      thinkingStart: thinkingEmpty ? 0 : tStart,
      thinkingEnd: thinkingEmpty ? 0 : tEnd,
      textStart: xStart,
      textEnd: xEnd,
    }
  }

  // 形态 3：无标签 → 整段为正文（与改前行为完全一致，零回归；不做任何修剪）
  return {
    thinkingRaw: '',
    textRaw: full,
    hasTag: false,
    thinkingStart: 0,
    thinkingEnd: 0,
    textStart: 0,
    textEnd: full.length,
  }
}

/** 判定全文某个字符位置属于思考 / 正文 / 丢弃。 */
function classifyPosition(pos: number, split: InlineSplit, dropThinking: boolean): 'reasoning' | 'text' | 'drop' {
  if (pos >= split.thinkingStart && pos < split.thinkingEnd) return dropThinking ? 'drop' : 'reasoning'
  if (pos >= split.textStart && pos < split.textEnd) return 'text'
  return 'drop'
}

/** 解析工具调用参数文本：失败降级为 `{ __raw }`，绝不静默丢参（plan §4.7.1）。 */
function parseToolArguments(argsText: string): Record<string, unknown> {
  const trimmed = argsText.trim()
  if (trimmed.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return { __raw: argsText }
  } catch {
    return { __raw: argsText }
  }
}

/**
 * 把上游 SSE 原文解析成 pi-ai 同形事件流。
 *
 * 处理 DevEco 的四种非标准行为（全部 P0 实测）：
 * 1. `id: N` + `data: {...}` 交替 → 解析成 text_delta / thinking_delta / toolcall_* 事件
 * 2. 每帧带 `usage` → 只取末帧的作为 done.usage
 * 3. `event: error` 帧 → 产出 error 事件（HTTP 状态码可能是 200）
 * 4. 裸 JSON `{"errorCode":4016,...}` → 产出 error 事件（无 SSE 包装）
 *
 * v5.1 三遍结构：
 *   第一遍：拼接 content 全文 + 判定是否已有结构化 reasoning_content
 *   第二遍：按 plan §4.3 切分全文；按 D2 决定是否丢弃内联思考；算出工具块起始编号
 *   第三遍：主循环按区间片段分发；收尾统一建块（编号 = content.length）
 */
export async function* parseUpstreamEvents(rawText: Promise<string>, status: number, contentType: string): AsyncGenerator<UpstreamEvent> {
  const raw = await rawText

  // 情况 1：裸 JSON 错误（坏 token → HTTP 200 + errorCode JSON）
  if (contentType.includes('application/json')) {
    yield makeErrorEvent(raw, status)
    return
  }

  // 情况 2：SSE 流（正常响应 / HTTP 200 内的 SSE 错误 / HTTP 4xx SSE）
  const frames = parseSseFrames(raw)
  if (frames.length === 0) {
    yield makeErrorEvent(raw, status)
    return
  }

  // ── 第一遍：拼接全文 + 判定结构化思考 ──
  let fullContent = ''
  let hasStructuredReasoning = false
  for (const frame of frames) {
    if (frame.event === 'error') continue
    const json = parseJsonSafe(frame.data)
    if (!json) continue
    const choice = extractChoice(json)
    if (!choice) continue
    const delta = choice['delta'] as Record<string, unknown> | undefined
    if (!delta) continue
    const reasoningDelta = delta['reasoning_content']
    if (typeof reasoningDelta === 'string' && reasoningDelta.length > 0) hasStructuredReasoning = true
    const contentDelta = delta['content']
    if (typeof contentDelta === 'string') fullContent += contentDelta
  }

  // ── 第二遍：切分 + D2 决策 + 工具块起始编号 ──
  const split = splitInlineThinking(fullContent)
  const dropInlineThinking = hasStructuredReasoning && split.hasTag
  const willHaveThinking = !dropInlineThinking && split.thinkingRaw.length > 0
  const willHaveText = split.textRaw.length > 0
  const toolBlockBase = (willHaveThinking ? 1 : 0) + (willHaveText ? 1 : 0)

  // ── 第三遍：主循环 ──
  const content: PartialMessage['content'] = []
  const partial: PartialMessage = { content }
  const toolBuffer: Array<{ id: string; name: string; argsText: string }> = []
  const toolOrdinal = new Map<number, number>()
  let textIndex = -1
  let thinkingIndex = -1
  let accumulatedText = ''
  let accumulatedThinking = ''
  let consumed = 0
  let usage: DoneMessage['usage'] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }
  let finishReason: DoneMessage['stopReason'] = 'stop'
  let errorMessage: string | undefined
  let echoModel = ''

  for (const frame of frames) {
    // event: error 帧
    if (frame.event === 'error') {
      yield makeErrorEvent(frame.data, status)
      return
    }
    const json = parseJsonSafe(frame.data)
    if (!json) continue

    // 每帧都可能带 usage；只留最新
    const frameUsage = extractUsage(json)
    if (frameUsage) usage = frameUsage

    const model = typeof json['model'] === 'string' ? (json['model'] as string) : ''
    if (model && !echoModel) echoModel = model

    const choice = extractChoice(json)
    if (!choice) continue

    const delta = choice['delta'] as Record<string, unknown> | undefined

    // tool_calls 增量：按上游 index 累积参数（T2），事件延后到收尾统一发出
    if (delta && Array.isArray(delta['tool_calls'])) {
      for (const tc of delta['tool_calls'] as Array<Record<string, unknown>>) {
        const upstreamIndex = typeof tc['index'] === 'number' ? (tc['index'] as number) : 0
        const id = typeof tc['id'] === 'string' ? (tc['id'] as string) : ''
        const fn = tc['function'] as Record<string, unknown> | undefined
        const name = typeof fn?.['name'] === 'string' ? (fn['name'] as string) : ''
        const argsDelta = typeof fn?.['arguments'] === 'string' ? (fn['arguments'] as string) : ''
        let ordinal = toolOrdinal.get(upstreamIndex)
        if (ordinal === undefined) {
          ordinal = toolBuffer.length
          toolOrdinal.set(upstreamIndex, ordinal)
          toolBuffer.push({ id, name, argsText: '' })
        } else {
          const entry = toolBuffer[ordinal]
          if (entry) {
            if (id && entry.id === '') entry.id = id
            if (name && entry.name === '') entry.name = name
          }
        }
        if (argsDelta.length > 0) {
          const entry = toolBuffer[ordinal]
          if (entry) entry.argsText += argsDelta
        }
      }
    }

    // reasoning_content 增量（结构化通道，行为不变）
    if (delta && typeof delta['reasoning_content'] === 'string') {
      const thinkingDelta = delta['reasoning_content'] as string
      if (thinkingDelta.length > 0) {
        if (thinkingIndex < 0) {
          thinkingIndex = content.length
          yield { type: 'thinking_start', contentIndex: thinkingIndex, partial }
          content.push({ type: 'thinking', thinking: '' })
        }
        accumulatedThinking += thinkingDelta
        yield { type: 'thinking_delta', contentIndex: thinkingIndex, delta: thinkingDelta, partial }
      }
    }

    // content 增量：按预计算区间切成 reasoning / text / drop 片段（plan §4.6）
    if (delta && typeof delta['content'] === 'string' && (delta['content'] as string).length > 0) {
      const textDelta = delta['content'] as string
      const frameStart = consumed
      const frameEnd = consumed + textDelta.length
      consumed = frameEnd
      let cursor = frameStart
      while (cursor < frameEnd) {
        const kind = classifyPosition(cursor, split, dropInlineThinking)
        let next = cursor + 1
        while (next < frameEnd && classifyPosition(next, split, dropInlineThinking) === kind) next += 1
        const piece = fullContent.slice(cursor, next)
        cursor = next
        if (kind === 'drop' || piece.length === 0) continue
        if (kind === 'reasoning') {
          if (thinkingIndex < 0) {
            thinkingIndex = content.length
            yield { type: 'thinking_start', contentIndex: thinkingIndex, partial }
            content.push({ type: 'thinking', thinking: '' })
          }
          accumulatedThinking += piece
          yield { type: 'thinking_delta', contentIndex: thinkingIndex, delta: piece, partial }
        } else {
          if (textIndex < 0) {
            textIndex = content.length
            yield { type: 'text_start', contentIndex: textIndex, partial }
            content.push({ type: 'text', text: '' })
          }
          accumulatedText += piece
          yield { type: 'text_delta', contentIndex: textIndex, delta: piece, partial }
        }
      }
    }

    // finish_reason
    const reason = typeof choice['finish_reason'] === 'string' ? (choice['finish_reason'] as string) : ''
    if (reason === 'stop') finishReason = 'stop'
    else if (reason === 'length') finishReason = 'length'
    else if (reason === 'tool_calls') finishReason = 'toolUse'
  }

  // 收尾 1：思考块（编号最小）
  if (thinkingIndex >= 0) {
    yield { type: 'thinking_end', contentIndex: thinkingIndex, content: accumulatedThinking, partial }
    const block = content[thinkingIndex]
    if (block && block.type === 'thinking') block['thinking'] = accumulatedThinking
  }

  // 收尾 2：正文块
  if (textIndex >= 0) {
    yield { type: 'text_end', contentIndex: textIndex, content: accumulatedText, partial }
    const block = content[textIndex]
    if (block && block.type === 'text') block['text'] = accumulatedText
  }

  // 收尾 3：工具调用块（T1：推入 content；T3：先入数组再发事件，使 partial 可取到）
  const toolBlocks: Array<{ type: string; id: string; name: string; arguments: string }> = []
  for (let ordinal = 0; ordinal < toolBuffer.length; ordinal += 1) {
    const entry = toolBuffer[ordinal]
    if (!entry) continue
    const parsedArguments = parseToolArguments(entry.argsText)
    const block = {
      type: 'tool-call',
      id: entry.id,
      name: entry.name,
      arguments: JSON.stringify(parsedArguments),
    }
    const blockIndex = content.length
    content.push(block)
    toolBlocks.push(block)
    yield { type: 'toolcall_start', contentIndex: blockIndex, partial }
    if (entry.argsText.length > 0) {
      yield { type: 'toolcall_delta', contentIndex: blockIndex, delta: entry.argsText, partial }
    }
    yield { type: 'toolcall_end', contentIndex: blockIndex, toolCall: { id: entry.id, name: entry.name, arguments: parsedArguments }, partial }
  }

  // 空正文检查（P0 发现：思考吃满预算会导致 content 为空——上游仍返回 200）
  if (finishReason === 'stop' && accumulatedText.length === 0 && accumulatedThinking.length === 0 && toolBlocks.length === 0) {
    errorMessage = `model "${echoModel}" returned a completed response with no content`
    finishReason = 'error'
  }

  const message: DoneMessage = {
    api: 'openai-completions',
    provider: 'deveco2dsh',
    model: echoModel,
    content,
    usage,
    stopReason: finishReason,
    ...(errorMessage !== undefined ? { errorMessage } : {}),
  }
  yield { type: 'done', message }
}

/** 解析 SSE 帧序列（`id: N` + `event:` + `data:` 组合，空行分隔）。 */
function parseSseFrames(raw: string): Array<{ id?: string; event?: string; data: string }> {
  const frames: Array<{ id?: string; event?: string; data: string }> = []
  let current: { id?: string; event?: string; data: string[] } = { data: [] }
  const flush = () => {
    if (current.data.length > 0 || current.event !== undefined) {
      frames.push({
        ...(current.id !== undefined ? { id: current.id } : {}),
        ...(current.event !== undefined ? { event: current.event } : {}),
        data: current.data.join('\n'),
      })
    }
    current = { data: [] }
  }
  for (const line of raw.split(/\r?\n/)) {
    if (line === '') {
      flush()
      continue
    }
    if (line.startsWith('id:')) current.id = line.slice(3).trim()
    else if (line.startsWith('event:')) current.event = line.slice(6).trim()
    else if (line.startsWith('data:')) current.data.push(line.slice(5).trim())
  }
  flush()
  return frames
}

function parseJsonSafe(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim()
  if (!trimmed || trimmed === '[DONE]') return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // 非 JSON 帧
  }
  return undefined
}

function extractUsage(json: Record<string, unknown>): DoneMessage['usage'] | undefined {
  const usage = json['usage']
  if (!usage || typeof usage !== 'object') return undefined
  const record = usage as Record<string, unknown>
  const input = typeof record['prompt_tokens'] === 'number' ? (record['prompt_tokens'] as number) : 0
  const output = typeof record['completion_tokens'] === 'number' ? (record['completion_tokens'] as number) : 0
  const total = typeof record['total_tokens'] === 'number' ? (record['total_tokens'] as number) : input + output
  const cacheDetails = record['prompt_tokens_details'] as Record<string, unknown> | undefined
  const cacheRead = typeof cacheDetails?.['cached_tokens'] === 'number' ? (cacheDetails['cached_tokens'] as number) : 0
  return { input, output, cacheRead, cacheWrite: 0, totalTokens: total }
}

function extractChoice(json: Record<string, unknown>): Record<string, unknown> | undefined {
  const choices = json['choices']
  if (!Array.isArray(choices) || choices.length === 0) return undefined
  const choice = choices[0]
  if (!choice || typeof choice !== 'object') return undefined
  return choice as Record<string, unknown>
}

function makeErrorEvent(raw: string, status: number): UpstreamEvent {
  const message: DoneMessage = {
    api: 'openai-completions',
    provider: 'deveco2dsh',
    model: '',
    content: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: 'error',
    errorMessage: describeUpstreamError(raw, status),
  }
  return { type: 'error', error: message }
}

/** 从 HTTP 200 内的裸 JSON / SSE error 帧里提取人类可读错误信息。 */
export function describeUpstreamError(raw: string, status: number): string {
  // DevEco 特征：裸 errorCode JSON
  const json = parseJsonSafe(raw)
  if (json) {
    const errorCode = json['errorCode']
    const errorMsg = json['errorMsg']
    if (typeof errorCode === 'number' && typeof errorMsg === 'string') {
      return `errorCode:${errorCode} ${errorMsg} (HTTP ${status})`
    }
    // OpenAI 形状的 error 对象
    const error = json['error']
    if (error && typeof error === 'object') {
      const record = error as Record<string, unknown>
      const message = typeof record['message'] === 'string' ? (record['message'] as string) : ''
      const original = record['param'] as Record<string, unknown> | undefined
      const originalMessage = typeof original?.['originalMessage'] === 'string' ? (original['originalMessage'] as string) : ''
      const type = typeof record['type'] === 'string' ? (record['type'] as string) : ''
      const parts = [message, originalMessage, type].filter(Boolean).join(' | ')
      if (parts.length > 0) return `${parts} (HTTP ${status})`
    }
  }
  // 兜底：截断原文
  return `upstream error (HTTP ${status}): ${raw.slice(0, 200)}`
}
```

> **实施要求**：整段覆盖写入 `src/adapter/wire.ts`。写完后确认：文件内 `export async function* parseUpstreamEvents` 出现 1 次、`function parseSseFrames` 1 次、`export function describeUpstreamError` 1 次、`function uuid32` 1 次、无重复定义。

### 5.2 `test/wire-thinking.test.ts`（agent-test-think `[覆盖]` 新增）

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { splitInlineThinking, parseUpstreamEvents } from '../src/adapter/wire.ts'
import type { UpstreamEvent } from '../src/adapter/events.ts'

/** 构造假 SSE 原文：每个 delta 一帧，末帧带 finish_reason。 */
function sse(deltas: Array<Record<string, unknown>>, finishReason = 'stop'): string {
  const frames = deltas.map((delta, index) => {
    const choice: Record<string, unknown> = { delta }
    if (index === deltas.length - 1) choice['finish_reason'] = finishReason
    const payload = { model: 'GLM-5.1', choices: [choice] }
    return `id: ${index}\ndata: ${JSON.stringify(payload)}\n`
  })
  return frames.join('\n')
}

async function collect(raw: string): Promise<UpstreamEvent[]> {
  const out: UpstreamEvent[] = []
  for await (const event of parseUpstreamEvents(Promise.resolve(raw), 200, 'text/event-stream')) {
    out.push(event)
  }
  return out
}

const types = (events: UpstreamEvent[]): string[] => events.map((e) => e.type)

test('splitInlineThinking：无标签 → 整段正文，hasTag=false', () => {
  const split = splitInlineThinking('纯正文')
  assert.equal(split.hasTag, false)
  assert.equal(split.thinkingRaw, '')
  assert.equal(split.textRaw, '纯正文')
  assert.equal(split.textStart, 0)
  assert.equal(split.textEnd, 3)
})

test('splitInlineThinking：只有闭合标签 → 之前思考、之后正文', () => {
  const split = splitInlineThinking('思考</think>正文')
  assert.equal(split.hasTag, true)
  assert.equal(split.thinkingRaw, '思考')
  assert.equal(split.textRaw, '正文')
})

test('splitInlineThinking：开闭标签齐全', () => {
  const split = splitInlineThinking('<think>思考</think>正文')
  assert.equal(split.thinkingRaw, '思考')
  assert.equal(split.textRaw, '正文')
})

test('splitInlineThinking：只有开标签（未闭合）', () => {
  const split = splitInlineThinking('<think>思考')
  assert.equal(split.hasTag, true)
  assert.equal(split.thinkingRaw, '思考')
  assert.equal(split.textRaw, '')
})

test('splitInlineThinking：空串', () => {
  const split = splitInlineThinking('')
  assert.equal(split.hasTag, false)
  assert.equal(split.thinkingRaw, '')
  assert.equal(split.textRaw, '')
})

test('splitInlineThinking：标签后有空行 → 正文去掉前导空白', () => {
  const split = splitInlineThinking('思考</think>\n\n正文')
  assert.equal(split.thinkingRaw, '思考')
  assert.equal(split.textRaw, '正文')
})

test('splitInlineThinking：闭合标签前缀为空 → 无思考', () => {
  const split = splitInlineThinking('</think>正文')
  assert.equal(split.thinkingRaw, '')
  assert.equal(split.textRaw, '正文')
})

test('端到端：内联思考切成 reasoning 块，正文切成 text 块', async () => {
  const events = await collect(sse([{ content: '思考内容</think>正文内容' }]))
  assert.deepEqual(types(events), [
    'thinking_start', 'thinking_delta', 'text_start', 'text_delta',
    'thinking_end', 'text_end', 'done',
  ])
  const delta = events[1]
  assert.equal(delta?.type, 'thinking_delta')
  if (delta?.type === 'thinking_delta') assert.equal(delta.delta, '思考内容')
  const textDelta = events[3]
  assert.equal(textDelta?.type, 'text_delta')
  if (textDelta?.type === 'text_delta') assert.equal(textDelta.delta, '正文内容')
  const thinkingEnd = events[4]
  if (thinkingEnd?.type === 'thinking_end') assert.equal(thinkingEnd.content, '思考内容')
  const textEnd = events[5]
  if (textEnd?.type === 'text_end') assert.equal(textEnd.content, '正文内容')
})

test('端到端：无标签时事件序列与改前一致（text_start/delta/end + done）', async () => {
  const events = await collect(sse([{ content: '第一段' }, { content: '第二段' }]))
  assert.deepEqual(types(events), ['text_start', 'text_delta', 'text_delta', 'text_end', 'done'])
  const done = events[events.length - 1]
  assert.equal(done?.type, 'done')
  if (done?.type === 'done') {
    assert.equal(done.message.stopReason, 'stop')
    assert.deepEqual(done.message.content, [{ type: 'text', text: '第一段第二段' }])
  }
})

test('端到端：结构化 reasoning_content 与内联标签并存 → 丢弃内联（D2）', async () => {
  const events = await collect(sse([
    { reasoning_content: '结构化思考' },
    { content: '内联思考</think>正文内容' },
  ]))
  assert.deepEqual(types(events), [
    'thinking_start', 'thinking_delta', 'text_start', 'text_delta',
    'thinking_end', 'text_end', 'done',
  ])
  const thinkingDelta = events[1]
  if (thinkingDelta?.type === 'thinking_delta') assert.equal(thinkingDelta.delta, '结构化思考')
  const textDelta = events[3]
  if (textDelta?.type === 'text_delta') assert.equal(textDelta.delta, '正文内容')
  const thinkingEnd = events[4]
  if (thinkingEnd?.type === 'thinking_end') assert.equal(thinkingEnd.content, '结构化思考')
})
```

### 5.3 `test/wire-toolcall.test.ts`（agent-test-tool `[覆盖]` 新增）

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseUpstreamEvents } from '../src/adapter/wire.ts'
import type { UpstreamEvent } from '../src/adapter/events.ts'

/** 构造假 SSE 原文：每个 delta 一帧，末帧带 finish_reason。 */
function sse(deltas: Array<Record<string, unknown>>, finishReason = 'tool_calls'): string {
  const frames = deltas.map((delta, index) => {
    const choice: Record<string, unknown> = { delta }
    if (index === deltas.length - 1) choice['finish_reason'] = finishReason
    const payload = {
      model: 'GLM-5.1',
      choices: [choice],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }
    return `id: ${index}\ndata: ${JSON.stringify(payload)}\n`
  })
  return frames.join('\n')
}

async function collect(raw: string): Promise<UpstreamEvent[]> {
  const out: UpstreamEvent[] = []
  for await (const event of parseUpstreamEvents(Promise.resolve(raw), 200, 'text/event-stream')) {
    out.push(event)
  }
  return out
}

/** 参数分 3 帧传完的完整工具调用。 */
const splitArgsFrames = [
  { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{"city"' } }] },
  { tool_calls: [{ index: 0, function: { arguments: ':"北京"' } }] },
  { tool_calls: [{ index: 0, function: { arguments: '}' } }] },
]

test('T2：参数分片累积后解析为完整对象', async () => {
  const events = await collect(sse(splitArgsFrames))
  const end = events.find((e) => e.type === 'toolcall_end')
  assert.ok(end)
  if (end?.type === 'toolcall_end') {
    assert.equal(end.toolCall.id, 'call_1')
    assert.equal(end.toolCall.name, 'get_weather')
    assert.deepEqual(end.toolCall.arguments, { city: '北京' })
  }
})

test('T1：tool-call 块进入 done.message.content，类型为 tool-call', async () => {
  const events = await collect(sse(splitArgsFrames))
  const done = events[events.length - 1]
  assert.equal(done?.type, 'done')
  if (done?.type === 'done') {
    const toolBlock = done.message.content.find((b) => b.type === 'tool-call')
    assert.ok(toolBlock)
    assert.equal(toolBlock?.['id'], 'call_1')
    assert.equal(toolBlock?.['name'], 'get_weather')
    assert.equal(toolBlock?.['arguments'], '{"city":"北京"}')
    assert.equal(done.message.stopReason, 'toolUse')
  }
})

test('T2 降级：非法 JSON 参数保留原文，不丢参', async () => {
  const events = await collect(sse([
    { tool_calls: [{ index: 0, id: 'call_2', function: { name: 'broken', arguments: '{not json' } }] },
  ]))
  const done = events[events.length - 1]
  if (done?.type === 'done') {
    const toolBlock = done.message.content.find((b) => b.type === 'tool-call')
    assert.equal(toolBlock?.['arguments'], '{"__raw":"{not json"}')
  }
  const end = events.find((e) => e.type === 'toolcall_end')
  if (end?.type === 'toolcall_end') {
    assert.deepEqual(end.toolCall.arguments, { __raw: '{not json' })
  }
})

test('T3：toolcall_start 的 partial 能取到 id/name', async () => {
  const events = await collect(sse(splitArgsFrames))
  const start = events.find((e) => e.type === 'toolcall_start')
  assert.ok(start)
  if (start?.type === 'toolcall_start') {
    const block = start.partial.content[start.contentIndex]
    assert.equal(block?.['id'], 'call_1')
    assert.equal(block?.['name'], 'get_weather')
  }
})

test('编号：正文块与工具块不撞号，且编号等于数组下标', async () => {
  const events = await collect(sse([
    { content: '我先看天气' },
    ...splitArgsFrames,
  ]))
  const done = events[events.length - 1]
  assert.equal(done?.type, 'done')
  if (done?.type === 'done') {
    assert.deepEqual(done.message.content.map((b) => b.type), ['text', 'tool-call'])
    assert.equal(done.message.content[0]?.['text'], '我先看天气')
    assert.equal(done.message.content[1]?.['type'], 'tool-call')
  }
  const textStart = events.find((e) => e.type === 'text_start')
  const toolStart = events.find((e) => e.type === 'toolcall_start')
  if (textStart?.type === 'text_start' && toolStart?.type === 'toolcall_start') {
    assert.notEqual(textStart.contentIndex, toolStart.contentIndex)
  }
})

test('工具调用与内联思考并存：块顺序为 thinking → text → tool-call', async () => {
  const events = await collect(sse([
    { content: '思考</think>正文' },
    ...splitArgsFrames,
  ]))
  const done = events[events.length - 1]
  if (done?.type === 'done') {
    assert.deepEqual(done.message.content.map((b) => b.type), ['thinking', 'text', 'tool-call'])
  }
})
```

---

## 6. 集成验收（集成 agent 独占，全部并行任务完成后执行）

```powershell
cd D:\dsh-deveco2api\packages\plugin
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm run build:client
corepack pnpm pack
```

| # | 检查 | 期望 |
| --- | --- | --- |
| 1 | `typecheck` | EXIT 0，无未使用导入 |
| 2 | `test` | 现有 55 项 + 新增（`wire-thinking` 10 项、`wire-toolcall` 6 项）→ **全部通过（71 项）** |
| 3 | `build` / `build:client` | `lib/index.js`、`lib/client.js` 生成；`client.js` 开头仍 `window.__ModuleLoader__.load` |
| 4 | `pack` | tgz `dsh-deveco2api-plugin-0.1.4.tgz`；prepack 校验通过 |
| 5 | `package.json` | `version === "0.1.4"`；`dsh.client.inject` 仍恰 3 项 |
| 6 | `events.ts` 仅 1 行 | `git diff --stat` 显示 `events.ts` 改动 1 行；`git diff src/adapter/events.ts` 只有第 106 行那一处 |
| 7 | `wire.ts` 无重复定义 | `export async function* parseUpstreamEvents` 1 次、`parseSseFrames` 1 次、`uuid32` 1 次、`describeUpstreamError` 1 次 |
| 8 | T1 块入 content | 单测通过：`done.message.content` 含 `{type:'tool-call'}` |
| 9 | T2 参数完整 | 单测通过：分 3 帧的参数最终为 `{"city":"北京"}`；非法 JSON 降级 `__raw` |
| 10 | T3 partial 同源 | 单测通过：`toolcall_start.partial.content[i]` 有 id/name |
| 11 | 编号不撞号 | 单测通过：`contentIndex === 数组下标`，text 与 tool-call 不同号 |
| 12 | 思考分离 | 单测通过：内联标签切出 reasoning + text；无标签时事件序列与改前一致 |
| 13 | D2 丢弃内联 | 单测通过：结构化与内联并存时思考只出现一次 |
| 14 | 结构核对 | §1 文件树逐文件存在；`git status` 只显示 §1 列出路径 |
| 15 | 主链路 | `import('./lib/index.js')` 加载成功、`listModels` 返回 2 模型 |

> 验收 #8~#13 由 §5.2 / §5.3 的单测自动覆盖，无需人工构造。

---

## 7. 不在本方案内（明确排除）

- 不改 DSH 宿主任何代码
- 不改 `src/adapter/events.ts` 除第 106 行外的任何内容（映射表、usage、错误分类全部原样）
- 不改 `src/adapter/messages.ts`（`stripThinkLeak` 保留；第 114 行 `'tool-call'` 本就正确）
- 不改 `src/adapter/deveco-adapter.ts`、`src/catalog.ts`、`src/capacity*.ts`、`src/compaction-policy.ts`、`src/context-guard.ts`、`src/status-bridge.ts`、`src/client/**`、`src/config.ts`、`src/index.ts`
- 不改 `tsdown.client.config.ts`、`tsconfig.json`、`cordis.patch.yml`、`scripts/prepare-package.mjs`
- 不改 `test/events.test.ts`（基准已用 `'tool-call'`）
- 不支持交错标签多块、不支持 `<thinking>` 等变体
- 不处理思考内容的 UI 折叠样式、不处理工具调用的 UI 展示（DSH 职责）
- 不执行 `dsh plugin add/remove`、不重启 DSH、不改 `~/.dsh/profiles/*`
- 不发真实上游请求（单测全部用假 SSE 文本）
- **重装 0.1.4 + 实机验证属部署验收**，需在实现完成后、按 plan D4 授权单独执行

---

## 8. 给执行者的最终检查清单

- [ ] 已读 `docs/plan.md` v5.1 与本文全文
- [ ] 已跑 §0.3 前置核验（基线 typecheck EXIT 0、test 55 pass、`wire.ts` 329 行）
- [ ] 已跑 §3.9 old_string 唯一性核验（T0、T1 各命中 1）
- [ ] 已用 `spawn_teammate`（或名额满时 `subagent`）派生 3 个工作者，prompt 自包含（附 §0 + §2 + 对应 §5 代码）
- [ ] 已按 §4.2 建任务依赖（task-seam blocked_by 三个任务）
- [ ] 三个工作者写作用域互不相交、未交叉读写
- [ ] 集成 agent 独占 `events.ts`（1 行）与 `package.json`（1 字段）
- [ ] `wire.ts` 是**整体覆盖写**，不是零散 edit
- [ ] 已跑 §6 全部验收且通过（含 0.1.4、72 项测试、events.ts 仅 1 行）
- [ ] `git status` 只包含 §1 列出路径

> **本文是施工图，不是执行结果。当前处于方案设计阶段，未做任何实际操作。**
