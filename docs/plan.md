# dsh-deveco2api 模型输出内容整理 v5.1 —— 思考分离 + 工具调用修复

> 版本：v5.1 **（定稿）**（v5.0 为纯思考分离；v5.1 扩范围并入工具调用三处缺陷）
> 日期：2026-11-06
> 状态：**已定稿**——四项决策已由用户确认（§11.1）：**版本号升 `0.1.4`**、**结构化与内联并存时丢弃内联**、**工具调用三处缺陷一起修**、**授权本会话实机验证工具调用**（后续请求自动批准）。无遗留待决事项。
> 范围：**两件事**——① 把上游写进 `content` 的 `<think>…</think>` 思考切分出来，改标为 DSH `reasoning` 块；② 修复工具调用三处缺陷（块未进 `content`、参数恒为 `{}`、`partial.content` 恒空）并统一块类型命名。
> 依据：仓库内 `packages/plugin/src/adapter/*` 实机源码逐行核实（`wire.ts` 329 行 / `events.ts` 208 行 / `messages.ts` / `test/events.test.ts`）+ P0 实测记录
> 本文性质：**方案设计阶段文档，不含任何已执行操作。**（实机验证已获授权，但**在本方案阶段不执行**，留待实现后）

---

## 1. 目标

> **① 思考分离**：在插件接收上游流的地方（`wire.ts`）把 `content` 里的 `<think>` 标签切出来，思考归思考块、正文归正文块——DSH 负责折叠显示，插件负责把字节分对类。
>
> **② 工具调用修复**：让工具调用真正可用——块进入最终 `content`、参数被完整累积与解析、块类型命名统一为 `tool-call`。

**不做**：不改 DSH 渲染、不改事件翻译层的映射规则、不改发送方向的历史清洗逻辑、不改模型路由与上下文管理。

> 说明：v5.1 虽改 `events.ts` 的**一处**（见 §4.7），但那不是改"映射规则"，而是补上"块未进 content"导致的下游兜底；映射表本身（`thinking_*`→`reasoning` 等）一字不动。

---

## 2. 现状与根因（已核实）

### 2.1 两条通道：一条对，一条漏

| 通道 | 上游怎么给 | 插件怎么接 | 结果 |
| --- | --- | --- | --- |
| ✅ **结构化通道** | 单独给 `delta.reasoning_content` 字段 | `wire.ts` 第 160–171 行识别 → 发 `thinking_start/delta/end` → `events.ts` 第 157–165 行翻成 `block-start(reasoning)` / `reasoning-delta` / `block-end(reasoning)` | DSH 单独折叠显示，**正常** |
| ❌ **内联泄漏通道** | 把思考写进普通 `delta.content`，前后加 `<think>` / `</think>` | `wire.ts` 第 174–183 行**当作普通正文**，原样发 `text_start/delta/end` | DSH 当正文渲染 → **思考与正文混在一起** |

### 2.2 混在一起的直接原因

`wire.ts` 第 173–183 行（现状原文）：

```ts
    // content 增量
    if (delta && typeof delta['content'] === 'string' && (delta['content'] as string).length > 0) {
      const textDelta = delta['content'] as string
      if (textIndex < 0) {
        textIndex = content.length
        yield { type: 'text_start', contentIndex: textIndex, partial }
        content.push({ type: 'text', text: '' })
      }
      accumulatedText += textDelta
      yield { type: 'text_delta', contentIndex: textIndex, delta: textDelta, partial }
    }
```

这段代码对 `content` 字段**不做任何语义判别**——字节进来就发 `text_delta`。所以只要上游把思考塞在 `content` 里，它就必然被当作正文。

### 2.3 已有的 `stripThinkLeak` 为什么治不了

| 项 | 事实 |
| --- | --- |
| 函数定义 | `messages.ts` 第 74–77 行，`text.indexOf('</think>')` 取其后部分 |
| **唯一调用点** | `messages.ts` 第 111 行，位于 `toUpstreamBody()` 内 |
| 作用方向 | **发送方向**：把 DSH 历史里的 assistant 文本块清理后再喂给上游 |
| 治不了什么 | **接收方向**：当前这次回答的显示。`wire.ts` 内 0 处剥离逻辑 |

> 一句话：它治的是「别把脏历史再喂回去」，不是「当前回答怎么显示」。

### 2.4 已确认「不是」的原因

