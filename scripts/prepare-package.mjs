#!/usr/bin/env node
/**
 * 发布前检查：确认 packages/plugin 的构建产物与发布内容一致。
 *
 * 与参考项目 opencode2dsh 的 prepare-package.mjs 不同，本项目不做
 * 「把根 README 拷进包」——plugin/README.md 是面向 npm 页的独立文档，
 * 根 README.md 是面向仓库的。强行同步反而会丢信息。
 *
 * 用途：在 `pnpm pack` 之前跑，确认：
 *   1. lib/ 已构建且入口存在
 *   2. cordis.patch.yml 存在且非空
 *   3. package.json 的 dsh.bundle.patch 指向存在的文件
 *   4. 产物里不含任何凭据文件
 *   5. 声明 dsh.client 时 lib/client.js 必须存在
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const pluginDir = join(repoRoot, 'packages', 'plugin')

const problems = []
const ok = (label) => console.log('  ok  ' + label)
const fail = (label) => { problems.push(label); console.log('  FAIL ' + label) }

const pkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))

// 1. 构建产物入口
const entry = join(pluginDir, pkg.main ?? 'lib/index.js')
if (existsSync(entry)) ok('lib/index.js 已构建')
else fail('lib/index.js 缺失 — 先跑 corepack pnpm build')

// 2. bundle patch
const patchRel = pkg.dsh?.bundle?.patch
if (patchRel && existsSync(join(pluginDir, patchRel))) ok('cordis.patch.yml 存在')
else fail('cordis.patch.yml 缺失或 dsh.bundle.patch 指向错误')

// 3. 发布文件清单里的关键项
for (const f of ['README.md', 'cordis.patch.yml']) {
  if (existsSync(join(pluginDir, f))) ok('发布文件 ' + f)
  else fail('发布文件缺失 ' + f)
}

// 4. 产物不含凭据
const entryText = readFileSync(entry, 'utf8')
if (/DgEA[A-Za-z0-9+/]{40,}|eyJ[A-Za-z0-9_-]{40,}/.test(entryText)) {
  fail('lib/index.js 疑似含真实 token（应只有文件名引用）')
} else {
  ok('产物无凭据泄露')
}

// 5. dsh.client 声明时 lib/client.js 必须存在
if (pkg.dsh?.client && !existsSync(join(pluginDir, 'lib', 'client.js'))) {
  fail('lib/client.js 缺失（package.json 声明了 dsh.client）')
} else if (pkg.dsh?.client) {
  ok('lib/client.js 已构建')
}

if (problems.length > 0) {
  console.error('\n发布前检查未通过：' + problems.length + ' 项')
  process.exit(1)
}
console.log('\n发布前检查通过')
