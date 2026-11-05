# Changelog

## 0.1.0 (2026-11-04)

首个可用版本。原生 DSH `LlmAdapter`，把 DevEco Code 内置模型（GLM-5.1 / GLM-5.3）接入 DSH 模型选择器。

### Added

- **凭据层**：读取本机 `deveco` CLI 的加密凭据（`auth.json` / `token.enc` / `token.dek` / `keys/`），双层 AES-256-GCM 解密；`kekId` 动态解析，不硬编码 `kek-v1`。
- **自动刷新**：`GET jwToken/check` + `refresh:true` + 长期 JWT；模块级单飞去重、30 秒失败冷却、CAS 写回（防与 deveco CLI 抢写）。
- **模型目录**：`GET modelConfig` 单源解析，`blacklist` 过滤，磁盘缓存（断网兜底），启动快速重试 + 300 秒周期刷新，健康快照写 `~/.dsh/deveco2dsh/status.json`。
- **模型白名单**：请求前校验模型 id。上游对不存在模型会**静默回落到 deepseek-v4-flash**，绝不把校验交给上游。
- **自写 wire 层**：直接对接 `sse/codeGenie/maas/v2/chat/completions`，处理 DevEco 的非标准协议（`id: N` 帧前缀、每帧带 usage、HTTP 200 里藏 `errorCode:4016`、SSE 内 `event: error`）。
- **消息转换**：DSH `GenerateOptions` → OpenAI Chat 格式；工具调用/工具结果往返；图片块降级占位；`</think>` 泄漏剥离。
- **思考档位**：按目录声明的 `reasoning_effort` 生成 DSH 档位选择器；`off` 不向上游传（实测 `off` 会触发 403）。
- **错误分类**：`AUTH` / `RATE_LIMIT` / `QUOTA_EXCEEDED` / `INVALID_REQUEST` / `SERVER` / `TIMEOUT` / `TRANSPORT` / `UPSTREAM`，失败一律以 `usage → finish.error` 收尾，不静默空回复。
- **配置**：`refreshSeconds` / `firstEventMs` / `bodyIdleMs` 三个可调项（schemastery）。
- **测试**：26 项单测（凭据往返、目录解析、事件转译、错误分类、消息构造），`node --test` 原生 runner。
- **P0 探针**：`test/P0/probe.ts`，一键验证凭据链路与上游协议，输出四态汇总与 JSON 报告。

### Notes

- 构建产物 `lib/` 约 47 KB（gzip 14 KB），tgz 约 18 KB；运行时依赖仅 `@deepseek-ai/schemastery`。
- 未引入 `pi-ai` / openai SDK：DevEco 的 SSE 帧与错误形态和 SDK 假设冲突，自写约 300 行更可控。
- 仅支持中国大陆地区、已实名华为账号；每账号 50 次/分钟（服务端强制）。
- 模型 text-only；GLM 系列思考会吃满 `max_tokens` 预算，插件已做空回复检测。
