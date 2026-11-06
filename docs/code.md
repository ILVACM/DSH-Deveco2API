# dsh-deveco2api GUI v4 —— 代码修改实施方案（code.md）

> 版本：v3.0（重写，替代 v2.0「Plugins 页 KEYED 槽」方案）
> 日期：2026-11-06
> 上游方案：[docs/plan.md](./plan.md)（v4.0）
> 代码根目录：`D:\dsh-deveco2api\packages\plugin`（下文相对路径均相对此目录，除非显式写绝对路径）
> 本文性质：**方案设计阶段文档，不含任何已执行操作**。本文是给「多 agent 协作执行」用的施工图。
> 设计目标：**无论使用何种模型、更换何种 agent 软件，只要严格按本文操作，得到的文件树与代码结果完全一致。**

---

## 0. 执行者必读（消除歧义的硬规则）

### 0.1 绝对规则（违反即视为执行错误）

1. **只改本文 §1 明确列出的文件**。其余一律不动，尤其：`src/adapter/*`、`src/auth/*`、`src/capacity.ts`、`src/compaction-policy.ts`、`src/context-guard.ts`、`src/catalog.ts`、`tsdown.client.config.ts`、`tsconfig.json`、`scripts/prepare-package.mjs`、`cordis.patch.yml`、`docs/*`。
2. **所有写入必须幂等**：每任务开始前先 `read` 目标文件，符合本文给定内容则跳过，不符合则覆盖，不存在则新建。
3. **语言/风格**：TypeScript，ESM，单引号，2 空格缩进，无分号。禁止 `enum` / `namespace` / 构造函数参数属性。
4. **导入约定**：相对导入带 `.ts` 后缀；类型导入用 `import type`；**不 import 任何 `@deepseek-ai/*` 运行时类型**（结构性声明宿主契约）。客户端可用 `react` 与 `./locales.ts` / `./constants.ts` / `./CapacityCard.tsx` / `./icon.tsx`。
5. **不新增/删除依赖**：`dependencies` / `devDependencies` 保持现状（`react` / `@types/react` 已装）。只改 `dsh.client.inject` 数组与 `version`。
6. **客户端产物格式绝不改**：`tsdown.client.config.ts` 的 CJS closure-factory（`window.__ModuleLoader__.load`）已验证正确。
7. **所有新代码自带降级**：`slots` / `webServer` / `catalog` 取不到时只记日志或显示降级态，**绝不阻断模型路由与对话**。
8. **禁止执行**：`dsh plugin add/remove`、重启 DSH、改 `~/.dsh/profiles/*`、发真实探测请求。本方案只产出代码与单测；`typecheck`/`test`/`build`/`build:client`/`pack` 由集成 agent 统一执行（§6）。**重装与实机验证需用户另行明确授权。**

### 0.2 固定命名与常量（全局唯一，禁止各任务自行命名）

| 项 | 固定值 |
| --- | --- |
| 包名 | `dsh-deveco2api-plugin` |
| **设置分区 id（本次新增，关键）** | `deveco2dsh` |
| 分区槽名 | `settings.section` |
| 分区图标槽名 | `settings.section.icon` |
| 分区排序 | `order: 35` |
| locale 命名空间 | `deveco2dsh` |
| API 前缀 | `/plugins/dsh-deveco2api-plugin` |
| 4 个端点 | `.../status`(GET) / `.../probe`(POST) / `.../compact`(POST) / `.../refresh-models`(POST) |
| 探测正则 | `/maximum context length is (\d+) tokens/` |
| 新版本号 | `0.1.3` |
| 探测起点 | `floor(suggested × 1.15)` |
| 步长 | `+8%`（每步 `max(10000, cur*0.08)`） |
| 步间隔 | `≥ 20000 ms` |
| 限流退避 | `30s→60s`，同一步最多重试 **3** 次 |
| 手动探测总超时 | `90_000 ms` |

### 0.3 前置核验（集成 agent 派发前逐条确认，任一不满足则停止报告）

1. `node --version` ≥ 22；`corepack --version` 可用。
2. `package.json` 当前 `version === "0.1.2"`、`name === "dsh-deveco2api-plugin"`。
3. `corepack pnpm typecheck` 当前 **EXIT 0**（基线不破）。
4. `react` 可解析（`node -e "require.resolve('react')"`）；失败则 `corepack pnpm install`。
5. **多 agent 协作能力**：本环境为 Agent Teams（Lead + `spawn_teammate` + 共享工作目录 + 任务板）。集成 agent 必须用 `spawn_teammate` 派生工作者，不得自己串行写完。
6. **写作用域隔离**：见 §4；任意两个并行任务写文件路径集合**必须不相交**；`package.json` 由集成 agent 独占。

### 0.4 多 agent 协作模式（强制引导）

```
Lead / 集成 agent
  ├─ 先做 §0.3 前置核验 → 建任务板（team_task_create），按 §4 依赖图切「可并行」组。
  ├─ 用 spawn_teammate 派生 3 个工作者：agent-ui / agent-probe / agent-test。
  │   每人：认领任务 → 只写自己作用域文件 → team_task_update(complete) + send_message 汇报。
  │   工作者之间禁止互写对方文件；需要对方常量/接口，以 §2「共享契约」为准，不读对方未提交代码。
  ├─ 集成 agent 独占：package.json / src/index.ts / src/config.ts / src/status-bridge.ts 接缝（见 §4）。
  └─ 全部完成后集成 agent 执行 §6 验收；失败把具体失败点发回对应工作者修正。
```

**环境能力保证**：本会话已确认具备 Agent Teams（Lead + `spawn_teammate` + 共享工作目录 + 任务板）。若换到不支持 teammate 的 agent 软件，等价做法：把 §4 的 3 个「写作用域」当作 3 个独立子任务并行下发（subagent / workflow 均可），只要满足「写文件互不相交 + 共享契约固定 + 集成阶段统一验收」。**产物文件树与代码完全一致**。

---

## 1. 目标文件树（最终形态，逐文件核对）

