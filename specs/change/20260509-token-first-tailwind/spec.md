---
id: 20260509-token-first-tailwind
name: Token First Tailwind
status: designed
created: '2026-05-09'
---

## Overview

### Problem Statement

- 当前前端样式集中在 `index.css`，贡献者改 UI 时容易集中修改同一个全局 CSS 文件，增加代码冲突概率。
- 项目已经有 CSS variable token 体系，需要把它作为视觉源头接入 Tailwind，让贡献者主要在 TSX 中用 Tailwind utilities 表达样式。
- 重构过程中需要保持现有前端展示稳定，尤其是整体页面风格和视觉调性。

### Goals

- 实现 token-first Tailwind：Tailwind 作为样式书写和组合工具，视觉 token 继续来自现有 CSS variables。
- 将现有 TSX 中依赖全局 CSS class 的组件样式迁移为 token-first Tailwind `className`，减少日常改动对 `index.css` 的依赖。
- 降低多人贡献时由全局 CSS 热点文件引起的冲突概率。
- 保持现有页面风格、明暗主题、暖色纸感调性和整体展示效果稳定。

### Scope

- 接入 Tailwind，并将现有设计 token 映射为可用的 Tailwind token classes。
- 保留 `index.css` 中的基础 token、全局基础样式和必须全局管理的内容样式。
- 建立约束，让贡献者优先使用项目 token 和基础 UI primitives。
- 本次保持现有组件抽象；在现有 TSX 中把可迁移的全局 CSS class 全量替换为 token-first Tailwind class。
- 采用分批落地方式，先完成工具链、token 映射和约束，再按区域迁移现有 TSX class，并保留必须全局管理的样式。

### Constraints

- 迁移期间前端展示不能漂移，整体页面风格保持一致。
- 全量迁移以现有视觉等价为准，迁移粒度按页面/组件区域分批推进。
- Tailwind 接入验证和迁移在现有组件内完成，组件抽象保持现状。
- `index.css` 继续承载全局 token 和基础样式，视觉源头保持为项目 CSS variables。

### Success Criteria

- Baseline：迁移开始时记录 `apps/web/src/index.css` 当前约 16,038 行、1,415 个 CSS class selectors，`apps/web/src/**/*.tsx` 当前约 51 个文件、2,126 个 `className=` occurrences；最终 PR 需要在 implementation notes 中刷新这些数字。
- TSX 迁移目标：可替换的组件级全局 class 按 PR slice 迁移完成，每个 slice 的 migrated / retained / deferred class 清单完整记录；最终 slice 后普通组件 UI 改动路径以 TSX Tailwind utilities 为主。
- `index.css` 保留目标：最终只保留 tokens、base、keyframes、loading shell、内容级/第三方边界样式和明确记录的 retained global styles；组件级 retained global class 需要逐项说明 owner、原因和后续处理点。
- Guard 目标：默认 Tailwind palette utilities 和未登记硬编码 app UI colors 在 `pnpm guard` 中失败；每个 allowlist entry 包含 file scope、pattern scope 和 reason。
- 视觉验收目标：Dashboard/app shell、project detail、settings dialog、file viewer/inspect overlay、sketch editor、live artifact card、modal/popover/control states 在 light、dark、system 和 custom accent 下对比；任一布局偏移、token 颜色漂移、radius/shadow 差异或主题状态差异都需要修复或记录为批准 deviation。

## Research

### Existing System

