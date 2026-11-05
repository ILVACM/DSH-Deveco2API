<div align="center">

# dsh-deveco2api

**在 DSH（DeepSeek Harness）里原生使用 DevEco Code 的内置免费模型（GLM-5.1 / GLM-5.3）。**

复用本机 `deveco` CLI 已登录的华为账号凭据——无需 API Key、无子进程、无本地端口。

[English](README.md) | 简体中文

</div>

---

`dsh-deveco2api` 向 DSH 注册一个原生 `LlmAdapter`，直接流式对接 DevEco Code 的
内置模型通道（`cn.devecostudio.huawei.com`），让 `GLM-5.1` / `GLM-5.3` 以
`deveco2dsh` 这个常规 provider 出现在模型选择器里。

插件读取本机 `deveco` CLI 登录后留下的加密凭据（双层 AES-256-GCM），自动完成
30 分钟 access token 刷新，并按服务端目录动态维护模型白名单。无额外进程、无本地端口、无遥测。

## 快速开始

```powershell
cd D:\dsh-deveco2api\packages\plugin
corepack pnpm install && corepack pnpm pack
dsh plugin --profile desktop add "D:\dsh-deveco2api\packages\plugin\dsh-deveco2api-plugin-0.1.0.tgz"
```

重启 DSH → 模型选择器 → **deveco2dsh** 分组。完整步骤见 [install-guide.md](install-guide.md)。

> `pnpm` 不在 PATH 时，用 Node 自带的 `corepack pnpm` 前缀即可，无需全局安装。

## 前置条件

| 项 | 要求 |
| --- | --- |
| DSH | ≥ 0.1.7 |
| Node.js | ≥ 22 |
| deveco CLI | 已安装并登录（`deveco auth login`） |
| 网络 / 账号 | 可达 `cn.devecostudio.huawei.com`；已实名华为账号，仅中国大陆 |

## 特性

- 原生 adapter，无 sidecar、无子进程、无本地端口
- 复用本机登录态，自动刷新 token（单飞 + 冷却 + CAS 写回）
- 动态模型目录 + `blacklist` 过滤 + 磁盘缓存
- 模型白名单（上游对未知模型会静默回落，插件自己拦）
- `HTTP 200` 内藏的错误也能分类送达 DSH
- 合规边界诚实标注：中国大陆 + 实名 + 50 次/分钟

## 目录结构

```
├─ packages/plugin/     # 唯一 npm 包（纯 TS 插件）
│  ├─ src/              # index / config / catalog / auth / adapter
│  ├─ test/             # 26 项单测
│  └─ lib/              # 构建产物
├─ test/P0/             # P0 探针（凭据链路 + 协议验证）
├─ docs/                # 技术分析与开发计划
├─ scripts/             # 发布辅助脚本
├─ install-guide.md     # 安装指南
└─ README.md / README.zh-CN.md / CHANGELOG.md
```

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [install-guide.md](install-guide.md) | 安装、验证、配置、排查 |
| [docs/plan.md](docs/plan.md) | P0–P5 开发计划 |
| [docs/opencode-free-models-to-dsh.md](docs/opencode-free-models-to-dsh.md) | 参考实现分析 |
| [docs/deveco-vs-opencode-comparison.md](docs/deveco-vs-opencode-comparison.md) | DevEco vs OpenCode 认证对比 |
| [test/P0/P0.md](test/P0/P0.md) | P0 探针规格与实测发现 |

## 开发

```powershell
cd packages/plugin
corepack pnpm typecheck && corepack pnpm test && corepack pnpm build
```

## 合规声明

复用用户自己已登录的华为账号凭据，不伪造、不绕过认证。配额与地区限制由华为服务端控制，不支持多账号轮换。

## 许可证

[WTFPL](LICENSE)