```
packages/plugin/
├─ package.json                          [改] 集成 agent 独占（version + dsh.client.inject）
├─ src/
│  ├─ config.ts                          [改] 集成 agent 独占（+capacityAutoProbe）
│  ├─ status-bridge.ts                   [改] 集成 agent 独占（/probe 同步返回快照 + probing）
│  ├─ index.ts                           [改] 集成 agent 独占（删启动即探测 / onProbe 接 probeNow）
│  ├─ capacity-probe.ts                  [改] agent-probe（新增 probeNow）
│  └─ client/
│     ├─ constants.ts                    [改] agent-ui（换设置分区常量）
│     ├─ index.ts                        [改] agent-ui（settings.section + icon）
│     ├─ CapacityCard.tsx                [改] agent-ui（四态 + 检查 res.ok + 直接渲染返回）
│     ├─ icon.tsx                        [新增] agent-ui
│     └─ locales.ts                      [改] agent-ui（+4 条新文案）
└─ test/
   ├─ client-slots.test.ts               [改] agent-test（断言 settings.section，无 plugins.*）
   ├─ status-bridge.test.ts              [改] agent-test（/probe 同步返回快照）
   └─ capacity-probe.test.ts             [新增] agent-test（probeNow 逼近/退避/降级）
```

> §1 未列出的文件，任何 agent 不得创建或修改。

---

## 2. 共享契约（各 agent 共同依赖的精确接口，禁止自行改名）

### 2.1 `src/client/constants.ts` 导出（agent-ui 产出）

```ts
export const PKG = 'dsh-deveco2api-plugin'
export const API_BASE = `/plugins/${PKG}`
export const SETTINGS_SECTION_ID = 'deveco2dsh'
export const SLOT_SECTION = 'settings.section'
export const SLOT_SECTION_ICON = 'settings.section.icon'
export const SETTINGS_ORDER = 35
```

> **移除** v2 的 `SLOT_BUNDLE` / `SLOT_ROW` / `SLOT_ITEM` / `BUNDLE_KEY` / `ROW_KEY`（`plugins.*` 槽不再使用）。

### 2.2 `src/capacity-probe.ts` 新契约（agent-probe 产出）

```ts
export interface ProbeNowDeps {
  getAccess: () => Promise<string | null>
  fetchImpl?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** 每次拿到确定结果（成功或终态失败）后回调，便于逐步落盘。 */
  onResult?: (modelId: string, result: { actualMax: number; source: 'probe' | 'fallback' | 'error'; measuredAt: string; error?: string }) => void
}
export interface ProbeNowOptions {
  /** 每步间隔毫秒，默认 20000 */
  stepGapMs?: number
  /** 单模型总超时，默认 90000 */
  totalTimeoutMs?: number
  /** 同一步限流重试上限，默认 3 */
  maxRetriesPerStep?: number
}
/** 温和逼近：从 suggested×1.15 起逐步加长，命中上限即停；串行、限流退避。 */
export async function probeNow(
  modelIds: string[],
  suggested: Record<string, number>,
  deps: ProbeNowDeps,
  opts?: ProbeNowOptions,
): Promise<Array<{ id: string; actualMax: number; source: 'probe' | 'fallback' | 'error'; measuredAt: string; error?: string }>>
```

`parseMaxContext` / `probeActualMax` / `refreshAllCapacities` / `createProbeScheduler` **保留**（`createProbeScheduler` 仅作可选自动探测，默认不启动）。

**`probeNow` 唯一正确算法（照此实现，不得改数值）**：

```
对每个 modelId（串行）：
  target = floor(suggested[modelId] × 1.15)       // 起点
  循环（直到命中 / 超时 / 重试耗尽）：
    构造 content = 长度约 target token 的随机词序列（复用现有 words 生成方式）
    发 POST URL_CHAT，body 同现有（model/stream:true/max_tokens:8），超时 60s
    text = await res.text()
    n = parseMaxContext(text)
    若 n !== null → 记录 { actualMax:n, source:'probe' }，跳出循环
    若 text 含 UserSessionLimitExceeded 或 429 → 退避 30s/60s 后重试同一步（≤3 次）
    若 text 含其他错误 / 抛异常 → 记录 { actualMax:0, source:'error', error:文案 }，跳出
    未命中且无错误 → target = target + max(10000, floor(target*0.08))，sleep(stepGapMs)，继续
  每模型结束调用 deps.onResult(modelId, result)
  模型之间 sleep(stepGapMs)
总超时 totalTimeoutMs 到达 → 未完成的模型记 { source:'error', error:'probe timeout' }
```

### 2.3 `src/status-bridge.ts` 新契约（集成 agent）

```ts
export interface BridgeDeps {
  getSnapshot: () => StatusSnapshot
  /** 手动探测：返回**最终快照**（同步等待完成），而非 {ok:true} */
  onProbe: () => Promise<StatusSnapshot>
  onCompact: () => Promise<{ ok: boolean; message: string }>
  onRefreshModels: () => Promise<StatusSnapshot>
}
```

`/probe` 与 `/refresh-models` 的响应体为**完整 `StatusSnapshot`**（含 `models` / `probing` / `measuredAt`）。
`StatusSnapshot` 增加 `measuredAt: string`（取 `capacity.updatedAt`）。

### 2.4 `src/config.ts` 新增字段（集成 agent）

```ts
capacityAutoProbe?: boolean   // 默认 false
```
`capacityProbeIntervalSeconds` 语义改为「自动探测间隔（仅 capacityAutoProbe=true 时生效），最低 86400」。

### 2.5 服务端与客户端 API 一致性

服务端 `status-bridge.ts` 内**自写** `const API_BASE = '/plugins/dsh-deveco2api-plugin'`（不 import 客户端 constants），客户端用 `\`/plugins/${PKG}\``。单测静态断言二者相等。

---

## 3. 精确改动点

> 标 `[覆盖]` = 直接 `write` 完整内容（见 §5）；标 `[替换]` = `edit` 文本级替换（old_string 必须唯一，见 §3.9）。

### T0 — `package.json`（集成 agent 独占，两处替换）

替换 1 —— 版本：
```
old:  "version": "0.1.2",
new:  "version": "0.1.3",
```

替换 2 —— `dsh.client.inject`（整行）：
```
old:
      "inject": ["@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-client-ui-slots", "@deepseek-ai/dsh-client-ui-settings-plugins", "@deepseek-ai/dsh-client-locale"],

new:
      "inject": ["@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-client-ui-slots", "@deepseek-ai/dsh-client-locale"],
```
> 去掉 `ui-settings-plugins`（不再挂 Plugins 页）。`ui-plugin-manager` 本就不在。

### T1 — `src/config.ts`（集成 agent，三处替换）

替换 1 —— 接口加字段（在 `uiEnableManualCompact?: boolean` 后）：
```
old:  uiEnableManualCompact?: boolean
}
new:  uiEnableManualCompact?: boolean
  capacityAutoProbe?: boolean
}
```

替换 2 —— defaults 加默认值（在 `uiEnableManualCompact: true,` 后）：
```
old:  uiEnableManualCompact: true,
}
new:  uiEnableManualCompact: true,
  capacityAutoProbe: false,
}
```

