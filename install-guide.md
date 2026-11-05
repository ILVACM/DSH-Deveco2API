# dsh-deveco2api 安装指南

**在 DSH（DeepSeek Harness）里使用 DevEco Code 的内置免费模型（GLM-5.1 / GLM-5.3）。**

复用本机 `deveco` CLI 已登录的华为账号凭据——无需 API Key、无子进程、无本地端口。

---

## 1. 前置条件

| 项 | 要求 | 检查方法 |
| --- | --- | --- |
| **DSH** | ≥ 0.1.7（需支持 `LlmAdapter` 插件契约） | 打开 DSH → 设置 → 关于 |
| **Node.js** | ≥ 22 | `node --version` |
| **deveco CLI** | 已安装并登录 | `deveco auth list` |
| **网络** | 可达 `cn.devecostudio.huawei.com` | 浏览器打开该地址 |
| **账号** | 华为账号已实名认证、已签产品协议 | 登录 deveco 后正常对话即满足 |

### 1.1 安装并登录 deveco CLI（如未安装）

```bash
npm install -g @deveco/deveco-code
deveco auth login
```

登录后会在本机留下加密凭据（`~/.local/share/deveco/auth.json`），插件直接读取，**不会修改或上传**。

### 1.2 确认登录成功

```bash
deveco auth list
```

应输出 `1 credentials`（`deveco oauth`）。然后跑一遍 P0 探针验证全链路：

```bash
cd D:\dsh-deveco2api
node test/P0/probe.ts
```

期望末尾显示 `✅ P0 通过（FAIL=0）`。

---

## 2. 安装插件

> 📌 **当前状态**：插件 `dsh-deveco2api-plugin@0.1.0` 已经装在本机 DSH 的
> `desktop` profile 里并且可用（含最新修复）。**本节是「从零安装 / 日后更新版本」的步骤，
> 你现在不需要执行**——日常使用直接跳到 §3 验证即可。
>
> 只整理仓库、不动 profile 是本次的约定；下面这些命令会改动 DSH 运行环境，
> 请在你确实要重装或升级时再执行。

### 2.1 从源码构建（推荐）

> ⚠️ **`pnpm` 可能不在 PATH 里**（本机实测：`pnpm: 术语 'pnpm' 不会被识别为…`）。
> Node 24 自带 **corepack**，用它即可，无需全局安装。下面三选一。

**方式 A —— `corepack pnpm`（最简，已实测通过）**

```powershell
cd D:\dsh-deveco2api\packages\plugin
corepack pnpm install
corepack pnpm pack
```

> 首次运行 corepack 会自动下载 pnpm（本机实测下载了 v12.16.1），稍等即可。
> `corepack pnpm install` 已实测输出 `Done in 18.1s`；`corepack pnpm pack` 已实测产出 tgz。

**方式 B —— DSH 自带的 pnpm（离线可用，已实测通过）**

```powershell
cd D:\dsh-deveco2api\packages\plugin
node "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs" install
node "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs" pack
```

> 对应 pnpm v11.28.5，无需联网下载。

**方式 C —— 临时启用 corepack 后直接用 `pnpm`**

```powershell
corepack enable
cd D:\dsh-deveco2api\packages\plugin
pnpm install
pnpm pack
```

### 2.2 安装到 DSH（⚠️ 会改动 profile，按需执行）

> ⚠️ **必须传 tgz 的绝对路径**——实测相对路径会让 pnpm 报 `getTarballIntegrity` 失败。
>
> 当前已装好且可用，**首次使用无需执行这一步**。仅在「重装 / 升级版本 / 换 profile」时才运行。

```powershell
dsh plugin --profile desktop add "D:\dsh-deveco2api\packages\plugin\dsh-deveco2api-plugin-0.1.0.tgz"
```

> 若之前装过同名旧版本，先移除再装（否则 pnpm 会报 `Already up to date`，不更新内容）：
> ```powershell
> dsh plugin --profile desktop remove dsh-deveco2api-plugin
> dsh plugin --profile desktop add "D:\dsh-deveco2api\packages\plugin\dsh-deveco2api-plugin-0.1.0.tgz"
> ```