- `apps/web` 的全局 CSS 入口是 Next root layout 中的 `../src/index.css` import。Source: `apps/web/app/layout.tsx:1-4`
- 产品主体通过 `dynamic(() => import('../../src/App'), { ssr: false })` 作为客户端 SPA 运行，loading shell 仍依赖全局 class `od-loading-shell`。Source: `apps/web/app/[[...slug]]/client-app.tsx:5-13`
- `apps/web` 当前依赖包含 Next、React、React DOM 和测试工具，未在 `dependencies` / `devDependencies` 中声明 Tailwind、PostCSS 或 Autoprefixer。Source: `apps/web/package.json:30-50`
- 根 package 只保留仓库级工具脚本和 TypeScript/tsx dev dependencies，未在 root devDependencies 中声明 Tailwind/PostCSS 相关包。Source: `package.json:12-29`
- 当前视觉源头集中在 `apps/web/src/index.css` 的 CSS variables：surface、border、text、accent、semantic colors、shadow、radius、font tokens 都在 `:root` 定义。Source: `apps/web/src/index.css:6-63`
- 暗主题通过 `[data-theme="dark"]` 覆盖同一批 token，系统模式通过 `@media (prefers-color-scheme: dark)` 和 `html:not([data-theme])` 覆盖 token。Source: `apps/web/src/index.css:65-157`
- 基础 reset、body 字体/背景/文字颜色和 loading shell 都在 `index.css` 中全局定义。Source: `apps/web/src/index.css:160-181`
- `index.css` 同时承担组件样式职责，例如 button base、primary、ghost 变体等全局选择器。Source: `apps/web/src/index.css:183-219`
- `index.css` 也承载全局 animation 和复杂组件区域样式，例如 settings modal keyframes 和 live artifact badge/card 样式。Source: `apps/web/src/index.css:1121-1143,6219-6299`
- 现有 TSX 通过大量语义化全局 class 连接到 `index.css`，全量迁移需要按功能区域把这些 class 的视觉语义内联为 token-first Tailwind utilities，同时把确需跨树生效的 loading shell、keyframes 和内容级样式留在全局 CSS。Source: `apps/web/src/index.css:183-219,1121-1143,6219-6299`; `apps/web/src/runtime/markdown.tsx:112-196`; `apps/web/src/components/SketchEditor.tsx:220-339`; `apps/web/src/components/pet/PetRail.tsx:58-170`
- 运行时支持用户自定义 accent color：`applyAppearanceToDocument()` 会向 `document.documentElement` 写入 `--accent*` CSS variables，且 mix ratios 要和 pre-hydration script 保持一致。Source: `apps/web/src/state/appearance.ts:17-25,28-52`; `apps/web/app/layout.tsx:21-29`

### Available Approaches

- Tailwind CSS v4 的 Next.js 官方接入路径使用 `tailwindcss`、`@tailwindcss/postcss`、`postcss`，PostCSS 配置加载 `@tailwindcss/postcss`，CSS 中使用 `@import "tailwindcss"`。Source: `https://tailwindcss.com/docs/guides/nextjs`; `https://tailwindcss.com/docs/installation/using-postcss`
- Tailwind CSS v4 支持 CSS-first theme variables，`@theme` 中的 `--color-*` namespace 会生成 `bg-*`、`text-*`、`border-*` 等颜色 utilities。Source: `https://tailwindcss.com/docs/theme`; `https://tailwindcss.com/docs/customizing-colors`
- Tailwind CSS v4 可以通过 `--color-*: initial` 清空默认颜色 namespace，再只声明项目 token 对应的 color variables。Source: `https://tailwindcss.com/docs/customizing-colors`
- Tailwind CSS v3 的主题颜色配置主要通过 `tailwind.config.js` / `theme.colors` 完成；v4 官方文档把主题值迁移到 CSS theme variables。Source: `https://v3.tailwindcss.com/docs/theme`; `https://tailwindcss.com/docs/upgrade-guide`
- 仓库现有 `guard` 机制已经以 TypeScript 脚本形式聚合检查，并在失败时设置非零 exit code，可扩展为 token/Tailwind 约束检查入口。Source: `scripts/guard.ts:6-9,401-422`
- Web 测试位于 `apps/web/tests/`，已有组件、runtime、state、provider 等 Vitest 覆盖，适合承载新工具函数和样式约束的轻量测试。Source: `apps/AGENTS.md:19-24`; `apps/web/package.json:23-29`

### Alternatives Considered