替换 3 —— Schema 加字段（在 `uiEnableManualCompact` 那行后）：
```
old:  uiEnableManualCompact: Schema.boolean().default(defaults.uiEnableManualCompact).description('「立即压缩上下文」按钮是否可用，默认 true'),
})
new:  uiEnableManualCompact: Schema.boolean().default(defaults.uiEnableManualCompact).description('「立即压缩上下文」按钮是否可用，默认 true'),
  capacityAutoProbe: Schema.boolean().default(defaults.capacityAutoProbe).description('是否启用自动探测（默认 false，仅人工刷新）'),
})
```

替换 4 —— `capacityProbeIntervalSeconds` 描述改为自动探测语义：
```
old:  capacityProbeIntervalSeconds: Schema.number().default(defaults.capacityProbeIntervalSeconds).min(60).max(604800).description('探测② 周期性刷新间隔（秒），默认 86400'),
new:  capacityProbeIntervalSeconds: Schema.number().default(defaults.capacityProbeIntervalSeconds).min(86400).max(604800).description('自动探测间隔（秒，仅 capacityAutoProbe=true 时生效），默认 86400'),
```

### T2 — `src/index.ts`（集成 agent，三处替换）

替换 1 —— 删除启动即 `scheduler.start()`，改为仅在 `capacityAutoProbe` 为真时启动：
```
old:    scheduler.start()
new:    if (resolved.capacityAutoProbe) scheduler.start()
```

替换 2 —— `onProbe` 改接 `probeNow`（整块替换，含 `onRefreshModels` 返回快照）：
```
old:
        onProbe: async () => { if (scheduler) await scheduler.trigger() },
        onCompact: async () => manualCompact(services, compactState),
        onRefreshModels: async () => { await catalog.refreshNow() },
new:
        onProbe: async () => {
          // 手动探测：同步等待 probeNow 完成，逐步落盘，返回最终快照
          if (catalog.list().length === 0) {
            logger.warn('deveco2dsh: 目录尚未就绪，手动探测已跳过')
            return snapshot()
          }
          const results = await probeNow(
            catalog.list().map((m) => m.id),
            catalog.suggestedMap,
            {
              getAccess: async () => { const r = await ensureValidToken(); return r.ok ? r.access : null },
              onResult: (id, r) => {
                capacityFile = {
                  schema: 'capacity/v1',
                  updatedAt: new Date().toISOString(),
                  models: { ...capacityFile.models, [id]: { suggested: catalog.suggestedMap[id] ?? 0, actualMax: r.actualMax, measuredAt: r.measuredAt, source: r.source === 'error' ? 'fallback' : r.source } },
                }
                persist()
              },
            },
          )
          void results
          persist()
          applyModelPolicies()
          return snapshot()
        },
        onCompact: async () => manualCompact(services, compactState),
        onRefreshModels: async () => { await catalog.refreshNow(); return snapshot() },
```

替换 3 —— `getSnapshot` 改为复用内部 `snapshot()`（整块替换 getSnapshot 定义，并在其上定义 `snapshot`）：
```
old:
        getSnapshot: () => {
          let used: number | null = null
          try { const m = services.tokenMeter?.measure(resolveActiveSession()); if (m && typeof m === 'object' && 'totalTokens' in m) used = (m as { totalTokens: number }).totalTokens } catch { used = null }
          return buildSnapshot({
            catalogModels: catalog.list().map((m) => ({ id: m.id, name: m.name, contextWindow: m.contextWindow })),
            capacity: capacityFile,
            used,
            probing: false,
            compacting: compactState.compacting,
            lastCompactedAt: compactState.lastCompactedAt,
          })
        },
new:
        getSnapshot: () => snapshot(),
```
并在装配块内（`registerStatusBridge` 调用之前）新增：
```ts
    const snapshot = (): StatusSnapshot => {
      let used: number | null = null
      try { const m = services.tokenMeter?.measure(resolveActiveSession()); if (m && typeof m === 'object' && 'totalTokens' in m) used = (m as { totalTokens: number }).totalTokens } catch { used = null }
      return buildSnapshot({
        catalogModels: catalog.list().map((m) => ({ id: m.id, name: m.name, contextWindow: m.contextWindow })),
        capacity: capacityFile,
        used,
        probing: false,
        compacting: compactState.compacting,
        lastCompactedAt: compactState.lastCompactedAt,
        measuredAt: capacityFile.updatedAt,
      })
    }
```
新增 import：
```ts
import { probeNow } from './capacity-probe.ts'
import type { StatusSnapshot } from './status-bridge.ts'
```
> 注意：`buildSnapshot` 的 `StatusInput` 需新增 `measuredAt`（由集成 agent 在 status-bridge 内一并加，见 §5.4）。

### T3 — `src/status-bridge.ts`（集成 agent，`[覆盖]` 见 §5.4）

### T4 — `src/capacity-probe.ts`（agent-probe，`[替换]` 在文件末尾追加 `probeNow`，见 §5.5）

### T5 — `src/client/constants.ts`（agent-ui，`[覆盖]` 见 §5.1）

### T6 — `src/client/index.ts`（agent-ui，`[覆盖]` 见 §5.2）

### T7 — `src/client/icon.tsx`（agent-ui，新增，`[覆盖]` 见 §5.3）

### T8 — `src/client/CapacityCard.tsx`（agent-ui，`[覆盖]` 见 §5.6）

### T9 — `src/client/locales.ts`（agent-ui，`[替换]` 追加 4 条文案，见 §5.7）

### T10 — 三个测试文件（agent-test，`[覆盖]` 见 §5.8 / §5.9 / §5.10）

### 3.9 old_string 唯一性核验表（集成 agent 派发前逐条验证）

| 替换 | 文件 | old_string 关键片段 | 期望命中 |
| --- | --- | --- | --- |
| T0-1 | package.json | `"version": "0.1.2",` | 1 |
| T0-2 | package.json | `"inject": ["@deepseek-ai/dsh-client-ui-settings", ...]` 整行 | 1 |
| T1-1 | src/config.ts | `  uiEnableManualCompact?: boolean` + 下一行 `}` | 1 |
| T1-2 | src/config.ts | `  uiEnableManualCompact: true,` + 下一行 `}` | 1 |
| T1-3 | src/config.ts | `uiEnableManualCompact: Schema.boolean()...` 整行 + `})` | 1 |
| T1-4 | src/config.ts | `capacityProbeIntervalSeconds: Schema.number()...` 整行 | 1 |
| T2-1 | src/index.ts | `    scheduler.start()` | 1 |
| T2-2 | src/index.ts | `        onProbe: async () => { if (scheduler) await scheduler.trigger() },` 起三行 | 1 |
| T2-3 | src/index.ts | `        getSnapshot: () => {` 起的整块 | 1 |