| 猜测 | 核实结论 |
| --- | --- |
| DSH 不会折叠思考 | ❌ DSH 契约明确支持：`thinking_*` → `block-start(reasoning)` / `reasoning-delta` / `block-end(reasoning)`（`docs/opencode-free-models-to-dsh.md` 第 430 行；`events.ts` 第 157–165 行已实现该映射） |
| `events.ts` 翻译错 | ❌ 纯翻译层，逐事件映射，无状态、无二次加工；单测 `events.test.ts` 第 30–41 行已验证 thinking → reasoning 块 |
| 适配器二次加工 | ❌ `deveco-adapter.ts` 第 202 行直接 `toStreamChunks(result.events, contextWindow)` 透传，中间无处理 |
| 上游从不给结构化字段 | ❌ 有时给（通道 ✅ 正常）；问题是**不稳定**，同一模型有时走结构化字段、有时写进 `content` |

> 结论：**这不是 DSH 的缺陷，是插件在接收侧少了一道分类。**

### 2.5 工具调用三处缺陷（v5.1 并入，已核实）

| # | 缺陷 | 代码证据 | 后果 |
| --- | --- | --- | --- |
| **T1** | 工具调用块**从未进入**最终 `content` | `wire.ts` 第 108 行 `const toolCalls: DoneMessage['content'] = []` 是独立数组；第 219–223 行 `DoneMessage` 只取 `content`，`toolCalls` 从未合并 | `done.message.content` 里没有 `toolCall`；`events.ts` 第 106 行 `content.some(b => b.type==='toolCall')` 恒 false ⇒ `stop` 且无文本时误判 `EMPTY_RESPONSE` |
| **T2** | 工具调用参数**恒为 `{}`** | `wire.ts` 第 152–155 行 `existing['arguments'] = ((existing['arguments'] ?? {}) as ...)` —— 赋值自身或空对象，`argsDelta` 从未拼入；第 208 行收尾写死 `arguments: {}` | 上游分片传的参数全部丢失；`events.ts` 第 190 行 `JSON.stringify({})` ⇒ DSH 拿到空参数 |
| **T3** | `partial.content` **恒为空数组** | `wire.ts` 第 104 行 `const partial: PartialMessage = { content: [] }` 与第 105 行 `let content = []` 是**两个不同数组**；所有 `content.push` 只进后者 | `events.ts` 第 167 行 `event.partial.content[event.contentIndex]` 恒 `undefined` ⇒ `toolcall_start` 携带的 id/name 为空串 |

### 2.6 块类型命名三套不一致（T1 修复的前置障碍）

| 位置 | 用的名字 | `arguments` 形状 |
| --- | --- | --- |
| `wire.ts` 第 147 行（内部篮子） | `'toolCall'`（**驼峰**） | **无此字段** |
| `events.ts` 第 190 行（发给 DSH） | `'tool-call'`（连字符） | `JSON.stringify(...)` → **字符串** |
| `messages.ts` 第 114 行（读历史） | `'tool-call'`（连字符） | **字符串** |
| `test/events.test.ts` 第 129 行（测试基准） | `'tool-call'`（连字符） | **字符串** |

> **关键**：若只把 `toolCalls` 塞进 `content` 而不改类型名，`messages.ts` 第 114 行 `block.type === 'tool-call'` 依然匹配不上 ⇒ **历史里的工具调用仍会丢失**。故 v5.1 必须先统一命名（§4.8）。
>
> **权威基准**：`'tool-call'` + `arguments` 为 **JSON 字符串**（`events.ts` / `messages.ts` / 测试三方一致，仅 `wire.ts` 内部篮子例外）。

---

## 3. 前置事实（已核实，直接采信）

| 项 | 值 / 证据 |
| --- | --- |
| **全文先落袋** | `wire.ts` 第 65 行 `const rawText = response.text()`、第 85 行 `const raw = await rawText` —— **整个响应体先读完再解析帧**。⇒ 两遍/三遍扫描零成本，无需缓冲技巧 |
| 帧已全部在内存 | `wire.ts` 第 94 行 `const frames = parseSseFrames(raw)` 返回数组 |
| 事件翻译层无状态 | `events.ts` 第 142 行 `toStreamChunks` 逐事件 `switch`，不跨事件保存语义状态 |
| DSH reasoning 契约 | `block-start{blockType:'reasoning'}` / `reasoning-delta{text}` / `block-end{block:{type:'reasoning',text}}` |
| GLM 泄漏形态 | P0 实测：思考写进 `content`，**常见形态是只有闭合标签** `…思考…</think>…正文…`（故 `stripThinkLeak` 只找 `</think>`） |
| 标签字面量 | `<think>`（7 字符）、`</think>`（8 字符） |
| 现有块索引机制 | `textIndex` / `thinkingIndex` 取 `content.length`；`toolCallIndex` 从 `-1` 自增、与 `content` 无关；收尾 `toolcall_end` 又用 `toolCalls.indexOf()` 从 0 数 ⇒ **三套编号**（§4.5 统一） |
| 块类型命名 | 权威 = `'tool-call'`（连字符）+ `arguments` 为 **JSON 字符串**（`events.ts` / `messages.ts` / `test/events.test.ts` 三方一致）；`wire.ts` 内部篮子用 `'toolCall'`（驼峰）且无 `arguments` ⇒ **三套不一致**（§4.8 统一） |
| `arguments` 边界职责 | `wire.ts` 内部是**对象**（供 `events.ts` 用）；`events.ts` 第 190 行 `JSON.stringify` 后发给 DSH 是**字符串** |
| 现有测试 | 9 个测试文件、55 项；`wire.ts` **当前无单测**（`parseUpstreamEvents` 未导出）⇒ v5.1 必须补两类 wire 单测 |