- Keep CSS variables plus CSS Modules or component-scoped CSS: this preserves the current token source and reduces selector leakage, while continuing to require a separate stylesheet edit path for most UI changes. The chosen path keeps CSS variables as the visual source and moves component composition into TSX where contributors already edit behavior.
- Introduce a smaller project utility layer without Tailwind: a custom utility layer could expose only approved tokens, while the team would own naming, variants, responsive states, editor tooling expectations, and guard behavior. Tailwind v4 provides the utility compiler and variant system while still allowing the project to clear the default color namespace.
- Use Tailwind with a JS config or compatibility layer: a JS config can centralize theme values, while this repository's TypeScript-first guard and Tailwind v4 CSS-first model favor `@theme` values colocated with existing CSS variables. The PostCSS `.mjs` entry remains a narrow tool compatibility file and must be explicitly allowlisted.
- Extract shared UI primitives before class migration: primitives would reduce repeated class strings, while they would also turn this spec into a component architecture migration. This plan keeps current component boundaries, migrates visual expression first, and leaves primitive extraction as a later refactor once token utilities are stable.

### Constraints & Dependencies

- 迁移必须遵守 app 测试目录边界：`apps/web` 测试放在 `apps/web/tests/`，Playwright UI automation 放在 `e2e/ui/`。Source: `apps/AGENTS.md:19-24`
- Root command boundary 保留 `pnpm guard`、`pnpm typecheck` 等仓库级检查；web 验证使用 package-scoped 命令。Source: `AGENTS.md#Root command boundary`; `apps/AGENTS.md:39-51`
- 添加 Tailwind/PostCSS 依赖或配置会改变 package manifest / build entry，需要运行 `pnpm install` 让 workspace links 和 lockfile 保持一致。Source: `AGENTS.md#Validation strategy`; `apps/web/package.json:23-29`
- 当前存在合理硬编码色值场景：Agent 品牌图标使用品牌渐变和 SVG 颜色；Sketch canvas 使用用户绘图颜色和画布绘制颜色；FileViewer `rgbToHex()` 面向用户内容颜色转换。Source: `apps/web/src/components/AgentIcon.tsx:46-99`; `apps/web/src/components/SketchEditor.tsx:72,144-149`; `apps/web/src/components/FileViewer.tsx:1448-1474`
- 当前也存在可治理的 token 偏离：`NewProjectPanel` SVG preview 使用与现有 token 值相同或相近的硬编码色；`SettingsDialog` 局部 inline styles 使用旧 token fallback。Source: `apps/web/src/components/NewProjectPanel.tsx:797-825`; `apps/web/src/components/SettingsDialog.tsx:3807-3953`
- `index.css` 中仍有组件状态色使用具体 hex/rgba，例如 live artifact refreshing/failed badge 使用蓝/红硬编码色；这类样式迁移前需要先区分状态 token、品牌色、用户内容色和一次性插画色。Source: `apps/web/src/index.css:6270-6288`

### Key References

- `apps/web/app/layout.tsx:1-44` - web layout、CSS import、pre-hydration theme/accent script。
- `apps/web/app/[[...slug]]/client-app.tsx:1-17` - client-only App 入口和 loading shell class。
- `apps/web/src/index.css:1-219,1121-1143,6219-6299` - token、base、global component styles、keyframes、live artifact styles。
- `apps/web/src/state/appearance.ts:1-52` - runtime theme/accent CSS variable 写入。
- `apps/web/package.json:23-50` - web scripts and dependency surface。
- `scripts/guard.ts:138-151,205-221,328-350,401-422` - existing guard shape and failure behavior。
- `apps/AGENTS.md:19-24,39-51` - app test/layout and validation boundaries。
- `specs/change/20260509-token-first-tailwind/token.md` - Tailwind color/radius/shadow token vocabulary, existing CSS variable mapping, native font/spacing/type decision, and guardrail target。
- `https://tailwindcss.com/docs/guides/nextjs` - Tailwind v4 Next.js setup。
- `https://tailwindcss.com/docs/theme` - Tailwind v4 CSS-first theme variables and namespaces。

## Design

### Architecture Overview

```mermaid
flowchart TD
  CSS[apps/web/src/index.css\nCSS 变量 + 基础全局样式] --> Theme[@theme token 别名\nTailwind v4 utilities]
  Runtime[appearance.ts + layout themeInitScript\n运行时 accent 覆盖] --> CSS
  Theme --> TSX[React TSX className\ntoken-first utilities]
  Guard[pnpm guard\n样式约束] --> TSX
  Guard --> CSS
  Tests[apps/web/tests\nVitest 样式规则] --> Guard
```

### Change Scope

