# dsh-deveco2api 开发计划

> 方案：**A —— 复用本机 `deveco` CLI 已登录的凭据**
> 语言：**全程 TypeScript**（与 DSH 同构，见 §2）
> 目标：做一个 DSH 插件，把 DevEco Code 内置的免费模型通道（GLM-5.1 / GLM-5.3）接进 DSH 的模型选择器
> 依据：[deveco-vs-opencode-comparison.md](./deveco-vs-opencode-comparison.md)、[opencode-free-models-to-dsh.md](./opencode-free-models-to-dsh.md)
> 更新：2026-11-03

---

## 0. 一句话路线

```
P0 探针脚本（验证凭据能解、能刷、能流式）
 → P1 插件骨架（DSH 里能选到模型、能对话）
 → P2 认证层固化（刷新/失效/并发）
 → P3 目录层（modelConfig + blacklist + 缓存）
 → P4 wire 与错误语义（200 里的错误、非流式路径、看门狗）
 → P5 打磨与分发
```

**核心原则**

1. **每个 Phase 都有机器可验证的验收命令，验收不过不进下一 Phase。**
2. **先把风险最高的两块（凭据解密 + 错误语义）在 P0 就摸清，不要等到最后。**
3. **全程 TypeScript**，不引入 Go/Rust/Python，不做 sidecar 子进程，不做 shell 中转。

---

## 1. 前置事实（已实测确认，直接采信）

| 项 | 值 |
| --- | --- |
| 本机 `deveco` CLI | `0.2.0-release`，已登录，`isRealName=true`，`nationalCode=CN` |
| 模型 | `GLM-5.1`、`GLM-5.3`（上下文 170000 / 输出 32000，`blacklist` 排除 Qwen3_VL） |
| 推理端点 | `https://cn.devecostudio.huawei.com/sse/codeGenie/maas/v2/chat/completions` |
| 非流式端点 | 同路径改 `/no-stream/chat/completions` |
| 目录端点 | `https://cn.devecostudio.huawei.com/codeGenie/modelConfig?localVersion=0&pluginVersion=CLI.<ver>` |
| 凭据文件 | `<data>/auth.json`（`~/.local/share/deveco`）、`<config>/token.enc` + `token.dek` + `keys/kek-*.bin`（`~/.config/deveco`） |
| 加密 | 双层 AES-256-GCM；敏感键 `access` / `refresh` / `key` / `token` |
| 刷新 | `GET .../authrouter/auth/api/jwToken/check` + 头 `refresh:true` + `jwtToken:<JWT>` |
| 必需头 | `Authorization: Bearer <access>`、**`Chat-Id`（缺失 400）**；`lang` 可选 |
| 错误形态 | **HTTP 200 + body/SSE 内错误**（`event: error` / 裸 `errorCode` / `WaitingInLine`） |
| DSH 宿主 | `@deepseek-ai/dsh` 0.2.1-rc.5；`LlmAdapter` 6 方法；`providerInfo.id` 必须等于注册名 |
| 参考实现 | opencode2dsh（v0.3.7，纯 TS 插件）的 `events.ts` 可整搬；其源码快照已移除，结论已固化在 [opencode-free-models-to-dsh.md](./opencode-free-models-to-dsh.md) |

> ⚠️ 注意：本机 `auth.json` 的 `expires` 已过期（2026-11-02 18:38）。**P0 天然会走到刷新分支**，正好用来验证刷新链路。

---

## 2. 技术栈：全程 TypeScript（与 DSH 同构）

**一句话：整条链路只用 TypeScript —— 从 P0 探针到最终插件包，不引入第二语言，不做 sidecar 子进程。**

### 2.1 为什么必须是 TS

| 理由 | 说明 |
| --- | --- |
| **与 DSH 同构** | DSH 宿主本身是 TS/Node 生态；`LlmAdapter` 是**结构契约**（按方法名调用，不做 `instanceof` 校验），TS 能直接在进程内实现；换成别的语言就要多一个进程 + 一套 IPC + 一套协议翻译 |
| **零 IPC 开销** | 插件跑在 DSH 进程内，请求直接复用宿主同一个 `fetch` 与 `@earendil-works/pi-ai`；sidecar 方案（opencode2dsh 的 legacy 形态）已被官方文档判定为"不分发" |
| **类型即文档** | `LlmAdapter` 六方法、7 种 chunk、5 种 `finish reason`、目录 schema 全部可被编译器约束，写错在 `corepack pnpm typecheck` 阶段就暴露，而不是运行期静默失败 |
| **生态直接复用** | `@earendil-works/pi-ai`（wire 层）、`@deepseek-ai/schemastery`（配置 schema）、Node 原生 `crypto`（AES-256-GCM 解密）都是现成 TS 能力 |
| **单一构建链** | 源码、测试、打包、分发全是同一套 Node 工具链，无需交叉编译矩阵 |