---

## 4. 核心设计

### 4.1 职责边界（本方案的根本立场）

| 环节 | 归属 | 说明 |
| --- | --- | --- |
| **分类**：哪些字节是思考、哪些是正文 | **插件**（`wire.ts`） | 只有插件知道上游模型的怪癖；DSH 不猜文本语义 |
| **翻译**：`thinking_*` → DSH `reasoning` 块 | 插件（`events.ts`，已就绪） | 不改 |
| **渲染**：折叠区、样式、位置 | **DSH** | 不改 |

> 类比：插件是翻译官（负责打标签），DSH 是排版厂（负责按标签排版）。现在的故障是翻译官把思考内容混在正文标签里发出去了。

### 4.2 落点选择：为什么改 `wire.ts`

| 候选落点 | 评估 | 结论 |
| --- | --- | --- |
| **`wire.ts`（接收侧入口）** | 唯一的上游字节入口；全文已在内存，可做全文级判定；改完 `events.ts` 与 adapter 无需动 | ✅ **采用** |
| `events.ts`（翻译层） | 逐事件无状态，要做跨事件语义判定需引入状态机，破坏其"纯翻译"定位 | ❌ |
| `deveco-adapter.ts` | 已在下游，需把已发出的 `text-delta` 重新收拢再拆，等于二次缓冲 | ❌ |
| `messages.ts`（`stripThinkLeak`） | 发送方向，管不了当前回答 | ❌ 保留不动 |

### 4.3 切分算法（精确规则，消除歧义）

对**该响应内所有 `delta.content` 拼接后的全文** `full`（记 `OPEN='<think>'`、`CLOSE='</think>'`）执行：

```
1) closeIdx = full.indexOf(CLOSE)
   若 closeIdx >= 0：
     thinkingRaw = full.slice(0, closeIdx)          // 闭合标签之前的全部内容 = 思考
     textRaw     = full.slice(closeIdx + CLOSE.length)  // 之后 = 正文
2) 否则 openIdx = full.indexOf(OPEN)
   若 openIdx >= 0：                                  // 只有开标签、未闭合
     textRaw     = full.slice(0, openIdx)
     thinkingRaw = full.slice(openIdx + OPEN.length)
3) 否则：thinkingRaw = ''，textRaw = full            // 无标签 → 现状行为
4) 防御性清理：对 textRaw 与 thinkingRaw 各自 replaceAll(OPEN,'') / replaceAll(CLOSE,'')
5) 有标签时（即走了 1 或 2）才修剪：
     thinkingRaw = thinkingRaw.replace(/^\s+/, '').replace(/\s+$/, '')
     textRaw     = textRaw.replace(/^\s+/, '')        // 去掉标签后紧跟的空行
```

**判定优先级**：先看 `CLOSE`（P0 实测的主流形态），再看 `OPEN`。两者都没有则整段为正文（与现状完全一致，零回归）。

### 4.4 与结构化 `reasoning_content` 的优先级（防重复显示）**——已定：丢弃内联**

| 情形 | 规则 |
| --- | --- |
| 本响应**出现过**非空 `delta.reasoning_content` | 结构化通道已承载思考 ⇒ **内联的 `thinkingRaw` 直接丢弃**（它是重复副本），只输出 `textRaw` |
| 本响应**从未**出现 `reasoning_content` | 内联 `thinkingRaw` 作为 reasoning 块输出，`textRaw` 作为正文 |