- 范围：`apps/web` 样式工具链。影响：在 web package 边界添加 Tailwind v4/PostCSS 依赖和配置，因为 `@open-design/web` 拥有 `dev/build/typecheck/test` 脚本，当前尚未声明 Tailwind/PostCSS 依赖。Source: `apps/web/package.json:23-50`; `https://tailwindcss.com/docs/guides/nextjs`
- 范围：`apps/web/src/index.css`。影响：保留 CSS variables、dark/system 主题覆盖、reset、body 样式、loading shell、keyframes 和真正全局的内容样式；在同一入口加入 Tailwind import/theme 层，让现有 `layout.tsx` import 继续作为唯一全局 CSS 入口，并移除已经迁移到 TSX 的组件级全局 class。Source: `apps/web/app/layout.tsx:1-4`; `apps/web/src/index.css:6-181,1121-1143,6219-6299`
- 范围：现有 `apps/web/src/**/*.tsx`。影响：按页面/组件区域迁移可替换的全局 CSS class 到 token-first Tailwind `className`，保持 DOM 结构和组件职责稳定。Source: `apps/web/src/index.css:183-219`; `apps/web/src/**/*.tsx`
- 范围：token 映射。影响：把现有颜色、圆角和阴影 CSS variables 暴露成 Tailwind theme variables，同时保留运行时写入同一批 `--accent*` variables 的自定义 accent 行为；字体、间距和字号使用 Tailwind 原生 utilities。Source: `apps/web/src/index.css:6-63`; `apps/web/src/state/appearance.ts:17-52`; `apps/web/app/layout.tsx:21-29`; `specs/change/20260509-token-first-tailwind/token.md`; `https://tailwindcss.com/docs/theme`
- 范围：约束机制。影响：扩展 repository guard，显式检查默认 Tailwind palette classes 和未受控硬编码颜色，并为品牌/用户内容场景提供 allowlist。Source: `scripts/guard.ts:138-151,205-221`; `specs/change/20260509-token-first-tailwind/spec.md:75-77`
- 范围：测试与验证。影响：web 自有测试放在 `apps/web/tests/`；通过 `pnpm guard`、`pnpm typecheck`、`pnpm --filter @open-design/web test` 和 `pnpm --filter @open-design/web build` 验证。Source: `apps/AGENTS.md:19-24,39-51`; `AGENTS.md#Validation strategy`

### Design Decisions

- 决策：在 `apps/web` 使用 Tailwind CSS v4，依赖 `tailwindcss`、`@tailwindcss/postcss` 和 `postcss`，通过 PostCSS 配置，并在现有全局 CSS 入口使用 `@import "tailwindcss"`。Source: `apps/web/package.json:23-50`; `apps/web/app/layout.tsx:1-4`; `https://tailwindcss.com/docs/guides/nextjs`
- 决策：通过 CSS 中的 `@theme` 定义 Tailwind theme values，因为 v4 会把 `--color-*` theme variables 转成 `bg-*`、`text-*`、`border-*` 等 utilities。Source: `https://tailwindcss.com/docs/theme`; `https://tailwindcss.com/docs/customizing-colors`
- 决策：把 Tailwind 颜色 tokens 映射到现有运行时 CSS variables，例如 `--color-bg: var(--bg)`、`--color-panel: var(--bg-panel)`、`--color-accent: var(--accent)`、`--color-danger: var(--red)` 和 `--color-success: var(--green)`。Source: `apps/web/src/index.css:6-63`; `apps/web/src/state/appearance.ts:17-52`; `specs/change/20260509-token-first-tailwind/token.md`
- 决策：声明项目颜色前，用 `--color-*: initial` 清空默认 Tailwind color namespace，让项目 classes 表达 Open Design token 集合。Source: `https://tailwindcss.com/docs/customizing-colors`; `apps/web/src/index.css:6-49`
- 决策：主题状态和自定义 accent 行为保持 CSS-variable-first；Tailwind utilities 通过 variables 解析，自动继承 light/dark/system/user accent 变化。Source: `apps/web/src/index.css:65-157`; `apps/web/src/state/appearance.ts:28-52`; `apps/web/app/layout.tsx:21-29`
- 决策：`index.css` 继续负责 token 定义、reset、基础元素行为、loading shell、keyframes 和跨内容区域样式；本次保持现有组件抽象，在现有 TSX 内全量迁移可替换的组件级全局 class 为 token-first Tailwind class。Source: `apps/web/src/index.css:160-219,1121-1143,6219-6299`; `apps/web/app/[[...slug]]/client-app.tsx:5-13`
- 决策：在 `scripts/guard.ts` 内添加项目自有样式约束检查，沿用现有 guard 聚合模型和 root command boundary。Source: `scripts/guard.ts:138-151,205-221,401-422`; `AGENTS.md#Root command boundary`
- 决策：品牌资产、SVG 插画、canvas/用户内容颜色和颜色转换 helper 允许显式例外；app UI chrome 使用 token classes 或 CSS variables。Source: `specs/change/20260509-token-first-tailwind/spec.md:75-77`
- 决策：项目自定义 Tailwind token 覆盖颜色、radius 和 shadow；radius/shadow utilities 解析到现有 CSS variables，确保卡片、弹窗、模态、输入、按钮和暗主题 shadow override 保持当前视觉；font、spacing 和 typography scale 使用 Tailwind 原生 utilities。Source: `specs/change/20260509-token-first-tailwind/token.md`
- 决策：添加依赖或配置相关 package 变更后运行 `pnpm install`，再执行 package-scoped web 验证和 repo 检查。Source: `AGENTS.md#Validation strategy`; `apps/web/package.json:23-29`