任一不是 1 → 停止报告，不得猜测改写。

---

## 4. 并行切分与写作用域（强制，任务板依赖图）

### 4.1 三个并行工作者 + 一个集成 agent

| 任务 ID | 工作者 | 写作用域（**独占，禁止交叉**） | 依赖 |
| --- | --- | --- | --- |
| `task-ui` | agent-ui | `src/client/constants.ts`、`src/client/index.ts`、`src/client/icon.tsx`、`src/client/CapacityCard.tsx`、`src/client/locales.ts` | 按 §2.1 契约文本编码 |
| `task-probe` | agent-probe | `src/capacity-probe.ts` | 按 §2.2 契约文本编码 |
| `task-test` | agent-test | `test/client-slots.test.ts`、`test/status-bridge.test.ts`、`test/capacity-probe.test.ts` | 只依赖 §2 契约文本，不读实际源文件 |
| `task-seam` | 集成 agent（Lead） | `package.json`、`src/config.ts`、`src/index.ts`、`src/status-bridge.ts` | 依赖前 3 个任务完成 |

### 4.2 依赖图

```
[起点] ─┬─→ task-ui ────┐
        ├─→ task-probe ─┼─→ task-seam（全部完成后）─→ [验收 §6]
        └─→ task-test ──┘
```

`task-seam` 的 `blocked_by` = 三个任务 id。

### 4.3 并行执行指令（给集成 agent 的精确动作序列）

1. `team_task_create` 四个任务（按 §4.1 subject/description/写作用域）。
2. `spawn_teammate` 派生 3 个工作者 `agent-ui` / `agent-probe` / `agent-test`，每人 prompt **原样附上** §0 硬规则 + §2 共享契约 + 对应 §5 代码。prompt 必须自包含。
3. 三个工作者只写自己作用域文件，完成后 `team_task_update(complete)` + `send_message` 汇报。
4. 集成 agent 等三个 `completed`（`wait_agent`），再独占改 `package.json` / `config.ts` / `index.ts` / `status-bridge.ts`（§3-T0/T1/T2/T3）。
5. 执行 §6 验收。

### 4.4 环境能力保证

- Agent Teams 环境下：Lead 用 `spawn_teammate` / `team_task_*` / `send_message` / `wait_agent`（本会话已核实可用）。
- 无 teammate 的软件：把 §4.1 三个写作用域当 3 个独立 `subagent` 并行下发，集成阶段主 agent 串行做 `task-seam`。**产物完全一致**。
- **注意**：若 teammate 名额已满（上限 8），用 `subagent` 工具并行下发等价任务；写作用域与 prompt 完全相同。已实测可用。

---

## 5. 各任务完整代码内容（agent 直接照抄写入）

### 5.1 `src/client/constants.ts`（agent-ui `[覆盖]`）

```ts
/** GUI 客户端固定常量：包名 / API 前缀 / 设置分区槽。@module src/client/constants.ts */
export const PKG = 'dsh-deveco2api-plugin'
export const API_BASE = `/plugins/${PKG}`
export const SETTINGS_SECTION_ID = 'deveco2dsh'
export const SLOT_SECTION = 'settings.section'
export const SLOT_SECTION_ICON = 'settings.section.icon'
export const SETTINGS_ORDER = 35
```

### 5.2 `src/client/index.ts`（agent-ui `[覆盖]`）

```ts
/** 客户端入口：把配置面板注册到 DSH「设置」的 settings.section。不 import 宿主类型。 */
import { NS, messages } from './locales.ts'
import { CapacityCard } from './CapacityCard.tsx'
import { PluginIcon } from './icon.tsx'
import { PKG, SETTINGS_SECTION_ID, SLOT_SECTION, SLOT_SECTION_ICON, SETTINGS_ORDER } from './constants.ts'

interface ClientCtx {
  effect?(fn: () => () => void): unknown
  inject?(services: string[], cb: (ctx: ClientFormCtx) => void | Promise<void>): unknown
  locale?: { register(ns: string, data: unknown): unknown }
  slots?: {
    register(spec: Record<string, unknown>, component: unknown): unknown
    inject(name: string, cb: () => unknown): unknown
  }
}
interface ClientFormCtx {
  effect?(fn: () => () => void): unknown
}

const t = messages.zh

/** 注册设置分区 + 同 id 的图标（shell 用 { only: row.id } 匹配）。 */
function registerSettingsSection(ctx: ClientCtx): void {
  try {
    const slots = ctx.slots
    if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return
    slots.inject(SLOT_SECTION, () => slots.register({
      name: SLOT_SECTION,
      id: SETTINGS_SECTION_ID,
      order: SETTINGS_ORDER,
      label: () => t.title,
      locale: NS,
      inject: () => ({ t }),
    }, CapacityCard))
    slots.inject(SLOT_SECTION_ICON, () => slots.register({
      name: SLOT_SECTION_ICON,
      id: SETTINGS_SECTION_ID,
      locale: NS,
    }, PluginIcon))
  } catch (error) {
    console.error(`[${PKG}] settings section failed to register:`, error)
  }
}

export default {
  inject: ['slots', 'locale'] as const,
  apply(ctx: ClientCtx): void {
    if (ctx.effect && ctx.locale) {
      ctx.effect(() => {
        ctx.locale!.register(NS, { en: messages.en, zh: messages.zh })
        return () => {}
      })
    }
    registerSettingsSection(ctx)
  },
}
export { CapacityCard, PluginIcon }
export { PKG, SETTINGS_SECTION_ID, SLOT_SECTION, SLOT_SECTION_ICON, SETTINGS_ORDER }
```

### 5.3 `src/client/icon.tsx`（agent-ui 新增）

```tsx
/** 设置分区图标：16px 简约 SVG，接收 { size, active }。 */
import * as React from 'react'

export function PluginIcon(props: { size?: number; active?: boolean }): React.ReactElement {
  const size = typeof props?.size === 'number' ? props.size : 16
  return React.createElement('svg', {
    width: size, height: size, viewBox: '0 0 16 16',
    fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
  },
  React.createElement('rect', { x: 2, y: 3, width: 12, height: 8, rx: 1.5 }),
  React.createElement('path', { d: 'M4 14h8' }))
}
export default PluginIcon
```

### 5.4 `src/status-bridge.ts`（集成 agent `[覆盖]`）

