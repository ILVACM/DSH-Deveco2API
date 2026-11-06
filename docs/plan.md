# dsh-deveco2api GUI 迭代 v4 —— 设置页迁移 + 手动探测必达

> 版本：v4.0（重写，替代 v3.0「Plugins 页 KEYED 槽」方案）
> 日期：2026-11-06
> 范围：**两件事**——① 把 GUI 从 sidebar「Plugins」页迁到 **DSH「设置」**（与 trae / workbuddy / qoder 一致）；② 让「刷新实际最大上下文」**人工点击必得实时值**，自动探测降频到可留空。
> 依据：DSH 宿主 `0.2.2-rc.1` + 已装 `dsh-connect-workbuddy@5.20.2` / `dsh-connect-trae@4.10.0` / `@dmh2002/dsh-connect-qoder@1.19.1` 实机源码核实
> 本文性质：**方案设计阶段文档，不含任何已执行操作。**

---

## 1. 目标（一句话）

> **把配置面板挂到 DSH「设置」导航里（`settings.section`），并把「刷新实际最大上下文」做成一条绕开节流、逐步落盘、结果可见的独立链路——人工一点必得实时值；自动探测默认关闭、允许长期留空、绝不触发会话限流。**

**不做**：不改模型路由 / 对话主链路 / 上下文管理的判定逻辑（capacity 的 90%/80% 规则、context-guard 的压后复核都不动）。

---

## 2. 现状与根因（已核实）

### 2.1 GUI 位置选错（本次要改的核心）

| | v3 方案（已落地 0.1.2） | 参考插件（trae / workbuddy / qoder） |
| --- | --- | --- |
| 注册的槽 | `plugins.bundle.config` / `plugins.row.config` | **`settings.section`**（+ `settings.section.icon`） |
| 位置 | sidebar「Plugins」页的插件卡片 | **DSH「设置」导航里的一节** |
| key 匹配 | 必须严格等于包名（issue #55 陷阱） | **插件自有的 id**，无匹配陷阱 |

**关键证据**（`workbuddy@5.20.2` 客户端源码注释）：

> `settings.section` is a LIST slot keyed by an id **this plugin owns**. There is no inventory name to match, so the whole class of mismatch disappears, and the user finds the configuration where every other preference lives.
>
> The former `plugins.bundle.config` / `plugins.row.config` pair is **GONE with 5.19.0**: the same configuration must not have two editing entries.

三个参照插件实测均为 **0 处** `plugins.*.config` 注册调用，全部只用 `settings.section`：
- `dsh-connect-trae@4.10.0`
- `dsh-connect-workbuddy@5.20.2`
- `@dmh2002/dsh-connect-qoder@1.19.1`

### 2.2 「刷新实际最大上下文」点了没反应（本次要改的第二件事）

**实测证据**：点击按钮后 `~/.dsh/deveco2dsh/capacity.json` 时间戳**仍是 15:41**（未重写），内容仍是 `{"models": {}}`；而同期 `models.json` / `status.json` 为 19:21（目录正常刷新）。

四个叠加成因：

| # | 成因 | 证据 |
| --- | --- | --- |
| ① | **卡片静默吞错**：`post()` 是裸 `await fetch(...)`，**不检查 `res.ok`**、不解析响应体。后端 403/404/500 时卡片既不报错也照样 `load()` 一次（拿回的还是空记录） | `CapacityCard.tsx` 第 17-19 行 |
| ② | **探测被 `running` 锁丢弃**：`createProbeScheduler.start()` 立即 `void runOnce()` 且 `runOnce` 有 `if (running) return`。启动首跑若长时间挂住（超长请求 60s 超时），用户点「刷新」时 `trigger()` 被直接丢弃，**点了等于没点** | `capacity-probe.ts` 第 99-103 行 |
| ③ | **启动时序 BUG**：`scheduler.start()`（装配块内）在 `catalog.loadCache()/start()` **之前**执行，首跑时 `catalog.list()` 为空 → `refreshAllCapacities([], …)` 写入空 `{"models": {}}` | `index.ts` 第 176 行 vs 第 209 行 |
| ④ | **探测请求过猛**：一次发约 230K token 的超长请求，极易撞华为 `New session request rate exceeded`（会话限流）或 60s 超时；失败后请求体里**没有** `maximum context length is N tokens`，正则抓不到 → `fallback`。但连 fallback 记录都没落盘，说明请求链路可能压根没走到 | `capacity-probe.ts` 第 40/57 行 |