### Why this design

- 视觉事实继续由现有 CSS variables 承载，因此 light/dark/system 主题和自定义 accent 行为保持稳定，同时 Tailwind 成为组件级组合语言。
- 现有 TSX 的组件级样式迁移到 Tailwind class 后，日常 UI 改动主要落在局部组件文件，减少全局 CSS 热点冲突。
- 贡献者获得受约束的 Tailwind 词汇表，词汇表直接匹配产品的暖色纸感视觉语言。
- Tailwind 基础能力先落地，再通过 guardrails 和按区域迁移完成全量 TSX class 替换，降低样式重构风险。

### Test Strategy

- 工具链：运行 `pnpm install`，再运行 `pnpm --filter @open-design/web build`，证明 Next/Tailwind/PostCSS 集成可编译。Source: `apps/web/package.json:23-29`; `AGENTS.md#Validation strategy`
- 类型安全：配置和 TS guard 变更后运行 `pnpm typecheck` 和 `pnpm --filter @open-design/web typecheck`。Source: `AGENTS.md#Validation strategy`; `apps/AGENTS.md:39-51`
- 约束机制：为禁用默认 palette classes 和硬编码 UI 颜色添加/扩展 guard 覆盖，用 `pnpm guard` 验证。Source: `scripts/guard.ts:138-151,205-221,401-422`
- Web 测试：新增 style-policy helper logic 时，在 `apps/web/tests/` 下添加聚焦的 Vitest 覆盖。Source: `apps/AGENTS.md:19-24`; `apps/web/package.json:23-29`
- 视觉稳定性：在本地 web runtime 按主要页面/组件区域验证 Tailwind token utilities 在 light/dark/system theme 和 custom accent 场景下解析到同一套 CSS variables。Source: `apps/web/src/index.css:65-157`; `apps/web/src/state/appearance.ts:28-52`

### Pseudocode

流程：
  给 `apps/web` 添加 Tailwind v4 packages。
  添加使用 `@tailwindcss/postcss` 的 `apps/web/postcss.config.mjs`。
  在 `apps/web/src/index.css` 的项目层之前 import Tailwind。
  声明指向现有 CSS variables 的 colors、radius 和 shadow `@theme` aliases。
  清空默认 color namespace，只暴露批准的项目颜色。
  将 `apps/web/postcss.config.mjs` 加入 residual JavaScript guard 精确 allowlist，并记录 PostCSS/Tailwind 配置加载器需要 `.mjs` 入口的兼容理由。
  添加 guard helper，扫描 TSX/CSS 中禁用的 palette classes 和硬编码 UI 颜色。
  为品牌、用户内容、canvas 和颜色转换场景添加 allowlist entries。
  盘点现有 TSX 中引用的全局 CSS class，并按页面/组件区域全量替换为 token-first Tailwind classes。
  从 index.css 移除已迁移的组件级 class，保留 token、base、loading shell、keyframes 和内容级全局样式。
  运行 install、guard、typecheck、web tests 和 web build。