```ts
/**
 * GUI 数据桥：聚合 catalog + capacity + 占用 的只读快照；注册 4 个 action。
 * /probe 与 /refresh-models 同步返回完整快照（不再 fire-and-forget）。
 * 路由挂在 /plugins/<包名>/ 前缀下，Desktop forwarder 才会转发。
 * @module src/status-bridge.ts
 */
import { effectiveSuggested, type CapacityFile } from './capacity.ts'

/** 服务端自写常量：与客户端 constants.ts 的 API_BASE 值相等，但不跨端 import。 */
const API_BASE = '/plugins/dsh-deveco2api-plugin'

export interface StatusSnapshot {
  models: Array<{
    id: string; name: string; effectiveSuggested: number; actualMax: number
    source: string; measuredAt: string; similar: boolean
  }>
  occupancy: { used: number; contextWindow: number } | null
  probing: boolean
  compacting: boolean
  lastCompactedAt: number
  capacityReady: boolean
  measuredAt: string
}
export interface StatusInput {
  catalogModels: Array<{ id: string; name: string; contextWindow: number }>
  capacity: CapacityFile
  used: number | null
  probing: boolean
  compacting: boolean
  lastCompactedAt: number
  measuredAt: string
}

export function buildSnapshot(input: StatusInput): StatusSnapshot {
  const models = input.catalogModels.map((m) => {
    const c = input.capacity.models[m.id]
    const suggested = m.contextWindow
    const actualMax = c?.actualMax ?? 0
    return {
      id: m.id,
      name: m.name,
      effectiveSuggested: c ? effectiveSuggested(suggested, actualMax) : suggested,
      actualMax,
      source: c?.source ?? 'none',
      measuredAt: c?.measuredAt ?? '',
      similar: c ? suggested >= actualMax * 0.9 : false,
    }
  })
  return {
    models,
    occupancy: input.used === null ? null : { used: input.used, contextWindow: Math.max(...models.map((m) => m.effectiveSuggested), 0) },
    probing: input.probing,
    compacting: input.compacting,
    lastCompactedAt: input.lastCompactedAt,
    capacityReady: Object.keys(input.capacity.models).length > 0,
    measuredAt: input.measuredAt,
  }
}

export interface BridgeContext {
  webServer?: {
    register(spec: {
      kind: 'exact'
      path: string
      handler: (req: unknown, res: unknown) => unknown
    }): unknown
  }
}
export interface BridgeDeps {
  getSnapshot: () => StatusSnapshot
  onProbe: () => Promise<StatusSnapshot>
  onCompact: () => Promise<{ ok: boolean; message: string }>
  onRefreshModels: () => Promise<StatusSnapshot>
}

/** 宿主真实 API：kind:'exact' + (req,res) 两参 handler。 */
function json(res: unknown, status: number, body: unknown): void {
  const r = res as { writeHead?(s: number, h: Record<string, string>): void; end?(s: string): void }
  if (typeof r?.writeHead === 'function' && typeof r?.end === 'function') {
    r.writeHead(status, { 'content-type': 'application/json' })
    r.end(JSON.stringify(body))
  }
}

function isLoopback(req: unknown): boolean {
  const r = req as { socket?: { remoteAddress?: string } }
  const addr = r?.socket?.remoteAddress ?? ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr === ''
}

export function registerStatusBridge(ctx: BridgeContext, deps: BridgeDeps): void {
  if (!ctx.webServer || typeof ctx.webServer.register !== 'function') return
  const send = (req: unknown, res: unknown, fn: () => void): void => {
    if (!isLoopback(req)) { json(res, 403, { error: 'forbidden' }); return }
    try { fn() } catch (error) { json(res, 500, { error: error instanceof Error ? error.message : String(error) }) }
  }
  ctx.webServer.register({
    kind: 'exact',
    path: `${API_BASE}/status`,
    handler: (req, res) => send(req, res, () => json(res, 200, deps.getSnapshot())),
  })
  ctx.webServer.register({
    kind: 'exact',
    path: `${API_BASE}/probe`,
    handler: (req, res) => send(req, res, () => {
      void deps.onProbe().then((snap) => json(res, 200, snap)).catch((e) => json(res, 500, { error: String(e) }))
    }),
  })
  ctx.webServer.register({
    kind: 'exact',
    path: `${API_BASE}/compact`,
    handler: (req, res) => send(req, res, () => {
      void deps.onCompact().then((r) => json(res, 200, r)).catch((e) => json(res, 500, { error: String(e) }))
    }),
  })
  ctx.webServer.register({
    kind: 'exact',
    path: `${API_BASE}/refresh-models`,
    handler: (req, res) => send(req, res, () => {
      void deps.onRefreshModels().then((snap) => json(res, 200, snap)).catch((e) => json(res, 500, { error: String(e) }))
    }),
  })
}
```

### 5.5 `src/capacity-probe.ts`（agent-probe：在文件末尾追加 `probeNow`）

> **不修改现有任何函数**（`parseMaxContext` / `probeActualMax` / `refreshAllCapacities` / `createProbeScheduler` 全部保留原样）。只在文件末尾追加以下代码。