### 2.2 工具链（本机已实测可用）

| 组件 | 版本 / 位置 | 用途 |
| --- | --- | --- |
| **Node** | `v24.21.0`（`C:\nodejs\aliases\default\node.exe`） | 运行时；**原生支持 TS 类型剥离**，`node xxx.ts` 可直接执行（已实测） |
| **pnpm** | `11.28.5`（DSH 自带：`~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.cjs`） | 依赖安装、`pack` |
| **TypeScript** | `^5.9`（devDependency） | `tsc --noEmit` 类型检查 |
| **tsdown** | `^0.15`（devDependency） | 打包到 `lib/`，产出 ESM |
| **pi-ai** | `@earendil-works/pi-ai@0.82.1`（本机 profile 已装） | OpenAI 兼容 wire 层 |

> `pnpm` 不在 PATH，需用完整路径调用：`node "<pnpm.cjs>" install`。

### 2.3 语言约束（Node 类型剥离的红线）

Node 24 的「类型剥离」只**删除类型标注**，不做语法降级。以下写法会直接运行失败（实测 `enum` 报错）：

| ❌ 禁用 | ✅ 替代写法 |
| --- | --- |
| `enum` | `const X = { A: 'a' } as const` + `type X = (typeof X)[keyof typeof X]` |
| `namespace` | 普通模块导出 |
| 构造函数参数属性 `constructor(private x: T)` | 显式声明字段 + 在构造函数里赋值 |
| `import x = require(...)` | `import` / `import type` |
| 旧式装饰器 | 不使用 |

**tsconfig 里打开 `erasableSyntaxOnly: true`**，让编译器提前拦住这些写法，而不是等到运行时报错。

### 2.4 模块与导入约定

- `package.json` 声明 `"type": "module"`（ESM）
- `module` / `moduleResolution` 用 `NodeNext`
- **导入带 `.ts` 后缀**（`allowImportingTsExtensions: true`）——与 opencode2dsh 一致，Node 可直接跑、无需预构建
- 类型导入一律 `import type`（`verbatimModuleSyntax: true`）
- **结构性声明宿主契约，不 `import` `@deepseek-ai/*` 的类型** —— 避免与宿主版本耦合（opencode2dsh 的 `PluginContext` 就是这么做的）

### 2.5 源码直跑 vs 分发打包

| 场景 | 形态 | 说明 |
| --- | --- | --- |
| **P0 探针 / 单元测试** | 直接 `node xxx.ts` | 利用 Node 类型剥离，零构建 |
| **P1 本地联调** | `main` 指向 `lib/index.js`，先 `tsdown` 构建 | 与正式分发一致 |
| **P5 分发** | `corepack pnpm pack` 出 `lib/` | 只发 ESM 产物，不发 `src/` |

> 结论：**开发期可以 `node src/xxx.ts` 直接跑，但插件入口最终必须走 tsdown 打包**，因为 DSH 的 Loader 按 `package.json` 的 `main` 加载，且宿主运行时未必开启类型剥离。

### 2.6 标准命令

> `pnpm` 通常不在 PATH（本机实测）。统一用 Node 自带的 `corepack pnpm` 前缀，
> 无需全局安装；离线场景可用 DSH 自带的 pnpm（完整路径，见下）。

```powershell
# 依赖安装
corepack pnpm install

# 类型检查（每次改完必跑）
corepack pnpm typecheck        # = tsc --noEmit

# 单元测试（Node 原生 runner，不引 vitest/jest）
corepack pnpm test             # = node --test "test/*.test.ts"

# 构建
corepack pnpm build            # = tsdown src/index.ts --format esm --out-dir lib

# 打包
corepack pnpm pack
```

离线替代（DSH 自带的 pnpm v11.28.5，无需联网下载）：

```powershell
node "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs" install
```

---

## 3. 目录结构（目标形态）