### File Structure

- `apps/web/package.json` - 在 web package 边界添加 Tailwind/PostCSS dependencies。
- `apps/web/postcss.config.mjs` - 配置 Tailwind v4 PostCSS plugin；该文件需要在 residual JavaScript guard 中用精确路径 allowlist，因为 PostCSS 配置加载器消费 `.mjs` 配置入口。
- `apps/web/src/index.css` - 保留全局 tokens/base styles，并添加 Tailwind import/theme aliases。
- `specs/change/20260509-token-first-tailwind/token.md` - 记录 Tailwind color/radius/shadow token 命名、与现有 CSS variables 的对应关系，以及 font/spacing/type 使用 Tailwind 原生 utilities 的设计决策。
- `apps/web/src/**/*.tsx` - 将可迁移的全局 CSS class 全量替换为 token-first Tailwind class。
- `scripts/guard.ts` - 给现有 repo guard 添加 PostCSS config residual JavaScript allowlist 和 style policy checks。
- `apps/web/tests/` - 抽取 style policy helpers 时添加聚焦测试。

### Interfaces / APIs

- Tailwind class vocabulary 使用项目 token 名称，例如 `bg-bg`、`bg-panel`、`bg-subtle`、`text-text`、`text-muted`、`border-border`、`text-accent`、`bg-accent`、`text-danger`、`bg-success-surface`、`bg-selection-overlay`、`rounded-card` 和 `shadow-token-sm`；字体、间距和字号使用 Tailwind 原生 utilities，例如 `font-mono`、`gap-3` 和 `text-sm`。
- Runtime appearance API 保持不变：`applyAppearanceToDocument()` 继续向 `document.documentElement` 写入 CSS variables。
- 仓库命令保持不变：贡献者继续使用现有 `pnpm guard`、`pnpm typecheck` 和 package-scoped web commands。

### Edge Cases

- Custom accent color 会更新 Tailwind 派生的 accent utilities，因为 utilities 通过 `var(--accent*)` 解析。
- Dark/system mode 继续工作，因为 token values 仍由 `[data-theme="dark"]` 和 `html:not([data-theme])` media overrides 提供。
- Brand icons、用户 sketch colors、canvas drawing colors 和 file color conversion helpers 需要显式 allowlist 处理。
- Loading shell 保持全局，因为它在 client SPA component tree 可用前渲染。
- 现有长尾全局 CSS 需要分类处理：组件级样式迁移到 TSX，loading shell、keyframes、第三方/内容渲染边界和真正跨树样式继续保留全局。

### Guardrail Rules

Guard 需要覆盖三类规则，并为每个例外记录文件范围、匹配模式和理由。

1. 默认 Tailwind palette class 检查：在 app UI 文件中拒绝 `text-red-500`、`bg-white`、`border-zinc-200`、`from-orange-500`、`ring-blue-400` 等默认 palette utilities。允许的颜色 utility 来自 `token.md` 中 `@theme` 暴露的项目 token。
2. 硬编码 UI color 检查：在 app UI chrome 和组件样式中拒绝未登记的 `#hex`、`rgb()`、`rgba()`、`hsl()`、`hsla()` 和命名色。命中后优先迁移到 Tailwind token class 或 CSS variable；重复出现的任意色需要新增命名 token。
3. 显式 allowlist 检查：允许品牌资产、SVG 插画、用户 accent 输入、canvas/sketch 用户色、文件/inspect 用户内容颜色转换、external document/iframe/popup runtime HTML、测试 fixture。allowlist 需要尽量窄，按文件、函数或 pattern 标注原因，避免路径级豁免覆盖普通 UI chrome。

## Plan

### Migration slices

Each migration PR should be reviewable on its own, keep business logic stable, and include rollback criteria that restores the previous global class path for that slice.