> 理由：两条通道若同时存在，很可能是同一份思考的重复。宁可少显示一次，也不要折叠区里出现两遍。
> **用户已确认采用本规则**（见 §11.1 决策 D2）。实现要求：`hasStructuredReasoning` 判定必须在**全文第一遍扫描**完成时就得出，早于任何 `thinking_*` 事件发出；若已发出才发现重复，不允许撤回——因此实现上必须先扫全文再发事件。

### 4.5 块索引统一（T1 修复的前置设计）

**现状问题**：`wire.ts` 有**三套互不协调**的编号：
- `textIndex` / `thinkingIndex` 取 `content.length`（推入 `content` 后取值）
- `toolCallIndex` 从 `-1` 自增（**与 `content` 无关**）
- 收尾时 `toolcall_end` 用 `toolCalls.indexOf(toolCall)`（**又从 0 开始**）

⇒ 文本块与工具调用块**必然撞号**，且 `toolCalls` 不进 `content` 导致 `contentIndex` 指向不存在的块。

**v5.1 统一规则（唯一编号源）**：

```
所有块（reasoning / text / tool-call）共用同一个编号源：
  新块编号 = content.length   （推入 content 之前取当前长度）
  推入后 content[编号] = 该块

即：块编号 === 它在 content 数组中的下标。任何时候都成立。
```

**顺序保证**（与 §4.4/§4.5 原设计一致，且工具调用不破坏它）：

```
reasoning 块（若有） → text 块（若有） → tool-call 块（按上游 index 顺序）
```

> 之所以 reasoning 和 text 能"先编号"而 tool-call "后编号"：思考与正文在**主循环中边解析边建块**，而工具调用在**收尾阶段**统一建块。两者都遵循"编号 = content.length"，因此不会撞号。

**块数上限**：reasoning ≤ 1、text ≤ 1（§4.3 只切一刀）、tool-call 可多个（按上游并发数）。

### 4.6 实现方式：预计算「增量操作序列」，不改主循环骨架

主循环**结构保持不变**（tool_calls 分支、usage、finish 判定都在原位），只做三处改造：

```
第一遍（新增）：遍历 frames，累加 delta.content → full；记录 hasStructuredReasoning
第二遍（新增）：对 full 按 §4.3 切分 → thinkingRaw / textRaw；按 §4.4 决定是否丢弃 thinking
第三遍（改）：主循环内把第 159–183 行的两段 if（reasoning / content）替换为
             按预计算片段分发的循环，逐片段走统一编号逻辑（§4.5）
收尾（改）：tool-call 块统一建块（§4.7）+ 累积参数解析
```

绝对区间靠跨帧游标 `consumed` 维护：处理第 k 帧 `content` 前区间为 `[consumed, consumed+len)`，处理完 `consumed += len`。

> 因为全文已在内存（§3），三遍扫描均为纯内存操作，无延迟代价、无标签跨帧问题——**这就是选 `wire.ts` 的技术理由**。

### 4.7 工具调用修复（T1 / T2 / T3）

#### 4.7.1 T2：参数累积与解析

主循环的 tool_calls 分支（现第 135–157 行）保留结构，**新增参数缓冲**：

```
按上游 tool_calls[].index 维护一个缓冲表：Map<number, { id, name, argsText }>
每帧：
  - 若带 id/name 且该 index 首次出现 → 建条目、发 toolcall_start、记录 id/name
  - 若带 arguments 片段 → argsText += 片段（纯字符串拼接，不解析）
  - 发 toolcall_delta（携带片段原文）
收尾时：
  对每个条目：
    args = 尝试 JSON.parse(argsText) → 成功用对象
           失败 → 用 { __raw: argsText }（保留原文，绝不静默丢参）
    建 tool-call 块（§4.8 命名）：{ type:'tool-call', id, name, arguments: JSON.stringify(args) }
    编号 = content.length，推入 content
    发 toolcall_end（arguments 传**已解析对象**，供 events.ts 序列化）
```

> **关键**：`arguments` 在 `toolCalls` 内部（`wire.ts` → `events.ts` 的边界）是**对象**；`events.ts` 第 190 行 `JSON.stringify` 后发给 DSH 是**字符串**。两者职责分明，不要混。

#### 4.7.2 T1：块进入 `content`

收尾阶段在**所有文本/思考块建完之后**，把 tool-call 块按编号推入 `content`（§4.5 统一规则）。这样：
- `done.message.content` 含 `tool-call` 块 ⇒ `events.ts` 第 106 行 `hasContent` 判定正确
- `messages.ts` 第 114 行能读到历史工具调用 ⇒ 多轮工具对话不丢上下文