```
dsh-deveco2api/                          # 仓库根（与参考项目 opencode2dsh 同构）
├─ README.md / README.zh-CN.md          # 项目说明
├─ CHANGELOG.md                         # 版本记录
├─ LICENSE                              # WTFPL
├─ package.json                         # 根包：dsh.bundle.patch + workspace 依赖
├─ cordis.patch.yml                     # 根级 bundle patch
├─ pnpm-workspace.yaml                  # workspace 声明
├─ .gitattributes / .gitignore
├─ install-guide.md                     # 安装指南
├─ scripts/prepare-package.mjs          # 发布前检查
├─ packages/plugin/                     # 唯一的 npm 包（DSH cordis 插件，纯 TS）
│  ├─ package.json                      # dsh.bundle.patch + exports + "type":"module"
│  ├─ cordis.patch.yml                  # - insert: [{id, name, config}]
│  ├─ tsconfig.json                     # NodeNext + erasableSyntaxOnly
│  ├─ src/
│  │  ├─ index.ts                       # name / Config / inject=['llm'] / apply()
│  │  ├─ config.ts                      # schemastery schema + 默认值
│  │  ├─ catalog.ts                     # modelConfig + blacklist + 缓存 + 刷新 + 健康快照
│  │  ├─ auth/
│  │  │  ├─ crypto.ts                   # 双层 AES-256-GCM 加解密
│  │  │  ├─ store.ts                    # 读 auth.json / token.enc，写回（CAS）
│  │  │  └─ refresh.ts                  # ensureValidToken（单飞 + 冷却 + CAS）
│  │  └─ adapter/
│  │     ├─ deveco-adapter.ts           # LlmAdapter 六方法
│  │     ├─ wire.ts                     # 自写 HTTP 流式 + SSE 解析 + 错误识别
│  │     ├─ events.ts                   # → DSH chunk 转译（整搬 opencode2dsh）
│  │     └─ messages.ts                 # DSH → 上游 body（含 </think> 剥离）
│  ├─ test/                             # node --test（26 项）
│  └─ lib/                              # 构建产物（tsdown）
├─ test/P0/                             # P0 探针（纳入版本管理，便于追溯）
│  ├─ P0.md                             # 探针编写计划
│  ├─ probe.ts                          # 探针脚本（不进插件包）
│  └─ runs/                             # 每次运行产物
└─ docs/                                # 本目录（技术报告 + 计划）
```

> 实现偏差：计划中的 `errors.ts` / `watchdog.ts` / `status.ts` 分别并入
> `wire.ts`（错误识别）、`events.ts`（错误分类）与 `catalog.ts`（健康快照）。

---

## 4. 分阶段计划

### P0 — 探针脚本（先跑通，再写插件）

**做什么**：一个独立的 **TypeScript** 脚本，把整条链路手工走一遍。

1. 解 `token.dek`（KEK 解包 DEK）
2. 解 `auth.json` 的 `deveco.access`（用 DEK）
3. 检查 `expires` → 过期则调 `jwToken/check` 刷新
4. 调 `modelConfig` 拿目录（打印模型 + blacklist）
5. 用 `GLM-5.1` 打一次**流式** chat，打印前 3 帧 + `[DONE]`
6. 打一次**非流式**（`/no-stream/`），打印完整 JSON
7. 故意去掉 `Chat-Id`，确认 400 文案
8. 故意用坏 token，确认 `errorCode:4016` 形态

**为什么用 TS 而不是 `.mjs`**：解密逻辑、请求构造、SSE 解析这三段代码**在 P1/P2 会被原样搬进插件**。用 TS 写，`packages/plugin` 可以直接 import 同一份文件（或至少逐行复制而不用重写类型），避免"探针能跑、插件重写一遍又出错"。

**产出**：
- `test/P0/probe.ts`（后续直接演进为 `src/auth/*` 与 `src/adapter/wire.ts` 的原型）
- 一份实测记录：`test/P0/runs/p0-report.json`（机器可读）+ 完整输出留档

**验收**：
```bash
node test/P0/probe.ts
# 期望：8 步全部 ✅，打印出模型列表、流式帧、非流式 JSON、两种错误形态
# 详细规格见 test/P0/P0.md
```

**风险**：若 `jwToken/check` 返回失败（JWT 也过期），需人工跑一次 `deveco auth login` 再继续。

---

### P1 — 插件骨架（在 DSH 里能对话）

**做什么**：最小可用的 DSH 插件，**模型写死一个**，不做目录、不做刷新。全程 TS。

1. `packages/plugin` 骨架（`package.json` + `tsconfig` + `cordis.patch.yml`）
2. `src/index.ts`：`name` / `Config` / `inject=['llm']` / `apply()`
3. `src/adapter/events.ts`：**从 opencode2dsh 整搬**（它是纯 TS，零改动即可用）
4. `src/auth/crypto.ts` + `store.ts`：从 P0 抽出来，补类型
5. `src/adapter/wire.ts`：构造请求（URL / `Bearer` / `Chat-Id` / 流式）
6. `src/adapter/deveco-adapter.ts`：六方法，`listModels` 返回写死的 `GLM-5.1`
7. `ctx.llm.registerAdapter(['deveco2dsh'], adapter)` —— **放在 apply 最前面**