> ②③④ 任一成立都足以让 `capacity.json` 保持为空；① 让用户完全看不出发生了什么。这是**四个缺陷叠加**，不是单点问题。

### 2.3 已确认「不是」的原因

| 猜测 | 核实结论 |
| --- | --- |
| 客户端产物格式错 | ❌ `lib/client.js` 开头是 `window.__ModuleLoader__.load({ id, factory })`，与 workbuddy 一致 |
| `dsh.client.inject` 缺依赖 | ❌ 0.1.2 已补 4 项（settings / slots / settings-plugins / locale） |
| 路由前缀错 | ❌ `index.js` 内 `API_BASE = "/plugins/dsh-deveco2api-plugin"` + `kind:"exact"` 4 路由均已编译进产物 |
| 卡片完全不可见 | ❌ 卡片可见、模型列表可见（否则不会只报「实际最大上下文没显示」） |

---

## 3. 前置事实（已核实，直接采信）

| 项 | 值 |
| --- | --- |
| 设置页分区槽 | `settings.section`（LIST 槽，**key = 插件自有 id**，无包名匹配陷阱） |
| 分区图标槽 | `settings.section.icon`（shell 用 `{ only: row.id }` 渲染，**id 必须与 section 相同**；未注册则用默认图标；`label` 不显示） |
| `settings.section` 注册字段 | `{ name:'settings.section', id, order, label:()=>string, locale, inject }` |
| 设置页宿主 | `@deepseek-ai/dsh-client-ui-settings`（`settings.section` 由其声明）；`ui-settings-general` 提供 shell / 导航 / chrome |
| 图标组件入参 | `{ size: number, active: boolean }` |
| 配置读写 | `ctx.configForms` / `settingsScope`（`describe()` 读 schema、`get/set/mutate` 读写）；写后回读校验 |
| 已装参照 | workbuddy 5.20.2 只用 `settings.section`（`plugins.*.config` 自 5.19.0 移除）；trae 4.10 / qoder 1.19.1 同 |
| 华为限流形态 | 会话级：`New session request rate exceeded`（`UserSessionLimitExceeded`）；另有每账号 50 次/分钟 |
| 探测正则 | `/maximum context length is (\d+) tokens/`（P0 实测稳定） |
| 真实上限 | GLM-5.3 = 202752（实测） |

---

## 4. 核心概念（消除歧义）

### 4.1 设置页 vs Plugins 页（本次迁移的关键区别）

| | `settings.section`（**本方案采用**） | `plugins.bundle.config`（v3，废弃） |
| --- | --- | --- |
| 位置 | DSH「设置」导航左侧一栏 | sidebar「Plugins」页内某插件卡片 |
| key 语义 | **插件自有 id**（自己定，稳定跨部署） | **必须严格等于包名**（对不上就整块不渲染） |
| 图标 | 需另注册 `settings.section.icon`（同 id） | 无需 |
| 多入口风险 | 单入口 | 易与其它槽重复 |
| 参照实现 | trae / workbuddy / qoder **全部采用** | 三者均已移除 |

### 4.2 三种「名字」（沿用 v3 结论，迁移后仍要分清）

| 名字 | 值 | 用在哪 |
| --- | --- | --- |
| 包名 | `dsh-deveco2api-plugin` | `dsh.client` 归属、`window.__ModuleLoader__` id、`/plugins/` 路径段 |
| **设置分区 id** | **`deveco2dsh`** | `settings.section` 的 `id`、`settings.section.icon` 的 `id`、locale namespace |
| Loader entry id | `deveco2dsh` | cordis patch `- id:`（与分区 id 同值，但语义不同） |
| 服务名 | `slots` / `locale` / `configForms` / `webServer` | `ctx.inject` / `ctx.slots` / `ctx.webServer` |

> 分区 id 用 `deveco2dsh`（简洁、与 Loader entry 一致、用户可读）；**不再**用包名作分区 id。