#### 4.7.3 T3：`partial.content` 同源

将第 104 行改为让 `partial` 与 `content` **指向同一数组**：

```
const content: DoneMessage['content'] = []
const partial: PartialMessage = { content }        // 同一引用，不再各自为政
```

⇒ `events.ts` 第 167 行能正确取到 `partial.content[index]` 的 id/name。

> 副作用评估：`partial` 会随 `content` 一起增长，事件携带的 `partial` 变成"当前累积状态"——这正是 `PartialMessage` 的语义本意，比现状（恒空）更正确。`events.ts` 只读 `toolcall_start` 的 `partial.content[index]`，无其它依赖，安全。

### 4.8 块类型命名统一（T1 的硬前置）

| 位置 | 改为 | 说明 |
| --- | --- | --- |
| `wire.ts` 第 147 行内部篮子 | `{ type: 'tool-call', id, name }` | 由驼峰 `toolCall` 改为连字符 |
| `wire.ts` 收尾建块 | `{ type: 'tool-call', id, name, arguments }` | 同上 |
| `events.ts` | **不动** | 已是 `'tool-call'` |
| `messages.ts` | **不动** | 已是 `'tool-call'` |
| `test/events.test.ts` | **不动** | 已是 `'tool-call'` |

> 统一到 `'tool-call'`（连字符）是**唯一安全选择**：三方已经是它，只有 `wire.ts` 内部篮子例外。反过来统一成驼峰要改 3 处 + 测试，风险更大。

**同时必须改的一处 `events.ts` 依赖**：`events.ts` 第 106 行 `content.some(b => b.type === 'text' || b.type === 'toolCall')` —— 这里的 `'toolCall'` 需改为 `'tool-call'`。这是 §1 说明中"改 `events.ts` 一处"的具体内容，**不是改映射规则**，而是修正类型名笔误。

---

## 5. 完整流程（改完后）

1. 用户发消息 → adapter 组装请求 → `streamChat()` 拿到 `rawText`（全文）。
2. `parseUpstreamEvents()`：
   - **第一遍**：拼接全文、判定是否已有结构化思考（`hasStructuredReasoning`）。
   - **第二遍**：按 §4.3 切出 `thinkingRaw` / `textRaw`；按 §4.4（D2）决定内联思考是否丢弃。
   - **主循环**：tool_calls 分片进参数缓冲（§4.7.1）；思考片段发 `thinking_*`，正文片段发 `text_*`；所有块编号 = `content.length`（§4.5）。
   - **收尾**：参数 `JSON.parse` 成对象 → 建 `'tool-call'` 块 → 推入 `content`（T1）；`partial.content` 与 `content` 同源（T3）。
3. `events.ts`（映射规则不变，仅第 106 行类型名修正）翻译成 DSH 块：`reasoning` → `text` → `tool-call`。
4. DSH 渲染：思考折叠进折叠区、正文干净、工具调用带**完整参数**可执行。
5. 失败/异常：行为与现状完全一致（`error` 事件、`describeUpstreamError` 均不动）。

---

## 6. 具体改动点（文件级）

| 文件 | 动作 | 要点 |
| --- | --- | --- |
| `src/adapter/wire.ts` | **改（核心，逻辑改动集中于此）** | ① 新增导出纯函数 `splitInlineThinking(full): { thinkingRaw, textRaw }`（§4.3）；② `parseUpstreamEvents` 加两遍预计算（§4.6）；③ 主循环内把第 159–183 行两段 `if` 换成按片段分发的循环；④ **T1** 收尾时把 tool-call 块推入 `content`（§4.7.2）；⑤ **T2** 新增参数缓冲 `Map<index,{id,name,argsText}>`，收尾 `JSON.parse`（失败留 `{__raw}`）（§4.7.1）；⑥ **T3** 第 104 行 `partial.content` 与 `content` 同源（§4.7.3）；⑦ **命名** 第 147 行及收尾建块改 `'tool-call'`（§4.8）；⑧ 块编号统一为 `content.length`（§4.5）；⑨ 给 `parseUpstreamEvents` 加 `export`（可测性） |
| `src/adapter/events.ts` | **改（仅 1 行）** | 第 106 行 `b.type === 'toolCall'` → **`'tool-call'`**（类型名笔误修正，见 §4.8）。**映射表一字不动** |
| `test/wire-thinking.test.ts` | **新增** | 思考分离单测：① `splitInlineThinking` 6 类输入；② 假 SSE 端到端事件序列（thinking → text 顺序）；③ 结构化+内联并存不重复（D2） |
| `test/wire-toolcall.test.ts` | **新增** | 工具调用单测：① 参数分片累积后能 `JSON.parse` 成完整对象；② 参数非法 JSON 时降级为 `{__raw}` 不丢参；③ tool-call 块**进入** `done.message.content` 且 `type==='tool-call'`；④ 块编号与文本块不撞号；⑤ `partial.content` 可取到 id/name |
| `package.json` | 改 | `version` → **`0.1.4`（已定 D1）**；其余字段**不动** |