**验收**：
```powershell
# 0. 类型检查 + 构建 + 打包（pnpm 不在 PATH 时用 corepack 前缀）
corepack pnpm typecheck && corepack pnpm build && corepack pnpm pack
# 1. 装到 profile（tgz 必须传绝对路径）
dsh plugin --profile desktop add "D:\dsh-deveco2api\packages\plugin\dsh-deveco2api-plugin-0.1.0.tgz"
# 2. 重启 DSH，模型选择器里出现 deveco2dsh / GLM-5.1
# 3. 发一条消息，DSH 收到流式回复
```

**关键细节（写错就静默失败）**：
- `providerInfo(provider)` 返回的 `id` **必须 === 注册名**
- `providerRetryPolicy(provider)` **必须存在**（返回 `undefined` 即可）
- 流必须以 `usage` → `finish` 收尾
- `inject` 只写 `['llm']`

---

### P2 — 认证层固化

**做什么**：把 P0 的临时逻辑做成生产级 TS 模块。

1. `auth/refresh.ts`：
   - 模块级单飞去重（并发只刷一次）
   - 失败后 30 秒冷却
   - 刷新成功后**写回磁盘**，`expires = now + 30min`
   - 写回带 `expectedAccess` CAS 校验（防止和 `deveco` CLI 抢写覆盖）
2. 失效降级：拿不到 token 时，adapter 返回明确 401 语义（`finish.error` + `code: 'AUTH'`），**不要静默返回空**
3. 账号切换检测：解密出的 `userId` 变化时，清空目录缓存并重新拉取
4. 补单测：`crypto` 解密往返、`refresh` 单飞与冷却（用注入的 fake clock / fake fetch）

**验收**：
```bash
# 1. 单测绿
corepack pnpm test -- auth
# 2. 手工把 auth.json 的 expires 改到过去 → 发对话 → 应自动刷新并成功
# 3. 断网状态下发对话 → 应报 AUTH/TRANSPORT，而不是卡死
# 4. 并发发 3 条消息（token 已过期）→ 日志里应只有 1 次刷新请求
```

---

### P3 — 目录层

**做什么**：把写死的模型换成动态目录。

1. `catalog.ts`：
   - `GET modelConfig` → 解析 `inner_models` / `model_configs`（用 `@deepseek-ai/schemastery` 或手写类型守卫做解码）
   - 按 `task_default_model_map.blacklist` 过滤（**注意：被排除的模型仍留在 catalog，只在投影时丢**）
   - `reasoning_effort` 解析成 DSH 的思考档位（`level` 数组 + `default`）
   - 磁盘缓存 `<cache>/deveco-models-<sha256(jwt)>.json`
   - 周期刷新（默认 300 秒）+ 启动失败快速重试
2. `listModels` / `resolveModel` 改读 catalog
3. `status.ts`：每轮刷新写健康快照

**验收**：
```bash
# 1. 模型选择器里出现 GLM-5.1 + GLM-5.3（不应出现 Qwen3_VL）
# 2. 断网重启 → 用磁盘缓存，仍能列出模型
# 3. 改 refreshSeconds=10 → 上游目录变化后 ≤ 30 秒同步
# 4. 单测：blacklist 过滤、reasoning_effort 两形态解析、缓存过期
```

---

### P4 — wire 与错误语义（最大陷阱）

**做什么**：把"HTTP 200 里藏错误"这件事彻底处理干净。

1. `errors.ts` 识别四种形态：
   - SSE 帧 `event: error` + `data: {...}`
   - 裸 JSON `{"errorCode":4016,...}`
   - SSE `{"error":{"type":"WaitingInLine","code":"406"}}` → 归类为"排队"（可重试，不是失败）
   - SSE `{"error":{"param":{"originalMessage":"argument stream is false"}}}` → 路径错了
2. 非流式请求：`stream !== true`（**含字段缺失**）时改写路径到 `/no-stream/chat/completions`
3. `watchdog.ts`：首事件 30 秒 / 流中静默 120 秒
4. 错误映射到 DSH 的 `FinishReason`：`AUTH` / `RATE_LIMIT` / `QUOTA_EXCEEDED` / `SERVER` / `TRANSPORT` / `INVALID_REQUEST`
5. 重试策略：**交给 DSH**（`providerRetryPolicy` 返回 `undefined`），插件内不重试