### 4.3 手动刷新链路（新设计，替代 scheduler 复用）

```
用户点「刷新实际最大上下文」
   ▼ POST /plugins/dsh-deveco2api-plugin/probe        （同步等待，非 fire-and-forget）
Host handler
   ▼ 1. 等 catalog 就绪（list 非空；空则最多等 N 秒）
     2. 置 probing=true（卡片可轮询到「测量中」）
     3. 逐模型串行探测（温和逼近 + 限流退避）
     4. 每步写回 capacity.json（失败也写 source/error）
     5. 置 probing=false
   ▼ 返回最终快照 { models:[{id,actualMax,source,error}], measuredAt }
卡片
   ▼ 直接渲染返回值（不再依赖二次 fetch）
```

**关键**：手动链路**完全绕开** `scheduler` 的 `running` 锁与周期节流。

### 4.4 自动探测策略（降频到可留空）

| 时机 | 行为 |
| --- | --- |
| 插件启动 | **不自动探测**（允许 `capacity.json` 为空） |
| 周期 | 默认 **关闭**（`capacityAutoProbe=false`）；开启后最低 24 小时一次 |
| 目录就绪后 | 不自动触发探测 |
| 用户点刷新 | **必达**（见 §4.3） |

> 直接满足「没有人工主动刷新时允许暂时留空」。

### 4.5 温和探测（避免会话限流）

不用"一发 230K 撑爆"，改为**逐步加长逼近**：

```
起点 = 目录建议值 × 1.15（如 170000×1.15 ≈ 195500）
每步 +8% 或 +10000，串行，步间隔 ≥ 20s
命中 "maximum context length is N tokens" → 立即读 N 收工
遇 UserSessionLimitExceeded / 429 → 退避 30~60s 重试同一步（最多 3 次）
连续 3 次退避仍失败 → 记 source:'error' + error 文案，继续下一个模型
```

- 首个试探步就已超限时，直接拿到真实值（GLM-5.3 → 202752）
- 每步请求体比 230K 小得多，间隔更长 → **比现状更不容易触发会话限流**

---

## 5. 完整流程（改完后）

1. 插件加载 → `dsh.client` 把 `ui-settings` / `ui-slots` / `ui-locale` 等 bundle 排前加载。
2. 客户端 `apply(ctx)`：
   - `ctx.locale.register('deveco2dsh', {en,zh})`
   - `ctx.slots.inject('settings.section', () => ctx.slots.register({ name:'settings.section', id:'deveco2dsh', order:35, label:()=>t('title'), locale:'deveco2dsh', inject:()=>({t}) }, CapacityCard))`
   - `ctx.slots.inject('settings.section.icon', () => ctx.slots.register({ name:'settings.section.icon', id:'deveco2dsh', locale:'deveco2dsh' }, Icon))`
3. 用户打开 **DSH 设置** → 左侧导航出现「DevEco 上下文」一节 → 点进去看到卡片。
4. 卡片显示：
   - 可用模型列表（+「刷新模型列表」）
   - 每模型：建议上下文 / **实际最大上下文**（未测量 / 实测值 / 兜底值 / 失败原因）
   - 当前占用 + 两条并存线 + 「刚压过」状态
5. 点「刷新实际最大上下文」→ 按钮变「测量中…」→ 完成后显示真实值（或明确失败原因）。
6. 任何失败：卡片内联显示原因，**模型路由与对话不受影响**。

---

## 6. 具体改动点（文件级）