**明确不改**：
- `src/adapter/events.ts` 的**映射规则**（`thinking_*`→`reasoning`、`text_*`→`text`、`toolcall_*`→`tool-call` 全部保留原样；只改第 106 行类型名笔误）
- `src/adapter/messages.ts`（`stripThinkLeak` 保留；第 114 行 `'tool-call'` 本就正确，无需改）
- `src/adapter/deveco-adapter.ts`、`src/catalog.ts`、`src/capacity*.ts`、`src/compaction-policy.ts`、`src/context-guard.ts`、`src/status-bridge.ts`、`src/client/**`、`src/config.ts`、`src/index.ts`
- `tsdown.client.config.ts`、`tsconfig.json`、`cordis.patch.yml`、`scripts/prepare-package.mjs`
- `test/events.test.ts`（基准已用 `'tool-call'`，无需改）
- DSH 侧任何代码（本方案不动宿主）

---

## 7. 职责边界

| 做 | 不做 |
| --- | --- |
| 在接收侧把 `<think>` 内容切出来 | 让 DSH 去猜文本里有没有思考 |
| 内联思考改标为 `reasoning` 块 | 把思考当正文显示 |
| 结构化与内联并存时丢弃重复（D2） | 折叠区里显示两遍思考 |
| 无标签时行为与现状完全一致 | 顺手改动无标签路径 |
| 只切一刀（reasoning ≤1、text ≤1） | 重写块索引机制支持任意交错 |
| 保留发送方向 `stripThinkLeak` | 删掉它（旧会话历史仍需清理） |
| **工具调用块进入 `content`**（T1） | 只发流式事件、最终消息里没有块 |
| **参数分片累积并解析**（T2） | 参数恒为 `{}` |
| **`partial.content` 与 `content` 同源**（T3） | 两个数组各自为政 |
| **块类型统一为 `'tool-call'`**（§4.8） | 三套命名并存 |
| **块编号统一 = `content.length`**（§4.5） | 文本块与工具块撞号 |

---

## 8. 分阶段落地

| 步 | 内容 | 可独立验证 | 估时 |
| --- | --- | --- | --- |
| 1 | `wire.ts` 新增 `splitInlineThinking` 纯函数（§4.3） | 单测：6 类输入各自正确 | 0.3 天 |
| 2 | `wire.ts` 两遍预计算 + 主循环片段分发 + 编号统一（§4.5/§4.6） | 单测：假 SSE 端到端事件序列 | 0.6 天 |
| 3 | `wire.ts` 工具调用修复：T1 入 `content` / T2 参数缓冲 / T3 `partial` 同源 / 命名统一（§4.7/§4.8） | 单测：参数解析、块入 content、不撞号 | 0.5 天 |
| 4 | `events.ts` 第 106 行类型名修正 | `git diff` 仅 1 行 | 0.05 天 |
| 5 | `test/wire-thinking.test.ts` + `test/wire-toolcall.test.ts` | 单测全绿 | 0.4 天 |
| 6 | `package.json` 版本 → `0.1.4`（已定 D1） | JSON 合法、`version` 断言 | 0.05 天 |
| 7 | `typecheck` / `test` / `build` / `build:client` / `pack` | 全套绿（55 + 新增） | 0.2 天 |
| 8 | 重装 0.1.4 + 实机验证：思考折叠 / 正文干净 / **工具调用可执行** | 三条肉眼可验 | 0.4 天 |
| — | **合计** | | **约 2.5 天** |

---

## 9. 验收标准

```powershell
cd D:\dsh-deveco2api\packages\plugin
corepack pnpm typecheck && corepack pnpm test && corepack pnpm build && corepack pnpm run build:client && corepack pnpm pack
```