```ts
/** 手动探测选项。 */
export interface ProbeNowOptions {
  stepGapMs?: number
  totalTimeoutMs?: number
  maxRetriesPerStep?: number
}
export interface ProbeNowDeps {
  getAccess: () => Promise<string | null>
  fetchImpl?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  onResult?: (modelId: string, result: { actualMax: number; source: 'probe' | 'fallback' | 'error'; measuredAt: string; error?: string }) => void
}
export interface ProbeNowResult {
  id: string
  actualMax: number
  source: 'probe' | 'fallback' | 'error'
  measuredAt: string
  error?: string
}

const RATE_LIMIT_RE = /UserSessionLimitExceeded|New session request rate exceeded|\b429\b|rate.?limit/i

/** 构造约 targetTokens 规模的随机词内容（与 probeActualMax 同一生成方式）。 */
function buildProbeContent(targetTokens: number): string {
  const count = Math.max(1, Math.floor(targetTokens / 3.5))
  const words = Array.from({ length: count }, (_, i) => 'w' + (i * 7919 % 100003))
  return words.join(' ') + '\n只回复：OK'
}

/**
 * 手动探测：温和逼近 + 限流退避 + 逐步回调。
 * 从 floor(suggested×1.15) 起，每步 +max(10000, 8%)，命中上限即停；串行、绝不并发。
 */
export async function probeNow(
  modelIds: string[],
  suggested: Record<string, number>,
  deps: ProbeNowDeps,
  opts: ProbeNowOptions = {},
): Promise<ProbeNowResult[]> {
  const stepGapMs = opts.stepGapMs ?? 20_000
  const totalTimeoutMs = opts.totalTimeoutMs ?? 90_000
  const maxRetriesPerStep = opts.maxRetriesPerStep ?? 3
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const fetchImpl = deps.fetchImpl ?? fetch
  const access = await deps.getAccess()
  const out: ProbeNowResult[] = []

  for (const id of modelIds) {
    const startedAt = now()
    let target = Math.floor((suggested[id] ?? 170000) * 1.15)
    let done: ProbeNowResult | null = null
    while (done === null) {
      if (now() - startedAt > totalTimeoutMs) {
        done = { id, actualMax: 0, source: 'error', measuredAt: new Date(now()).toISOString(), error: 'probe timeout' }
        break
      }
      if (!access) {
        done = { id, actualMax: 0, source: 'error', measuredAt: new Date(now()).toISOString(), error: 'not logged in' }
        break
      }
      let retries = 0
      let text = ''
      let threw: string | null = null
      while (retries <= maxRetriesPerStep) {
        try {
          const res = await fetchImpl(URL_CHAT, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${access}`,
              'Chat-Id': cryptoRandom(),
              'Session-Id': cryptoRandom(),
              lang: 'en',
            },
            body: JSON.stringify({
              model: id,
              messages: [{ role: 'user', content: buildProbeContent(target) }],
              stream: true,
              max_tokens: 8,
            }),
            signal: AbortSignal.timeout(60_000),
          })
          text = await res.text()
          if (RATE_LIMIT_RE.test(text) && retries < maxRetriesPerStep) {
            retries += 1
            await sleep(retries === 1 ? 30_000 : 60_000)
            continue
          }
          break
        } catch (error) {
          threw = error instanceof Error ? error.message : String(error)
          if (retries < maxRetriesPerStep) { retries += 1; await sleep(30_000); continue }
          break
        }
      }
      if (threw !== null) {
        done = { id, actualMax: 0, source: 'error', measuredAt: new Date(now()).toISOString(), error: threw }
        break
      }
      const hit = parseMaxContext(text)
      if (hit !== null) {
        done = { id, actualMax: hit, source: 'probe', measuredAt: new Date(now()).toISOString() }
        break
      }
      if (RATE_LIMIT_RE.test(text)) {
        done = { id, actualMax: 0, source: 'error', measuredAt: new Date(now()).toISOString(), error: 'rate limited' }
        break
      }
      // 未命中且无错误：加长一步继续逼近
      target = target + Math.max(10_000, Math.floor(target * 0.08))
      await sleep(stepGapMs)
    }
    out.push(done)
    deps.onResult?.(id, done)
    if (modelIds.indexOf(id) < modelIds.length - 1) await sleep(stepGapMs)
  }
  return out
}
```

> `cryptoRandom` 已存在于同文件（供 `probeActualMax` 使用），**不要重复定义**。

### 5.6 `src/client/CapacityCard.tsx`（agent-ui `[覆盖]`）

```tsx
/** 设置页卡片：模型列表 + 双数字 + 占用 + 手动按钮（四态 + 直接渲染返回值）。 */
import * as React from 'react'
import { messages } from './locales.ts'
import { API_BASE } from './constants.ts'

type ModelRow = { id: string; name: string; effectiveSuggested: number; actualMax: number; source: string; measuredAt: string; similar: boolean }
type Snapshot = {
  models: ModelRow[]
  occupancy: { used: number; contextWindow: number } | null
  probing: boolean
  compacting: boolean
  lastCompactedAt: number
  capacityReady: boolean
  measuredAt: string
}

const t = messages.zh

/** 检查 res.ok 并解析；失败抛出带后端 error 文案的异常。 */
async function request(path: string, method: 'GET' | 'POST'): Promise<Snapshot> {
  const r = await fetch(`${API_BASE}${path}`, { method })
  const body = await r.json().catch(() => ({} as Record<string, unknown>))
  if (!r.ok) {
    const msg = (body as { error?: string }).error ?? `HTTP ${r.status}`
    throw new Error(msg)
  }
  return body as Snapshot
}

/** 实际最大上下文的四态显示。 */
function actualMaxCell(m: ModelRow): string {
  if (m.source === 'error') return `${t.probeFailed}${m.measuredAt ? '' : ''}`
  if (m.actualMax <= 0) return t.notMeasured
  if (m.source === 'fallback') return `${m.actualMax}（${t.fallback}）`
  return String(m.actualMax)
}

export function CapacityCard(): React.ReactElement {
  const [snap, setSnap] = React.useState<Snapshot | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string>('')

  const load = React.useCallback(async () => {
    try { setSnap(await request('/status', 'GET')); setError('') }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [])
  React.useEffect(() => { void load() }, [load])

  const act = async (name: string, path: string): Promise<void> => {
    setBusy(name); setError('')
    try {
      // 直接用返回快照渲染（不再二次 fetch）
      setSnap(await request(path, 'POST'))
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(null) }
  }

  if (!snap) {
    return React.createElement('div', null,
      React.createElement('h3', null, t.title),
      React.createElement('p', null, error ? `${t.notAvailable}: ${error}` : t.notAvailable))
  }
  const inCooldown = snap.lastCompactedAt > 0 && Date.now() - snap.lastCompactedAt < 60_000
  const disabled = snap.probing || snap.compacting || inCooldown || busy !== null

  return React.createElement('div', null,
    React.createElement('h3', null, t.title),
    error ? React.createElement('p', { style: { color: 'crimson' } }, error) : null,
    React.createElement('button', { disabled, onClick: () => void act('refresh', '/refresh-models') }, t.refreshModels),
    ' ',
    React.createElement('button', { disabled, onClick: () => void act('probe', '/probe') },
      busy === 'probe' ? t.probing : t.refreshProbe),
    ' ',
    React.createElement('button', { disabled, onClick: () => void act('compact', '/compact') },
      snap.compacting || busy === 'compact' ? t.compacting : t.compact),
    snap.occupancy ? React.createElement('p', null,
      `${t.used}: ${snap.occupancy.used} / ${snap.occupancy.contextWindow}`) : null,
    React.createElement('h4', null, t.models),
    React.createElement('table', null,
      React.createElement('thead', null, React.createElement('tr', null,
        React.createElement('th', null, 'ID'),
        React.createElement('th', null, t.suggested),
        React.createElement('th', null, t.actualMax))),
      React.createElement('tbody', null, snap.models.map((m) =>
        React.createElement('tr', { key: m.id },
          React.createElement('td', null, m.id),
          React.createElement('td', null, String(m.effectiveSuggested)),
          React.createElement('td', null, actualMaxCell(m)))))),
    snap.measuredAt ? React.createElement('p', { style: { opacity: 0.7 } }, `${t.measuredAt}: ${snap.measuredAt}`) : null,
  )
}
export default CapacityCard
```

### 5.7 `src/client/locales.ts`（agent-ui：`[替换]` 追加 4 条文案）

替换 1 —— 英文块在 `notAvailable` 后追加：
```
old:    notAvailable: 'Context controls unavailable',
  },
