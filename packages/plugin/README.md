# deveco2dsh

**在 DSH（DeepSeek Harness）里原生使用 DevEco Code 的内置免费模型（GLM-5.1 / GLM-5.3）。**

复用本机 `deveco` CLI 已登录的华为账号凭据——无需额外注册、无需 API Key、无子进程、无本地端口。

## 前置条件

- **DSH ≥ 0.1.7**（需支持 `LlmAdapter` 插件契约）
- **Node.js ≥ 22**
- **本机已安装并登录 DevEco Code CLI**：
  ```bash
  npm install -g @deveco/deveco-code
  deveco auth login
  ```
  登录后会在 `~/.local/share/deveco/auth.json` 留下加密凭据，插件直接读取。
- 出站 HTTPS 需可达 `cn.devecostudio.huawei.com`（仅中国大陆地区可用，需实名认证的华为账号）

## 安装

完整步骤见仓库根目录 [install-guide.md](../../install-guide.md)。最短路径：

```powershell
cd D:\dsh-deveco2api\packages\plugin
corepack pnpm install && corepack pnpm pack
dsh plugin --profile desktop add "D:\dsh-deveco2api\packages\plugin\dsh-deveco2api-plugin-0.1.0.tgz"
```

> `pnpm` 不在 PATH 时用 `corepack pnpm` 前缀（Node 自带 corepack），无需全局安装。
> tgz 必须传绝对路径，且装过旧版要先 `remove` 再 `add`。

### 验证

重启 DSH，打开模型选择器，在 **deveco2dsh** 分组里选 `GLM-5.1` 或 `GLM-5.3`，发一条消息。

## 配置

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

## 工作原理

```
DSH 会话
   │  GenerateOptions { provider:'deveco2dsh', model:'GLM-5.1', ... }
   ▼
DevEcoAdapter（注册的 LlmAdapter）
   │  1. 白名单校验（上游对未知模型会静默回落，必须自己挡）
   │  2. ensureValidToken()（读 ~/.local/share/deveco/auth.json，
   │     双层 AES-256-GCM 解密，过期自动刷新并写回）
   │  3. 构造请求（</think> 泄漏剥离 / reasoning_effort 归一化 / 输出预算 ≥128）
   ▼
POST https://cn.devecostudio.huawei.com/sse/codeGenie/maas/v2/chat/completions
   headers: authorization / Chat-Id / content-type / Session-Id / lang
   ▼
SSE 流（id: N + data: {...} 交替，每帧带 usage）
   │  4. 事件转译 → DSH chunk（7 种）
   ▼
DSH 渲染 + 工具调用循环
```

## 健康状态与排查

插件在每轮目录刷新后写健康快照：

```
~/.dsh/deveco2dsh/status.json
```

| 现象 | 处理 |
| --- | --- |
| 模型选择器里没有 deveco2dsh 分组 | 插件未加载；看 DSH 日志里 `deveco2dsh:` 前缀的输出 |
| 有分组但发消息报 AUTH | `deveco auth login` 重新登录（JWT 约 30 天过期） |
| 只有部分模型 | 上游目录轮换；`status.json` 看 `exposed` 数 |
| 对话报 INVALID_REQUEST | 模型不在白名单内；等目录刷新或重启 DSH |
| 429 / 配额 | 华为账号每分钟 50 次请求限额；稍后重试 |
| `pnpm` 不识别 | 改用 `corepack pnpm`，见 [install-guide.md](../../install-guide.md) |

## 已知限制

- **仅中国大陆地区可用**（华为服务端按地区限制）
- **需实名认证的华为账号**（登录 + 实名 + 产品协议三道闸）
- **每账号 50 次/分钟**（服务端强制）
- **模型 text-only**（不支持图片输入）
- **思考会吃满 max_tokens**（GLM 系列特性；插件已做 `</think>` 泄漏剥离与 EMPTY_RESPONSE 检测）

## 开发

```powershell
cd D:\dsh-deveco2api\packages\plugin
corepack pnpm typecheck && corepack pnpm test
corepack pnpm build
```

## 合规声明

本插件复用**用户自己已登录的华为账号凭据**（读取 `deveco` CLI 留在本机的加密文件），不伪造、不绕过任何认证。模型的可用性、配额与地区限制由华为服务端全权控制。**不支持多账号轮换**。

## 许可证

[WTFPL](../../LICENSE)
