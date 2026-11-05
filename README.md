<div align="center">

# dsh-deveco2api

**在 DSH（DeepSeek Harness）里原生使用 DevEco Code 的内置免费模型（GLM-5.1 / GLM-5.3）。**

复用本机 `deveco` CLI 已登录的华为账号凭据——无需 API Key、无子进程、无本地端口。

</div>

---

`dsh-deveco2api` 会向 DSH 注册一个原生的 `LlmAdapter`，直接流式对接
[DevEco Code](https://gitcode.com/openharmony-sig/deveco-code) 的**内置模型通道**
（`cn.devecostudio.huawei.com`），把 `GLM-5.1` / `GLM-5.3` 以 `deveco2dsh`
这个常规 provider 出现在你的 DSH 模型选择器里。

插件读取本机 `deveco` CLI 登录后留下的加密凭据（双层 AES-256-GCM），
自动完成 30 分钟 access token 的刷新，并按服务端目录动态维护模型白名单。
没有额外进程、没有本地端口、没有任何遥测。

> **与 [opencode2dsh](https://github.com/FishBottle7/opencode2dsh) 的区别**：
> 那个接的是 OpenCode Zen 的**匿名免费通道**（`Bearer public`，零登录）；
> 本项目接的是华为账号的**登录权益**（需登录 + 实名 + 中国大陆地区）。
> 详见 [docs/deveco-vs-opencode-comparison.md](docs/deveco-vs-opencode-comparison.md)。

## 特性

- **原生 adapter，无 sidecar** —— 一个 npm 包，没有子进程、没有二进制、没有本地端口
- **复用本机登录态** —— 不要求重新登录，读 `~/.local/share/deveco/auth.json` 即可
- **动态模型目录** —— `modelConfig` 单源 + `blacklist` 过滤 + 磁盘缓存 + 周期刷新
- **模型白名单** —— 上游对未知模型会静默回落，插件自己拦
- **规范的错误呈现** —— `HTTP 200` 里藏的错误也能分类送达 DSH
- **合规边界诚实标注** —— 仅限中国大陆 + 实名华为账号 + 50 次/分钟

## 安装

见 [install-guide.md](install-guide.md)。最短路径：

```powershell
cd D:\dsh-deveco2api\packages\plugin
corepack pnpm install && corepack pnpm pack
dsh plugin --profile desktop add "D:\dsh-deveco2api\packages\plugin\dsh-deveco2api-plugin-0.1.0.tgz"
```

重启 DSH，在模型选择器的 **deveco2dsh** 分组里选模型即可。

## 前置条件

| 项 | 要求 |
| --- | --- |
| DSH | ≥ 0.1.7（`LlmAdapter` 契约） |
| Node.js | ≥ 22 |
| deveco CLI | 已安装并登录（`deveco auth login`） |
| 网络 | 可达 `cn.devecostudio.huawei.com` |
| 账号 | 已实名认证的华为账号，仅中国大陆地区 |

## 工作原理

```
DSH 会话
   │  GenerateOptions { provider:'deveco2dsh', model:'GLM-5.1', ... }
   ▼
DevEcoAdapter（注册的 LlmAdapter）
   │  ① 模型白名单校验
   │  ② ensureValidToken()：读 auth.json → 双层解密 → 过期自动刷新并写回
   │  ③ 构造请求（剥离 </think> 泄漏 / reasoning_effort 归一化 / 输出预算 ≥128）
   ▼
POST https://cn.devecostudio.huawei.com/sse/codeGenie/maas/v2/chat/completions
   headers: authorization / Chat-Id / content-type / Session-Id / lang
   ▼
SSE 流（id: N + data: {...} 交替，每帧带 usage）
   │  ④ 事件转译 → DSH chunk（7 种），usage → finish 收尾
   ▼
DSH 渲染 + 工具调用循环
```

## 目录结构

```
dsh-deveco2api/
├─ packages/plugin/          # 唯一的 npm 包（DSH cordis 插件，纯 TS）
│  ├─ src/
│  │  ├─ index.ts            # name / Config / inject=['llm'] / apply()
│  │  ├─ config.ts           # schemastery 配置
│  │  ├─ catalog.ts          # modelConfig + blacklist + 缓存 + 刷新
│  │  ├─ auth/               # 凭据层（crypto / store / refresh）
│  │  └─ adapter/            # deveco-adapter / events / messages / wire
│  ├─ test/                  # node --test（26 项单测）
│  └─ lib/                   # 构建产物（tsdown）
├─ test/P0/                  # P0 探针（凭据链路 + 协议验证，可追溯）
├─ docs/                     # 技术分析报告与开发计划
├─ scripts/                  # 发布辅助脚本
├─ install-guide.md          # 安装指南
├─ cordis.patch.yml          # 根级 bundle patch
└─ README.md / CHANGELOG.md
```

## 开发

```powershell
cd packages/plugin
corepack pnpm install
corepack pnpm typecheck    # tsc --noEmit
corepack pnpm test         # node --test
corepack pnpm build        # tsdown → lib/
corepack pnpm pack         # → .tgz
```

> `pnpm` 可能不在 PATH，用 Node 自带的 `corepack pnpm` 前缀即可，无需全局安装。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [install-guide.md](install-guide.md) | 安装、验证、配置、排查 |
| [docs/plan.md](docs/plan.md) | P0–P5 开发计划 |
| [docs/opencode-free-models-to-dsh.md](docs/opencode-free-models-to-dsh.md) | 参考实现分析：OpenCode 免费模型如何引流进 DSH |
| [docs/deveco-vs-opencode-comparison.md](docs/deveco-vs-opencode-comparison.md) | DevEco Code vs OpenCode 对比，重点讲认证差异 |
| [test/P0/P0.md](test/P0/P0.md) | P0 探针规格与实测发现 |

## 合规声明

本插件复用**用户自己已登录的华为账号凭据**，不伪造、不绕过认证。模型可用性、
配额与地区限制由华为服务端全权控制。**不支持多账号轮换**，不做配额规避。

## 许可证

[WTFPL](LICENSE)