new:    notAvailable: 'Context controls unavailable',
    notMeasured: 'Not measured (click Refresh actual max)',
    probeFailed: 'Probe failed',
    measuredAt: 'Measured at',
    probeTimeout: 'Probe timeout',
  },
```

替换 2 —— 中文块在 `notAvailable` 后追加：
```
old:    notAvailable: '上下文管理能力当前不可用',
  },
new:    notAvailable: '上下文管理能力当前不可用',
    notMeasured: '未测量（点「刷新实际最大上下文」）',
    probeFailed: '探测失败',
    measuredAt: '测量时间',
    probeTimeout: '探测超时',
  },
```

### 5.8 `test/client-slots.test.ts`（agent-test `[覆盖]`）

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string): string => readFileSync(join(process.cwd(), 'src', 'client', p), 'utf8')
const constantsSrc = read('constants.ts')
const indexSrc = read('index.ts')
const cardSrc = read('CapacityCard.tsx')
const bridgeSrc = readFileSync(join(process.cwd(), 'src', 'status-bridge.ts'), 'utf8')

test('constants.ts 使用设置分区常量，且已移除 plugins.* 槽常量', () => {
  assert.match(constantsSrc, /export const SETTINGS_SECTION_ID = 'deveco2dsh'/)
  assert.match(constantsSrc, /export const SLOT_SECTION = 'settings\.section'/)
  assert.match(constantsSrc, /export const SLOT_SECTION_ICON = 'settings\.section\.icon'/)
  assert.match(constantsSrc, /export const SETTINGS_ORDER = 35/)
  assert.doesNotMatch(constantsSrc, /plugins\.bundle\.config|plugins\.row\.config|plugins\.item/)
})

test('client/index.ts 只注册 settings.section 与同 id 图标', () => {
  assert.match(indexSrc, /slots\.inject\(SLOT_SECTION/)
  assert.match(indexSrc, /slots\.inject\(SLOT_SECTION_ICON/)
  assert.match(indexSrc, /id: SETTINGS_SECTION_ID/)
  assert.match(indexSrc, /order: SETTINGS_ORDER/)
  assert.doesNotMatch(indexSrc, /plugins\.bundle\.config|plugins\.row\.config|plugins\.item/)
  assert.doesNotMatch(indexSrc, /BUNDLE_KEY|ROW_KEY/)
})

test('CapacityCard 检查 res.ok 且不再残留 /deveco2dsh/ 路径', () => {
  assert.match(cardSrc, /if \(!r\.ok\)/)
  assert.doesNotMatch(cardSrc, /\/deveco2dsh\//)
  assert.match(cardSrc, /API_BASE/)
})

test('客户端与服务端 API_BASE 值一致且不跨端 import', () => {
  assert.match(constantsSrc, /export const API_BASE = `\/plugins\/\$\{PKG\}`/)
  assert.match(bridgeSrc, /const API_BASE = '\/plugins\/dsh-deveco2api-plugin'/)
  assert.doesNotMatch(bridgeSrc, /from '\.\/client\//)
})

test('locales.ts 的 NS 为设置分区 id', () => {
  const localesSrc = read('locales.ts')
  assert.match(localesSrc, /export const NS = 'deveco2dsh'/)
})
```

### 5.9 `test/status-bridge.test.ts`（agent-test `[覆盖]`）

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSnapshot, registerStatusBridge } from '../src/status-bridge.ts'

const cap = {
  schema: 'capacity/v1' as const,
  updatedAt: 't',
  models: { 'GLM-5.3': { suggested: 170000, actualMax: 202752, measuredAt: 't', source: 'probe' as const } },
}
const snap = buildSnapshot({
  catalogModels: [{ id: 'GLM-5.3', name: 'GLM-5.3', contextWindow: 170000 }],
  capacity: cap, used: 100000, probing: false, compacting: false, lastCompactedAt: 0, measuredAt: 't',
})

test('buildSnapshot 双数字 + measuredAt', () => {
  assert.equal(snap.models[0]?.effectiveSuggested, 170000)
  assert.equal(snap.models[0]?.actualMax, 202752)
  assert.equal(snap.measuredAt, 't')
  assert.deepEqual(snap.occupancy, { used: 100000, contextWindow: 170000 })
})

test('4 个端点全部 /plugins/<包名>/ + exact + 两参 handler', () => {
  const specs: Array<{ kind: string; path: string; handler: (req: unknown, res: unknown) => unknown }> = []
  registerStatusBridge({ webServer: { register: (spec) => { specs.push(spec); return undefined } } }, {
    getSnapshot: () => snap,
    onProbe: async () => snap,
    onCompact: async () => ({ ok: true, message: '' }),
    onRefreshModels: async () => snap,
  })
  assert.equal(specs.length, 4)
  assert.ok(specs.every((s) => s.kind === 'exact'))
  assert.ok(specs.every((s) => s.path.startsWith('/plugins/dsh-deveco2api-plugin/')))
  assert.ok(specs.every((s) => s.handler.length === 2))
  assert.deepEqual(specs.map((s) => s.path), [
    '/plugins/dsh-deveco2api-plugin/status',
    '/plugins/dsh-deveco2api-plugin/probe',
    '/plugins/dsh-deveco2api-plugin/compact',
    '/plugins/dsh-deveco2api-plugin/refresh-models',
  ])
})