| # | 检查 | 期望 |
| --- | --- | --- |
| 1 | 全套命令 | 全绿；tgz `dsh-deveco2api-plugin-0.1.4.tgz` |
| 2 | `splitInlineThinking` 单测 | 有开闭 / 仅闭合 / 仅开 / 无标签 / 空串 / 标签后空行，6 类均符合 §4.3 |
| 3 | 端到端事件序列 | 假 SSE `…思考…</think>…正文…` ⇒ 产出 `thinking_start` → `thinking_delta` → `thinking_end` → `text_start` → `text_delta` → `text_end`，且 thinking 内容不含 `</think>` |
| 4 | 防重复（**D2**） | 同时有 `reasoning_content` 与内联标签 ⇒ 思考只出现一次（来自结构化通道），且内联思考**零** `thinking_*` 事件 |
| 5 | 无标签回归 | 无标签输入产出的事件序列与改前**完全一致** |
| 6 | `events.ts` 仅 1 行改动 | `git diff` 中 `events.ts` **只有第 106 行**变化（`'toolCall'`→`'tool-call'`），其余零改动 |
| 7 | **T1 块入 content** | 假 SSE 带 tool_calls ⇒ `done.message.content` 中存在 `{type:'tool-call', id, name, arguments}`，且 `content.some(b=>b.type==='tool-call')` 为真 |
| 8 | **T2 参数完整** | 参数分 3 帧传 `{"city":"北京"}` ⇒ 最终 `arguments` 为完整 JSON 字符串（非 `{}`）；非法 JSON ⇒ 降级 `{"__raw":...}` 不丢参 |
| 9 | **T3 partial 同源** | `toolcall_start` 事件的 `partial.content[index]` 能取到非空 id/name |
| 10 | **编号不撞号** | 文本块编号与 tool-call 块编号互不相同，且均等于其在 `content` 中的下标 |
| 11 | 产物格式 | `lib/client.js` 仍以 `window.__ModuleLoader__.load` 开头 |
| 12 | **版本（D1）** | `package.json` 的 `version === "0.1.4"`；产物名 `dsh-deveco2api-plugin-0.1.4.tgz`；`packages/plugin/` 内无 0.1.3 及更早 tgz |
| 13 | **实机：思考折叠** | 真实对话中思考内容进折叠区，正文区不再出现 `<think>` / `</think>` 字样 |
| 14 | **实机：无标签正常** | 不走标签的模型回答仍正常显示 |
| 15 | **实机：工具调用可执行（已授权）** | 发一次需调用工具的对话 ⇒ DSH 能拿到**正确工具名 + 完整参数**并实际执行，多轮工具对话上下文不丢 |
| 16 | 主链路未回归 | 流式对话仍返回正文 + `finish:stop` |

---

## 10. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 上游把标签切成多帧 | 逐帧判定会误判 | 本方案做**全文级**判定（全文已在内存），天然免疫 |
| 交错标签（正文-思考-正文） | 只切一刀会误分类 | 明确只切一刀（§4.5）；交错形态不在 P0 实测内，若实测出现再单独立项 |
| 结构化与内联并存重复 | 折叠区显示两遍 | §4.4 规则：丢弃内联思考 |
| 正文被误当思考 | 回答内容丢失 | 仅在**出现**标签时才切分；无标签路径零改动 |
| `partial` 引用未更新 | 工具调用 id/name 取不到 | **本方案修**（T3，§4.7.3）：`partial.content` 与 `content` 同源 |
| 工具调用索引与文本块索引撞号 | 块索引冲突、`contentIndex` 指向空块 | **本方案修**（§4.5）：统一编号源 = `content.length` |
| 参数分片拼接后非合法 JSON | 工具调用执行失败 | §4.7.1：`JSON.parse` 失败降级 `{__raw: argsText}`，保留原文不丢参；单测覆盖（验收 #8） |
| 工具调用改动影响面大于思考分块 | 可能导致 DSH 完全无法执行工具 | 已获授权实机验证（D4）；验收 #15 强制要求"正确工具名 + 完整参数 + 实际执行"三条全过 |
| 类型名改动漏改一处 | 历史工具调用丢失 | §4.8 明确列出唯一权威 `'tool-call'`；验收 #6 用 `git diff` 卡住 `events.ts` 仅 1 行 |
| 版本未升导致装了旧内容 | 改动不生效 | **已定升 `0.1.4`**（D1），`add` 即生效；仍建议装后核对 profile 内 `client.js`/`index.js` 哈希与仓库产物一致 |
| 其它标签变体（`<thinking>` 等） | 未覆盖 | 本方案只处理 P0 实测的 `<think>` / `</think>`；变体出现后扩展常量即可 |

---

## 11. 决策记录（已定稿）与不在本方案内

### 11.1 已确认决策（用户 2026-11-06 确认，**不可再改，实现须照此执行**）