> 另注：profile 的 `package.json` 里 `dsh-deveco2api-plugin` 依赖记录可能仍指向
> 早期的 tarball 路径（仓库目录调整前的旧位置）。**平时不影响已装插件运行**
> （DSH 读的是 `node_modules` 里的副本），只在全量 `pnpm install` / 升级时才会踩到。
> 需要时用上面的 `remove` + `add` 刷新依赖记录即可。

### 2.3 验证安装（只读，可随时执行）

```bash
dsh plugin --profile desktop list
```

应看到 `dsh-deveco2api-plugin@0.1.0`。

### 2.4 重启 DSH

**重启 DSH 后**（关闭再打开，或点刷新），打开模型选择器。

---

## 3. 验证

1. 模型选择器里出现 **`deveco2dsh`** 分组
2. 里面有 `GLM-5.1` 和 `GLM-5.3`
3. 选一个模型，发一条消息，收到流式回复

### 3.1 健康快照

插件在每轮目录刷新后写：

```
~/.dsh/deveco2dsh/status.json
```

正常状态：

```json
{
  "status": "ready",
  "total": 3,
  "exposed": 2
}
```

---

## 4. 配置（可选）

默认零配置。需要覆盖时编辑 profile 的 `cordis.patch.yml`：

```yaml
- insert:
    - id: deveco2dsh
      name: 'dsh-deveco2api-plugin'
      config:
        refreshSeconds: 300    # 模型目录刷新周期（秒）
        firstEventMs: 30000    # 首帧等待上限（毫秒）
        bodyIdleMs: 120000     # 流中静默上限（毫秒）
```

修改后重启 DSH。

---

## 5. 排查

| 现象 | 原因与处理 |
| --- | --- |
| `pnpm: 术语 'pnpm' 不会被识别为…` | pnpm 不在 PATH。**无需全局安装**，改用 `corepack pnpm install` / `corepack pnpm pack`（见 §2.1 方式 A） |
| `corepack pnpm` 首次卡住 | 正在下载 pnpm 二进制（本机实测约十几秒），等它完成即可 |
| `dsh plugin add` 报 `getTarballIntegrity` 失败 | 传的是相对路径；改用 tgz **绝对路径**（见 §2.2） |
| `dsh plugin add` 报 `Already up to date` | 旧版本未卸载；先 `dsh plugin --profile desktop remove dsh-deveco2api-plugin` 再装 |
| 模型选择器里没有 `deveco2dsh` 分组 | 插件未加载。看 DSH 日志里 `deveco2dsh:` 前缀的输出；确认 `dsh plugin list` 里有它 |
| 有分组但发消息报 `AUTH` | `deveco auth login` 重新登录（JWT 约 30 天过期） |
| 只有部分模型 | 上游目录轮换。`~/.dsh/deveco2dsh/status.json` 看 `exposed` 数 |
| 对话报 `INVALID_REQUEST` | 模型不在白名单（上游对未知模型会静默回落，插件自己挡）。等目录刷新或重启 |
| `429` / 配额耗尽 | 华为账号每分钟 50 次限额。稍后重试 |
| 流式回复为空但思考有内容 | GLM 系列特性：思考会吃满输出预算。把思考档位切到 `Off` 再试 |

---

## 6. 已知限制

- **仅中国大陆地区可用**（华为服务端按地区限制）
- **需实名认证的华为账号**（登录 + 实名 + 产品协议三道闸）
- **每账号 50 次/分钟**（服务端强制，客户端无实现）
- **模型 text-only**（不支持图片输入）
- **思考吃满输出预算**（GLM 系列特性；插件已做 `</think>` 泄漏剥离与空回复检测）

---

## 7. 开发

> 同样注意 `pnpm` 不在 PATH 的问题——统一用 `corepack pnpm` 前缀。

```powershell
cd D:\dsh-deveco2api\packages\plugin
corepack pnpm typecheck    # tsc --noEmit
corepack pnpm test         # node --test（26 项单测）
corepack pnpm build        # tsdown → lib/
corepack pnpm pack         # 打包 → .tgz
```

---

## 8. 合规声明

本插件复用**用户自己已登录的华为账号凭据**（读取 `deveco` CLI 留在本机的加密文件），不伪造、不绕过任何认证。模型的可用性、配额与地区限制由华为服务端全权控制。**不支持多账号轮换**，不做任何配额规避。