**验收**：
```bash
# 1. 坏 token → DSH 显示 AUTH 类错误，不是空回复
# 2. 非流式场景（DSH 内部某些调用）→ 能拿到 JSON 结果
# 3. 上游返回 WaitingInLine → 日志标记排队，DSH 侧表现为可重试
# 4. 杀掉网络 → 30 秒内报 TRANSPORT，不无限挂起
# 5. 单测：四种错误报文喂给 errors.ts，断言分类正确
```

---

### P5 — 打磨与分发

1. `Config` 设置页（`providerId` / `refreshSeconds` / `watchdog` 三个可调项）
2. `cordis.patch.yml` 正确（`- insert: [{id, name, config}]`）
3. `README.md`：**诚实标注**合规边界（华为账号权益、中国大陆、实名、50 req/min）
4. `corepack pnpm pack` 产物校验：`dsh.bundle.patch` 可读、`exports` 正确、**不含任何凭据**、`lib/` 是 ESM

**验收**：
```bash
corepack pnpm typecheck && corepack pnpm test && corepack pnpm build && corepack pnpm pack
# 检查 tgz 内不含 token / auth.json / keys，且只含 lib/ 与元数据
```

---

## 5. 从 opencode2dsh 抄什么、不抄什么

| 来源文件 | 处置 |
| --- | --- |
| `adapter/events.ts` | ✅ **整搬**（纯 TS，零改动） |
| `adapter/messages.ts` 的 `toPiContext` | ✅ 搬，删掉 `bash`/`read` 门 |
| `src/index.ts` 骨架 | ✅ 搬形状，改 `name` / `PROVIDER_ID` / 数据目录 |
| `config.ts` 的 volatile 语义 | ✅ 搬（如需设置页） |
| `catalog.ts` 的刷新循环/重试/健康快照 | ✅ 搬结构，数据源换成 `modelConfig` |
| `adapter/ids.ts` | ❌ 全丢（那是 OpenCode 伪装） |
| `adapter/catalog.ts` 的 S1/S2/S3 | ❌ 丢（DevEco 是单源 + blacklist） |
| `provider.ts` + `agent-process.ts`（sidecar） | ❌ 丢（**本项目全程单进程，不做 sidecar**） |
| `ip-pool.ts` + `pool/*` + `client/*` | ❌ 丢（约 4000 行，与本项目无关） |

---

## 6. 已知风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| **与 `deveco` CLI 抢刷新** | 一方 token 被刷废 | 读 `expires` 再决定是否刷；写回带 CAS；失败退避 30 秒 |
| **200 内错误被当成功** | 静默空回复 | P4 专项处理，所有响应先过 `errors.ts` |
| **`stream` 缺失触发路径改写** | 非流式请求打错端点 | 判 `!== true` 而非 `=== false` |
| **`Chat-Id` 缺失** | 400 | 每请求生成 32hex；会话内保持稳定 |
| **JWT 30 天过期** | 无法自动恢复 | 检测到 `jwToken/check` 返回 `status:false` 时，提示用户跑 `deveco auth login` |
| **合规边界** | 不能公开发布为"免费模型" | README 诚实标注；不做多账号轮换 |
| **Node 类型剥离不支持的语法** | 运行期报错 | tsconfig 开 `erasableSyntaxOnly`；禁用 `enum`/`namespace`/参数属性 |
| **宿主版本差异** | 插件不加载 | 契约用结构性声明，不 import 宿主类型；P1 先在 0.2.1-rc.5 上验 |

---

## 7. 时间预估

| Phase | 内容 | 估时 |
| --- | --- | --- |
| P0 | 探针脚本（TS） | 0.5 天 |
| P1 | 插件骨架 | 0.5 天 |
| P2 | 认证层 | 1 天 |
| P3 | 目录层 | 0.5 天 |
| P4 | wire 与错误 | 1 天 |
| P5 | 打磨分发 | 0.5 天 |
| — | **合计** | **约 4 天** |

---

## 8. 立即开始的第一步

```bash
cd D:\dsh-deveco2api
# 计划：test/P0/P0.md
# 脚本：test/P0/probe.ts（TypeScript）：解密 → 刷新 → 目录 → 流式 → 非流式 → 两种错误
node test/P0/probe.ts
```

> P0 的完整规格（八项检查、输出格式、退出码、安全边界）见 [test/P0/P0.md](../test/P0/P0.md)。

**P0 不通过就不写插件。** 如果解密或刷新失败，先解决凭据问题（最可能的是 JWT 已过期，需要人工重新登录一次）。