| ID | 决策点 | **最终结论** | 实现落点 |
| --- | --- | --- | --- |
| **D1** | 版本号 | **升到 `0.1.4`** | `package.json` 的 `version` 字段 → `"0.1.4"`；产物名 `dsh-deveco2api-plugin-0.1.4.tgz` |
| **D2** | 结构化 `reasoning_content` 与内联 `<think>` 同时存在 | **丢弃内联思考**（只保留结构化通道的思考 + 内联的正文） | `wire.ts` 第一遍全文扫描时置 `hasStructuredReasoning`；为真则 `thinkingRaw` 不产出任何 `thinking_*` 事件，仅 `textRaw` 产出 `text_*` |
| **D3** | 工具调用三处缺陷（T1/T2/T3）是否一起修 | **一起修**（并入 v5.1） | `wire.ts` §4.7 全部；块类型命名统一 §4.8 |
| **D4** | 实机验证工具调用 | **授权**（本会话后续对话请求自动批准） | 验收 #15 必须执行，需发一次带工具的对话 |

**D1 附带要求**：
- 升级后 `dsh plugin add` 即生效（无需 remove），但仍须核对 profile 内 `lib/client.js` / `lib/index.js` 哈希与仓库产物一致。
- 打包后清理旧 tgz（`packages/plugin/` 内只保留 `0.1.4`）。

**D2 附带要求**：
- `hasStructuredReasoning` 必须在**发出任何事件之前**确定（第一遍全文扫描完成），不得"先发思考再发现重复"。
- D2 只影响「内联思考是否输出」，**不影响** `textRaw` 的输出，也不影响无标签路径。

**D3 附带要求**：
- 必须新增 `test/wire-toolcall.test.ts`（现状 `wire.ts` **零单测**）；无测试不得声明修复完成。
- 块编号统一（§4.5）必须先于 T1（工具块入 `content`）实施，否则撞号。
- 类型名统一（§4.8）必须先于 T1，否则 `messages.ts` 读不到历史工具调用。

**D4 附带要求**：
- 实机验证必须覆盖：① 工具名正确；② 参数完整（非 `{}`）；③ DSH 实际执行了工具；④ 多轮工具对话上下文不丢。
- 若实机发现 DSH 另有假设（如要求 `arguments` 为对象而非字符串），以 DSH 实测为准并回写本方案——**此时优先修 `events.ts` 的序列化，不改 `wire.ts` 的契约**。

### 11.2 明确排除

- 不改 DSH 宿主任何代码（渲染归 DSH）
- 不改 `events.ts` 的**映射规则**（仅允许改第 106 行类型名笔误，见 §4.8）
- 不删除 `messages.ts` 的 `stripThinkLeak`
- 不支持交错标签多块、不支持 `<thinking>` 等变体
- 不处理思考内容的样式/折叠交互（DSH 职责）
- 不处理工具调用的 UI 展示样式（DSH 职责）
- **本方案阶段不执行任何实际操作**；重装与实机验证在实现完成后进行（D4 已授权实机验证，但不属方案阶段）

---

## 12. 立即开始的第一步

```powershell
cd D:\dsh-deveco2api\packages\plugin
# 1. wire.ts 新增导出纯函数 splitInlineThinking（§4.3 规则，含 OPEN/CLOSE 常量）
# 2. 新建 test/wire-thinking.test.ts 覆盖 6 类输入
corepack pnpm typecheck && corepack pnpm test
```

**第 1~2 步不通过不进第 3 步。** 先把「纯函数切分」钉死，再动主循环——切分规则一旦确定，主循环改造只是搬运。

**工具调用部分的开工顺序（D3 附带要求，不可颠倒）**：

```
① 块编号统一（§4.5）           ← 必须最先，否则后续撞号
② 类型名统一 'tool-call'（§4.8） ← 必须先于 T1，否则 messages.ts 读不到
③ T2 参数缓冲 + JSON.parse     ← 独立可测
④ T1 工具块推入 content        ← 依赖 ①②
⑤ T3 partial 同源              ← 独立可测
⑥ events.ts 第 106 行类型名修正 ← 与 ② 同一逻辑的两端
⑦ test/wire-toolcall.test.ts   ← 每步都补测，最后统一跑
```

> 为什么 ①② 必须在前：T1 把工具块塞进 `content` 后，编号和类型名就是"公共契约"了。先塞后改，等于让后续所有代码都基于错的契约写，返工成本更高。

---

> **本文是方案，不是执行结果。当前处于方案设计阶段，未做任何实际操作（未改代码、未重装、未动 profile）。**