| 文件 | 动作 | 要点 |
| --- | --- | --- |
| `package.json` | 改 | `dsh.client.inject` 调整为 `ui-settings` / **`ui-slots`** / **`ui-locale`**（去掉 `ui-plugin-manager`、`ui-settings-plugins`，因为不再挂 Plugins 页）；`version → 0.1.3` |
| `src/client/constants.ts` | 改 | 新增 `SETTINGS_SECTION_ID='deveco2dsh'`、`SLOT_SECTION='settings.section'`、`SLOT_SECTION_ICON='settings.section.icon'`；移除 `SLOT_BUNDLE`/`SLOT_ROW`/`SLOT_ITEM`/`BUNDLE_KEY`/`ROW_KEY` |
| `src/client/index.ts` | 重写 | 只注册 `settings.section` + `settings.section.icon`（同 id）；移除全部 `plugins.*` 注册 |
| `src/client/CapacityCard.tsx` | 改 | ① `post()` 检查 `res.ok` + 解析返回体；② 手动刷新直接用返回快照渲染；③ 四态显示（未测量/测量中/实测/兜底+错误）；④ 移除 `inCooldown` 之外的旧逻辑保持不变 |
| `src/client/icon.tsx` | **新增** | 简单图标组件（`{size,active}` → 16px svg），供 `settings.section.icon` |
| `src/capacity-probe.ts` | 改 | 新增 `probeNow(modelIds, suggested, deps)`：逐步逼近 + 限流退避 + 每步回调；保留 `parseMaxContext`；`createProbeScheduler` 保留但**默认不启动** |
| `src/status-bridge.ts` | 改 | `/probe` 改**同步等待**并返回最终快照（不再 fire-and-forget）；新增 `probing` 状态透传；`/status` 返回 `probing` |
| `src/index.ts` | 改 | ① 删除启动即 `scheduler.start()`；② `onProbe` 改调 `probeNow` 并 await；③ 目录就绪后再考虑自动探测（默认关）；④ 保持 `ctx.inject(['webServer'])` |
| `src/config.ts` | 改 | 新增 `capacityAutoProbe`（默认 `false`）；`capacityProbeIntervalSeconds` 语义改为"自动探测间隔（仅在 autoProbe 开启时生效），最低 86400" |
| `test/capacity-probe.test.ts` | **新增** | `probeNow` 的逐步逼近 / 命中即停 / 限流退避 / 全失败降级 |
| `test/client-slots.test.ts` | 改 | 断言只注册 `settings.section`（同 id 的 icon），**不**再出现 `plugins.*.config` |
| `test/status-bridge.test.ts` | 改 | `/probe` 同步返回快照（而非 `{ok:true}`） |

**明确不改**：`tsdown.client.config.ts`（CJS closure 格式）、`capacity.ts` 的 90%/80% 规则、`context-guard.ts`、`compaction-policy.ts`、`catalog.ts`、`deveco-adapter.ts`、`src/auth/*`、`cordis.patch.yml`。

---

## 7. 职责边界

| 做 | 不做 |
| --- | --- |
| 迁到 `settings.section`（同 id 的 icon） | 保留 `plugins.*.config` 双入口 |
| 手动刷新同步等待 + 返回快照 + 卡片直接渲染 | 手动刷新 fire-and-forget |
| `probeNow` 逐步逼近 + 限流退避 | 一发 230K 撑爆 |
| 自动探测默认关闭、允许留空 | 启动即探测、周期 1 天 |
| 四态显示（未测量/测量中/实测/失败） | 统一显示 `—` |
| 失败内联提示、不阻断对话 | 静默吞错 |

---

## 8. 分阶段落地

| 步 | 内容 | 可独立验证 | 估时 |
| --- | --- | --- | --- |
| 1 | `constants.ts` 换常量；`client/index.ts` 重写为 `settings.section` + icon；新增 `icon.tsx` | 单测断言只注册 settings 槽 | 0.4 天 |
| 2 | `package.json` 调整 `dsh.client.inject` + 版本 0.1.3 | JSON 合法、逐项比对参照 | 0.1 天 |
| 3 | `capacity-probe.ts` 新增 `probeNow`（逼近 + 退避 + 回调） | 单测（mock fetch） | 0.6 天 |
| 4 | `status-bridge.ts` `/probe` 同步返回快照 + `probing` 透传 | 单测断言返回体 | 0.3 天 |
| 5 | `index.ts` 删除启动即探测、`onProbe` 接 `probeNow`、`config.ts` 加 `capacityAutoProbe` | 产物加载 + 目录就绪后不自动写空 | 0.3 天 |
| 6 | `CapacityCard.tsx` 四态 + 检查 `res.ok` + 直接渲染返回值 | typecheck | 0.4 天 |
| 7 | 测试补齐 + `typecheck`/`test`/`build`/`build:client`/`pack` | 全套绿 | 0.3 天 |
| 8 | **重装 0.1.3 + 实机设置页验证 + 点刷新看真实值** | 肉眼可见 + 出数 | 0.3 天 |
| — | **合计** | | **约 2.7 天** |