test('/probe 与 /refresh-models 返回完整快照（非 {ok:true}）', async () => {
  const specs: Array<{ path: string; handler: (req: unknown, res: unknown) => unknown }> = []
  registerStatusBridge({ webServer: { register: (spec) => { specs.push(spec); return undefined } } }, {
    getSnapshot: () => snap,
    onProbe: async () => snap,
    onCompact: async () => ({ ok: true, message: '' }),
    onRefreshModels: async () => snap,
  })
  const writes: string[] = []
  const fakeRes = { writeHead: () => {}, end: (s: string) => { writes.push(s) } }
  const fakeReq = { socket: { remoteAddress: '127.0.0.1' } }
  const probe = specs.find((s) => s.path.endsWith('/probe'))!
  probe.handler(fakeReq, fakeRes)
  await new Promise((r) => setTimeout(r, 50))
  assert.ok(writes.length >= 1)
  const body = JSON.parse(writes[writes.length - 1]!)
  assert.ok(Array.isArray(body.models))
  assert.equal(body.measuredAt, 't')
})
```

### 5.10 `test/capacity-probe.test.ts`（agent-test 新增）

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { probeNow, parseMaxContext } from '../src/capacity-probe.ts'

const overLimit = 'event: error data: {"error":{"message":"This model\'s maximum context length is 202752 tokens."}}'

function makeFetch(handler: (body: string) => string): typeof fetch {
  return (async (_url: unknown, init: unknown) => {
    const body = (init as { body?: string }).body ?? ''
    const text = handler(body)
    return { text: async () => text } as unknown as Response
  }) as unknown as typeof fetch
}

test('parseMaxContext 提取 202752', () => {
  assert.equal(parseMaxContext(overLimit), 202752)
})

test('probeNow 逐步逼近，命中即停，返回实测值', async () => {
  let calls = 0
  const deps = {
    getAccess: async () => 'tok',
    fetchImpl: makeFetch((body) => {
      calls += 1
      // 前两次不超限（正常回复），第三次超限
      return calls >= 3 ? overLimit : 'data: {"choices":[{"delta":{"content":"OK"}}]}'
    }),
    sleep: async () => {},
    now: () => 1000,
  }
  const out = await probeNow(['GLM-5.3'], { 'GLM-5.3': 170000 }, deps, { stepGapMs: 0, totalTimeoutMs: 60_000 })
  assert.equal(out.length, 1)
  assert.equal(out[0]?.source, 'probe')
  assert.equal(out[0]?.actualMax, 202752)
  assert.equal(calls, 3)
})

test('probeNow 遇限流退避后仍可成功', async () => {
  let calls = 0
  const deps = {
    getAccess: async () => 'tok',
    fetchImpl: makeFetch(() => {
      calls += 1
      if (calls === 1) return 'event: error data: {"error":{"type":"UserSessionLimitExceeded"}}'
      return overLimit
    }),
    sleep: async () => {},
    now: () => 1000,
  }
  const out = await probeNow(['GLM-5.3'], { 'GLM-5.3': 170000 }, deps, { stepGapMs: 0, totalTimeoutMs: 60_000 })
  assert.equal(out[0]?.source, 'probe')
  assert.equal(out[0]?.actualMax, 202752)
})

test('probeNow 未登录返回 error', async () => {
  const out = await probeNow(['GLM-5.3'], { 'GLM-5.3': 170000 }, {
    getAccess: async () => null, sleep: async () => {}, now: () => 1000,
  })
  assert.equal(out[0]?.source, 'error')
  assert.match(String(out[0]?.error), /not logged in/)
})

test('probeNow 超时降级', async () => {
  let t = 0
  const out = await probeNow(['GLM-5.3'], { 'GLM-5.3': 170000 }, {
    getAccess: async () => 'tok',
    fetchImpl: makeFetch(() => 'data: {"choices":[{"delta":{"content":"OK"}}]}'),
    sleep: async () => { t += 50_000 },
    now: () => t,
  }, { stepGapMs: 0, totalTimeoutMs: 40_000 })
  assert.equal(out[0]?.source, 'error')
  assert.match(String(out[0]?.error), /timeout/)
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
| 2 | `test` | 现有 48 项 + 新增/改写（capacity-probe 5、client-slots 5、status-bridge 3）→ **全部通过** |
| 3 | `build` / `build:client` | `lib/index.js`、`lib/client.js` 生成；`client.js` 开头仍 `window.__ModuleLoader__.load` |
| 4 | `pack` | tgz `dsh-deveco2api-plugin-0.1.3.tgz`；含 `lib/client.js`；prepack 校验通过 |
| 5 | `package.json` | `version === '0.1.3'`；`dsh.client.inject` 恰 3 项（settings / slots / locale） |
| 6 | 槽注册 | 单测断言只注册 `settings.section` + `settings.section.icon`（同 id `deveco2dsh`），0 处 `plugins.*` |
| 7 | `/probe` | 单测断言返回完整快照（含 `models` / `measuredAt`），非 `{ok:true}` |
| 8 | `probeNow` | 5 个用例全绿（逼近/命中即停/限流退避/未登录/超时） |
| 9 | 启动不写空 | 产物加载后 `capacity.json` **不被自动写空**（`capacityAutoProbe` 默认 false） |
| 10 | 结构核对 | §1 文件树逐文件存在；`git status` 只显示 §1 列出路径 |
| 11 | 主链路 | `import('./lib/index.js')` 加载成功、`listModels` 返回 2 模型、真实对话 `finish:stop` |

任一不通过：集成 agent 把失败点 `send_message` 给对应工作者，修正后重跑；**不得**自己改工作者作用域内文件。

---

## 7. 不在本方案内（明确排除）

- 不改 `tsdown.client.config.ts`（CJS closure 格式）
- 不改 `tsconfig.json` / `scripts/prepare-package.mjs` / `cordis.patch.yml`
- 不动 `src/adapter/*` / `src/auth/*` / `src/capacity.ts` / `src/compaction-policy.ts` / `src/context-guard.ts` / `src/catalog.ts`
- 不改模型路由与对话主链路
- 不执行 `dsh plugin add/remove`、不重启 DSH、不改 `~/.dsh/profiles/*`
- 不发真实探测请求（探测由用户日后在 GUI 点按钮触发）
- **重装 0.1.3 + 实机 GUI 验证属部署验收，需用户另行明确授权**
- 不处理 `compaction-policies.json` 部署合入

---

## 8. 给执行者的最终检查清单

- [ ] 已读 `docs/plan.md` v4.0 与本文全文
- [ ] 已跑 §0.3 前置核验（`react` 解析、基线 typecheck）
- [ ] 已跑 §3.9 old_string 唯一性核验（9 处全部命中 1）
- [ ] 已用 `spawn_teammate`（或名额满时 `subagent`）派生 3 个工作者，prompt 自包含（附 §0 + §2 + 对应 §5 代码）
- [ ] 已按 §4.2 建任务依赖（task-seam blocked_by 三个任务）
- [ ] 三个工作者写作用域互不相交、未交叉读写
- [ ] 集成 agent 独占 `package.json` / `config.ts` / `index.ts` / `status-bridge.ts`
- [ ] 已跑 §6 全部验收且通过（含 0.1.3、settings.section、/probe 快照、probeNow 5 用例）
- [ ] `git status` 只包含 §1 列出路径

> **本文是施工图，不是执行结果。当前处于方案设计阶段，未做任何实际操作。**