1. Foundation slice, owner: web/platform implementer. Add dependencies, PostCSS config, residual JS allowlist, theme aliases, and guard scaffolding. Roll back by reverting package/config/guard/theme changes together.
2. Shell and common controls slice, owner: web UI implementer. Migrate app shell, buttons, inputs, cards, popovers, and modals using token-backed colors/radius/shadows. Roll back by restoring the affected global class selectors and TSX class names for the slice.
3. Settings and project panels slice, owner: feature-area implementer. Migrate settings dialogs, project creation, project detail panels, and status surfaces. Roll back by restoring the slice selectors and disabling only the slice-specific guard assertions.
4. File viewer, inspect, and edit-mode slice, owner: file/inspect implementer. Migrate inspect/comment overlays to `selection`/`inspect` tokens and keep user-authored file color conversion helpers allowlisted. Roll back by restoring overlay variables/selectors and the slice-specific token mapping.
5. Sketch, runtime content, and external document slice, owner: runtime/content implementer. Migrate app chrome around canvases and runtime surfaces while retaining user content, iframe, popup, generated runtime HTML, and fixtures under explicit exceptions. Roll back by restoring retained boundary styles for this slice.
6. Cleanup and enforcement slice, owner: web/platform implementer. Remove migrated component-level selectors, tighten guard allowlists, refresh baseline counts, and record retained/deferred globals. Roll back by loosening guard entries and restoring removed selectors from the prior slice commit.

### Open Questions

| Question | Owner | Resolution point |
| --- | --- | --- |
| Exact style guard allowlist entries and path/pattern scopes | Web/platform implementer | Foundation slice before strict guard lands |
| Visual regression capture method and reviewer checklist | Web UI owner | Before first component migration slice merges |
| Final retained global CSS inventory | Web/platform implementer | Cleanup and enforcement slice |
| Dynamic class handling policy for each migrated component | Slice owner | During each slice before replacing dynamic class composition |
| Threshold for promoting repeated arbitrary colors to named tokens | Web UI owner | Foundation slice; default policy is promotion after the second real app UI use |
| Deferred component areas and owners | Web lead | Before cleanup and enforcement slice |

- [ ] Step 1: 安装 Tailwind 基础能力
  - [ ] Substep 1.1 Implement: 向 `apps/web/package.json` 添加 Tailwind v4/PostCSS dependencies。
  - [ ] Substep 1.2 Implement: 为 `@tailwindcss/postcss` 添加 web-local PostCSS config。
  - [ ] Substep 1.3 Implement: 在 `scripts/guard.ts` 的 residual JavaScript 精确 allowlist 中加入 `apps/web/postcss.config.mjs`，并用注释说明 PostCSS/Tailwind 配置入口需要 `.mjs` 兼容格式，避免 `pnpm guard` 阻断计划内配置文件。
  - [ ] Substep 1.4 Implement: 在 `apps/web/src/index.css` 中 import Tailwind，同时保留现有全局入口行为。
  - [ ] Substep 1.5 Verify: 运行 `pnpm install`。
  - [ ] Substep 1.6 Verify: 运行 `pnpm guard`，确认 PostCSS config allowlist 生效。
  - [ ] Substep 1.7 Verify: 运行 `pnpm --filter @open-design/web build`。
- [ ] Step 2: 把 Open Design tokens 暴露为 Tailwind utilities
  - [ ] Substep 2.1 Implement: 为 colors、core semantic status、selection/inspect overlays、radius 和 shadow tokens 添加 CSS-first `@theme` aliases；font、spacing 和 typography scale 使用 Tailwind 原生 utilities。
  - [ ] Substep 2.2 Implement: 清空默认 Tailwind colors，并声明项目批准的 color namespace。
  - [ ] Substep 2.3 Implement: 在 theme block 附近记录 token class vocabulary。
  - [ ] Substep 2.4 Verify: 确认 light、dark、system 和 custom accent modes 都通过同一套 CSS variables 解析。
  - [ ] Substep 2.5 Verify: 运行 `pnpm --filter @open-design/web build`。