---

## 9. 验收标准

```powershell
cd D:\dsh-deveco2api\packages\plugin
corepack pnpm typecheck && corepack pnpm test && corepack pnpm build && corepack pnpm run build:client && corepack pnpm pack
```

| # | 检查 | 期望 |
| --- | --- | --- |
| 1 | 全套命令 | 全绿；tgz `dsh-deveco2api-plugin-0.1.3.tgz` |
| 2 | 槽注册 | 只注册 `settings.section` 与 `settings.section.icon`，**id 同为 `deveco2dsh`**；0 处 `plugins.*.config` |
| 3 | 产物格式 | `lib/client.js` 仍以 `window.__ModuleLoader__.load` 开头 |
| 4 | `probeNow` 单测 | 逐步逼近、命中即停、限流退避 3 次、全失败降级均通过 |
| 5 | `/probe` 返回 | 同步返回 `{ models:[...], measuredAt, probing:false }`，非 `{ok:true}` |
| 6 | 启动不写空 | 插件加载后 `capacity.json` **不被自动写成 `{"models":{}}`** |
| 7 | **实机：设置页可见** | DSH「设置」左侧出现「DevEco 上下文」一节 + 图标，点进去有卡片 |
| 8 | **实机：点刷新必达** | 点「刷新实际最大上下文」→ 按钮变「测量中…」→ 完成后显示 **202752（实测）**；若失败显示明确原因 |
| 9 | 主链路未回归 | 真实流式对话仍返回正文 + `finish:stop` |

---

## 10. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| `settings.section` 的 `id` 与 icon `id` 不一致 | 图标不渲染（section 仍在） | 两处共用 `SETTINGS_SECTION_ID` 常量；单测断言同值 |
| 漏注册 `settings.section.icon` | 用默认图标（不致命） | 明确要求注册；单测覆盖 |
| `/probe` 同步等待太久（多模型 × 多步 × 退避） | HTTP 超时、卡片卡住 | 设总超时（如 90s）+ 卡片显示「测量中」；超时返回已测到的部分结果 |
| 逐步逼近步数过多 | 请求数上升 | 起点贴近真实上限（建议值×1.15）、步长 8%，通常 1~2 步命中 |
| 仍触发会话限流 | 探测失败 | 步间隔 ≥20s、串行、遇限流退避 30~60s、最多 3 次后记 `error` |
| 自动探测误开 | 启动即耗配额 | `capacityAutoProbe` 默认 `false` |
| 目录未就绪时手动刷新 | 测空 | `probeNow` 前置检查 `catalog.list()` 非空，空则等待/返回明确错误 |

---

## 11. 不在本方案内（明确排除）

- 不改 `tsdown.client.config.ts`（CJS closure 格式已验证）
- 不改 `capacity.ts` 的 90% 相近判定 / 80% 重算规则
- 不改 `context-guard.ts`（单线判定 / 压后复核 / 刚压过标记）
- 不改 `compaction-policy.ts`（反推 W / modelPolicies）
- 不改 `catalog.ts` / `deveco-adapter.ts` / `src/auth/*` / `cordis.patch.yml`
- 不改模型路由与对话主链路
- 不处理 `compaction-policies.json` 的部署合入（仍属部署动作）
- **重装 0.1.3 + 实机 GUI 验证属部署验收，需用户另行明确授权**

---

## 12. 立即开始的第一步

```powershell
cd D:\dsh-deveco2api\packages\plugin
# 1. constants.ts 换常量（SETTINGS_SECTION_ID / SLOT_SECTION / SLOT_SECTION_ICON）
# 2. client/index.ts 重写为 settings.section + icon（同 id）
# 3. 新增 client/icon.tsx
corepack pnpm typecheck
```

**第 1~3 步不通过不进第 4 步。** 先让"设置里能看到"，再改探测链路。

---

> **本文是方案，不是执行结果。当前处于方案设计阶段，未做任何实际操作（未改代码、未重装、未动 profile）。**