- [ ] Step 3: 添加样式 guardrails
  - [ ] Substep 3.1 Implement: 在 `scripts/guard.ts` 中添加 app UI code 默认 Tailwind palette classes 检查。
  - [ ] Substep 3.2 Implement: 添加硬编码 UI color 检查，覆盖 `#hex`、`rgb()`、`rgba()`、`hsl()`、`hsla()` 和命名色。
  - [ ] Substep 3.3 Implement: 添加显式 allowlist 机制，覆盖 brand assets、SVG illustrations、user accent input、canvas/sketch user colors、user-authored file/inspect colors、external runtime documents 和 tests/fixtures。
  - [ ] Substep 3.4 Implement: 需要抽取 helper 时，在 `apps/web/tests/` 下添加聚焦测试。
  - [ ] Substep 3.5 Verify: 运行 `pnpm guard`。
  - [ ] Substep 3.6 Verify: 故意在一个 TSX 文件中临时写入默认 Tailwind 原生颜色 class（例如 `text-red-500`），确认 `pnpm guard` 能检出并失败，然后移除临时代码。
  - [ ] Substep 3.7 Verify: 故意在普通 app UI TSX 中临时写入未 allowlist 的硬编码色（例如 `style={{ color: '#ff0000' }}`），确认 `pnpm guard` 能检出并失败，然后移除临时代码。
  - [ ] Substep 3.8 Verify: 运行 `pnpm --filter @open-design/web test`。
- [ ] Step 4: 盘点并分类现有全局 class
  - [ ] Substep 4.1 Implement: 生成 `apps/web/src/**/*.tsx` 中引用的全局 CSS class 清单，并映射到 `apps/web/src/index.css` 中的定义。
  - [ ] Substep 4.2 Implement: 将 class 分为组件级可迁移样式、全局基础样式、loading shell、keyframes/animation、内容级/第三方边界样式和需保留例外。
  - [ ] Substep 4.3 Implement: 为每个组件级 class 记录对应 token-first Tailwind utility 组合或迁移备注。
  - [ ] Substep 4.4 Verify: 确认迁移清单覆盖所有 TSX 引用的全局 class；迁移清单只作为实现参考，实际迁移范围和分类以实现时的当前代码为准，遇到 rebase 后新增或变化的 class 时现场重新判断。
- [ ] Step 5: 全量迁移现有 TSX class
  - [ ] Substep 5.1 Implement: 按页面/组件区域把组件级全局 class 替换为 token-first Tailwind class，保持现有组件抽象和业务逻辑稳定。
  - [ ] Substep 5.2 Implement: 保留必要的动态 class 组合时，使用完整静态 class map，例如 `{ success: 'bg-success-surface text-success', danger: 'bg-danger-surface text-danger' }`；需要运行时生成 class 的场景必须有显式 safelist 和 guard/test 覆盖。
  - [ ] Substep 5.3 Implement: 对当前依赖 `--radius*` 和 `--shadow*` 的卡片、popover、modal、输入与按钮样式，使用 `rounded-card`、`rounded-panel`、`rounded-token-pill`、`shadow-token-sm`、`shadow-token-md` 等 variable-backed Tailwind utilities，保持暗主题 shadow override 和现有圆角比例。
  - [ ] Substep 5.4 Implement: 从 `index.css` 移除已迁移的组件级 class 定义，保留仍被全局边界使用的样式。
  - [ ] Substep 5.5 Verify: 确认 Tailwind token utilities 在 light/dark/system/custom accent modes 下通过 CSS variables 解析。
  - [ ] Substep 5.6 Verify: 确认 `index.css` 中的 global loading shell、base styles、keyframes 和 content-wide CSS 继续有效。
  - [ ] Substep 5.7 Verify: 运行 `pnpm --filter @open-design/web test`。
  - [ ] Substep 5.8 Verify: 运行 `pnpm --filter @open-design/web build`。
- [ ] Step 6: 最终验证与稳定化
  - [ ] Substep 6.1 Verify: 运行 `pnpm guard`。
  - [ ] Substep 6.2 Verify: 运行 `pnpm typecheck`。
  - [ ] Substep 6.3 Verify: 运行 `pnpm --filter @open-design/web test`。
  - [ ] Substep 6.4 Verify: 运行 `pnpm --filter @open-design/web build`。
  - [ ] Substep 6.5 Implement: 在 `## Notes` 记录 implementation notes、迁移清单结果和任何批准的 deviations。

## Notes

<!-- Optional sections — add what's relevant. -->

### Implementation

<!-- Files created/modified, decisions made during coding, deviations from design -->

### Verification

<!-- How the feature was verified: tests written, manual testing steps, results -->
