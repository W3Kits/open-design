---
id: 20260513-unify-agent-runtime-abstraction
name: Unify Agent Runtime Abstraction
status: designed
created: '2026-05-13'
---

## Overview

### Problem Statement

- Agent runtime 差异目前仍暴露到上层调用路径中，上层模块仍可能需要感知具体 runtime 的协议、事件格式、parser、handler、stdout 形态或能力差异。
- 一个已知例子：`server.ts` 中对 `claude-stream-json`、`qoder-stream-json`、`copilot-stream-json`、`pi-rpc`、`acp-json-rpc`、`json-event-stream` 和 plain stdout 的显式处理。

### Goals

- 重构代码，统一 agent runtime 抽象。
- 将不同 agent runtime 的差异性封装到底层模块中。
- 让上层逻辑无需感知具体 runtime 的协议、parser、handler、事件格式或输出形态。

### Success Criteria

- 上层入口基于统一 runtime 定义调度 agent。
- 新增或调整 agent runtime 时，主要改动集中在底层 runtime 定义或适配模块。
- `server.ts` 和其他上层模块不再承担按具体 runtime、协议、parser、handler 或输出格式分支的职责。

## Research

### Existing System

- Agent runtime definitions live in `apps/daemon/src/runtimes/defs/*` and are aggregated by `AGENT_DEFS`; each definition declares `streamFormat`, plus runtime-specific fields such as `promptViaStdin`, `eventParser`, `supportsImagePaths`, and prompt-size limits. Source: `apps/daemon/src/runtimes/types.ts:37-68`, `apps/daemon/src/runtimes/registry.ts:19-36`
- Current runtime formats are encoded as string values on definitions: Claude, Qoder, Copilot, JSON-event streams, ACP JSON-RPC, Pi RPC, and plain stdout. Source: `apps/daemon/src/runtimes/defs/claude.ts:68-69`, `apps/daemon/src/runtimes/defs/qoder.ts:56-57`, `apps/daemon/src/runtimes/defs/copilot.ts:68-69`, `apps/daemon/src/runtimes/defs/codex.ts:79-81`, `apps/daemon/src/runtimes/defs/gemini.ts:35-37`, `apps/daemon/src/runtimes/defs/hermes.ts:26-28`, `apps/daemon/src/runtimes/defs/pi.ts:88-94`, `apps/daemon/src/runtimes/defs/deepseek.ts:44-54`
- `/api/chat` orchestration in `server.ts` uses `def.streamFormat` for prompt composition, MCP routing, stdin mode, stdin write behavior, SSE start metadata, critique eligibility, stream handler dispatch, Pi/ACP session storage, empty-output handling, and close-status mapping. Source: `apps/daemon/src/server.ts:3093-3125,3383-3390,3583-3586,3790-3794,3811-3814,3843-3860,3938-3944,4080-4176,4192-4264`
- Stream parsing is already partially modular: Claude, Qoder, Copilot, JSON-event, Pi RPC, and ACP each expose parser/session helpers that translate runtime-specific output into daemon events. Source: `apps/daemon/src/claude-stream.ts:1-30`, `apps/daemon/src/qoder-stream.ts:1-6,62`, `apps/daemon/src/copilot-stream.ts:1-22,31`, `apps/daemon/src/json-event-stream.ts:376-420`, `apps/daemon/src/pi-rpc.ts:337-379`, `apps/daemon/src/acp.ts:398-458`
- The connection-test path has a second runtime dispatch tree that mirrors the chat path for stream handlers, stdin mode, Pi/ACP sessions, and prompt writes. Source: `apps/daemon/src/connectionTest.ts:901-968,1126-1167,1197-1220,1284-1292`
- Plain stdout is special today: the prompt composer inserts API-mode override only when `streamFormat === 'plain'`, and the chat stream path forwards raw stdout chunks on the `stdout` SSE channel. Source: `apps/daemon/src/prompts/system.ts:258-267`, `apps/daemon/src/server.ts:4168-4172`

### Available Approaches

- **Central runtime adapter table**: keep current `RuntimeAgentDef` metadata, add a resolved runtime adapter object keyed by format or attached to the definition, and move stream/session attachment plus stdin prompt behavior out of `server.ts` and `connectionTest.ts`. Source: `apps/daemon/src/runtimes/types.ts:37-68`, `apps/daemon/src/server.ts:4080-4176`, `apps/daemon/src/connectionTest.ts:901-968`
- **Definition-owned runtime behavior**: extend each runtime definition with behavior hooks for spawn IO, stream attachment, prompt delivery, and completion semantics, so adding a runtime happens primarily in its definition module. Source: `apps/daemon/src/runtimes/registry.ts:19-36`, `apps/daemon/src/runtimes/defs/pi.ts:88-94`, `apps/daemon/src/runtimes/defs/deepseek.ts:44-54`
- **Shared attach helper used by chat and connection tests**: extract the duplicated stream/session dispatch into a daemon runtime module consumed by both `/api/chat` and connection tests. Source: `apps/daemon/src/server.ts:4080-4176`, `apps/daemon/src/connectionTest.ts:901-968`
- **Two-layer model**: keep process launch/env/args in runtime definitions and put protocol/session handling in lower-level adapter helpers, matching the existing split between `defs/*` and parser/session modules. Source: `apps/daemon/src/runtimes/defs/claude.ts:60-69`, `apps/daemon/src/claude-stream.ts:1-30`, `apps/daemon/src/acp.ts:398-458`

### Constraints & Dependencies

- The unified abstraction must preserve the existing daemon event contract: structured handlers emit `agent` events, plain streams emit `stdout`, errors emit `error`, and run completion emits `end`. Source: `apps/daemon/src/runs.ts:49-89`, `apps/daemon/src/server.ts:4061-4078,4168-4172,4264`
- Pi RPC and ACP sessions are cancellation/completion-aware and are stored on `run.acpSession` so cancellation and close handling can call session methods instead of relying only on raw process signals. Source: `apps/daemon/src/server.ts:4101-4176,4196-4241`
- Some stream formats need special failure semantics: Qoder, Pi RPC, and JSON-event streams route through `sendAgentEvent` so structured error frames and empty-output runs become failed chat runs. Source: `apps/daemon/src/server.ts:4088-4092,4101-4142,4155-4167,4196-4223`
- Critique Theater currently only supports plain stdout and explicitly skips structured formats, so any abstraction must keep this eligibility decision visible or move it into runtime capabilities. Source: `apps/daemon/src/server.ts:3079-3098,3923-3944`
- External MCP wiring differs by runtime: Claude writes `.mcp.json`, while ACP runtimes receive MCP server descriptors through the ACP session. Source: `apps/daemon/src/server.ts:3515-3586`
- Existing parser/session coverage lives in daemon tests and should remain the red/green safety net for behavior-preserving refactors. Source: `apps/daemon/tests/structured-streams.test.ts:1-10`, `apps/daemon/tests/qoder-stream.test.ts:1-18`, `apps/daemon/tests/json-event-stream.test.ts:1-14`, `apps/daemon/tests/pi-rpc.test.ts:1-10`, `apps/daemon/tests/acp.test.ts:1-10`

### Key References

- `apps/daemon/src/server.ts:3141-4269` - main `/api/chat` run setup, spawn, stream/session dispatch, and completion handling.
- `apps/daemon/src/connectionTest.ts:901-1292` - duplicated runtime dispatch path for agent connection tests.
- `apps/daemon/src/runtimes/types.ts:37-68` - runtime definition shape and existing capability fields.
- `apps/daemon/src/runtimes/registry.ts:19-48` - runtime definition registry and duplicate-id guard.
- `apps/daemon/src/json-event-stream.ts:394-399` - shared JSON-event parser selects sub-parser by runtime kind.
- `apps/daemon/src/pi-rpc.ts:337-379` and `apps/daemon/src/acp.ts:398-458` - session-based runtime adapters with fatal-error handling.

## Design

### Architecture Overview

```mermaid
flowchart TD
  Def[RuntimeAgentDef\nlaunch metadata + adapter id] --> Resolver[resolveRuntimeAdapter(def)]
  Resolver --> Adapter[RuntimeAdapter\nprotocol/session/output behavior]
  Chat[/api/chat startChatRun] --> Adapter
  Conn[connectionTest] --> Adapter
  Adapter --> Sink[RuntimeSink]
  Sink --> SSE[SSE: agent/stdout/stderr/error/end]
  Adapter --> Session[RuntimeSession\ncancel/fatal/completion]
  Session --> Run[run.runtimeSession\ncompat: run.acpSession]
```

采用两层模型：`RuntimeAgentDef` 保留进程启动、参数、环境、能力声明等元数据；新增 daemon-local runtime adapter 层统一承接协议/session/stdout/parser/完成语义。`server.ts` 和 `connectionTest.ts` 只解析 adapter 并调用统一方法，不再按具体 `streamFormat` 分支。

### Change Scope

- Area: daemon runtime definitions. Impact: 将 `RuntimeAgentDef.streamFormat` 从上层分支依据逐步收敛为 adapter 选择器或兼容字段，保留 `buildArgs`、env、model、image、prompt budget 等 launch metadata。Source: `apps/daemon/src/runtimes/types.ts:37-68`, `apps/daemon/src/runtimes/registry.ts:19-48`
- Area: daemon runtime adapter module. Impact: 新增 `apps/daemon/src/runtimes/runtime-adapters.ts`（或同等模块）集中实现 parser/session/stdin/prompt/MCP/close policy。Source: `apps/daemon/src/server.ts:4080-4176`, `apps/daemon/src/connectionTest.ts:901-968`
- Area: `/api/chat` orchestration. Impact: `server.ts` 保留 run 生命周期、spawn、SSE sink 和诊断，但通过 adapter 处理 stdin、prompt delivery、stream attachment、runtime session、close override。Source: `apps/daemon/src/server.ts:3787-3860,4061-4264`
- Area: connection tests. Impact: `connectionTest.ts` 复用同一 adapter attach/close 行为，避免第二套 runtime dispatch drift。Source: `apps/daemon/src/connectionTest.ts:901-968,1126-1292`
- Area: prompt composition and critique eligibility. Impact: 用 adapter capability 表达 plain/API prompt mode 与 Critique Theater eligibility，避免上层继续以 `streamFormat === 'plain'` 推断。Source: `apps/daemon/src/prompts/system.ts:258-267`, `apps/daemon/src/server.ts:3079-3098,3923-3944`
- Area: external MCP delivery. Impact: Claude `.mcp.json` 与 ACP MCP descriptors 进入 adapter prepare hook，上层只传递规范化 MCP context。Source: `apps/daemon/src/server.ts:3515-3586`

### Design Decisions

- Decision: 使用“definition = launch metadata，adapter = protocol behavior”的两层模型；`server.ts`/`connectionTest.ts` 不直接分支具体 parser/session/runtime format。Source: `apps/daemon/src/runtimes/types.ts:37-68`, `apps/daemon/src/server.ts:4080-4176`, `apps/daemon/src/connectionTest.ts:901-968`
- Decision: adapter 解析必须 fail fast；每个 `AGENT_DEFS` entry 必须解析到 adapter，未知 adapter id 直接抛错，不回退到 plain/mock behavior。Source: `apps/daemon/src/runtimes/registry.ts:19-48`, `apps/daemon/src/runtimes/types.ts:50-55`
- Decision: 引入 `RuntimeSink`，由共享 sink 维护 `agent`/`stdout`/`stderr`/`error` 发射、activity 更新、structured error、substantive-output tracking；adapter 只把协议输出规范化给 sink。Source: `apps/daemon/src/server.ts:4061-4078,4088-4167`
- Decision: stdin mode 与 prompt delivery 属于 adapter；Pi/ACP 通过 session/RPC 交付 prompt，plain/JSON/stdin runtimes 才写 child stdin，避免双写。Source: `apps/daemon/src/server.ts:3811-3860,4101-4154,4266-4268`, `apps/daemon/src/connectionTest.ts:1126-1127,1284-1292`
- Decision: session-aware runtimes 返回统一 `RuntimeSession`，包含 `abort`、`hasFatalError`、`completedSuccessfully` 等能力；实现阶段可先写入 `run.runtimeSession` 并兼容赋值到现有 `run.acpSession`。Source: `apps/daemon/src/server.ts:4174-4176,4196-4244`, `apps/daemon/src/connectionTest.ts:893-899,1197-1220`
- Decision: close-status policy 由 adapter/session 提供 override；generic close handler 只合并 cancel、exit code、signal、stream error、empty-output guard 与 adapter override。Source: `apps/daemon/src/server.ts:4192-4264`, `apps/daemon/src/connectionTest.ts:1197-1220`
- Decision: prompt-mode、Critique Theater、substantive-output tracking 改为显式 capabilities，避免通过 `streamFormat` 字符串推断行为。Source: `apps/daemon/src/prompts/system.ts:258-267`, `apps/daemon/src/server.ts:3079-3098,3923-3944,4040-4078`
- Decision: 保持现有 SSE contract 不变；structured handlers 继续发 `agent`，plain streams 继续发 `stdout`，错误发 `error`，run 终止发 `end`。Source: `apps/daemon/src/runs.ts:49-89`, `apps/daemon/src/server.ts:4061-4078,4168-4172,4264`
- Decision: 本次重构不改变 Claude external MCP 写入失败的 best-effort 语义，只迁移位置；是否改为 hard failure 另行决策。Source: `apps/daemon/src/server.ts:3515-3586`

### Why this design

- 把 runtime 差异集中到 adapter，直接满足“新增/调整 runtime 主要改底层 runtime 定义或适配模块”的目标。
- 复用同一 adapter 给 chat 和 connection test，减少两条路径行为漂移。
- 保留现有 parser/session 模块和 SSE contract，降低行为保持型重构风险。
- 显式 capability 比 `streamFormat` 字符串推断更可维护，也让 Critique Theater、prompt mode、empty-output guard 等业务决策可审查。

### Test Strategy

- Phase/area: adapter registry. Validation: 每个 `AGENT_DEFS` entry 可解析 adapter；未知 adapter id 抛错；禁止 silent plain fallback。Source: `apps/daemon/src/runtimes/registry.ts:19-48`
- Phase/area: adapter attach behavior. Validation: fake child streams 覆盖 Claude/Qoder/Copilot/JSON-event/plain/Pi/ACP 输出到正确 sink channel，stderr 保持 `stderr`。Source: `apps/daemon/src/server.ts:4080-4176`, `apps/daemon/src/connectionTest.ts:901-968`
- Phase/area: prompt/stdin/session. Validation: plain/stdin runtimes 写 stdin；Pi/ACP 不双写 stdin；Pi/ACP 暴露 fatal/completion/cancel handle。Source: `apps/daemon/src/server.ts:3811-3860,4101-4154,4266-4268`
- Phase/area: close semantics. Validation: Qoder/Pi/JSON-event error frame 标记 failed；tracked structured stream 空输出失败；ACP clean SIGTERM 成功；真实非零退出仍失败。Source: `apps/daemon/src/server.ts:4088-4167,4196-4244`
- Phase/area: duplication guard. Validation: 增加源边界回归测试或 guard，禁止 `server.ts`/`connectionTest.ts` 重新出现 `def.streamFormat ===`、直接 parser handler imports、直接 `attachAcpSession`/`attachPiRpcSession` 调用。Source: `apps/daemon/src/server.ts:4080-4176`, `apps/daemon/src/connectionTest.ts:901-968`
- Phase/area: existing regression suites. Validation: 继续运行 `apps/daemon/tests/structured-streams.test.ts`、`qoder-stream.test.ts`、`json-event-stream.test.ts`、`pi-rpc.test.ts`、`acp.test.ts`，以及 `pnpm --filter @open-design/daemon test`、`pnpm --filter @open-design/daemon typecheck`、`pnpm guard`、`pnpm typecheck`。Source: `apps/daemon/tests/structured-streams.test.ts:1-10`, `apps/daemon/tests/qoder-stream.test.ts:1-18`, `apps/daemon/tests/json-event-stream.test.ts:1-14`, `apps/daemon/tests/pi-rpc.test.ts:1-10`, `apps/daemon/tests/acp.test.ts:1-10`

### Pseudocode

Flow:
  Resolve `def = getAgentDef(agentId)`
  Resolve `adapter = resolveRuntimeAdapter(def)`; throw on missing adapter
  Ask adapter capabilities for prompt mode / critique eligibility / substantive-output tracking
  Compose prompt with explicit prompt mode capability
  Let adapter prepare runtime-specific external MCP delivery
  Spawn child with `adapter.stdinMode(ctx)`
  Create `RuntimeSink` bound to SSE + run state
  Call `attachment = adapter.attach({ child, prompt, cwd, model, mcpServers, sink, ... })`
  Store `attachment.session` on run for cancellation
  Let adapter deliver prompt when needed
  On close, merge generic status with `attachment.closePolicy` / session status

### File Structure

- `apps/daemon/src/runtimes/types.ts` - add adapter id/capability/session/adapter context types while preserving launch metadata.
- `apps/daemon/src/runtimes/runtime-adapters.ts` - adapter registry/resolver and shared behavior interfaces.
- `apps/daemon/src/runtimes/runtime-sink.ts` - normalized sink helpers for chat and connection test usage, if separating keeps dependencies cleaner.
- `apps/daemon/src/server.ts` - replace format dispatch with adapter calls; keep run lifecycle, SSE wiring, diagnostics, and spawn ownership.
- `apps/daemon/src/connectionTest.ts` - replace local `attachAgentStreamHandlers` dispatch with shared adapter attach and close policy.
- `apps/daemon/src/prompts/system.ts` and `packages/contracts/src/prompts/system.ts` - replace stream-format-based API/plain prompt decision with explicit semantic prompt mode if contract surface needs to stay aligned.
- `apps/daemon/tests/*runtime-adapter*.test.ts` - new focused adapter/sink/registry regression coverage.

### Interfaces / APIs

```ts
type RuntimeAdapterId =
  | 'plain'
  | 'claude-stream-json'
  | 'qoder-stream-json'
  | 'copilot-stream-json'
  | 'json-event-stream'
  | 'pi-rpc'
  | 'acp-json-rpc';

type RuntimeCapabilities = {
  promptMode: 'api-plain' | 'tooling';
  critiqueTheater: boolean;
  tracksSubstantiveOutput: boolean;
};

type RuntimeSink = {
  agent(ev: unknown): void;
  stdout(chunk: string): void;
  stderr(chunk: string): void;
  error(message: string, options?: { retryable?: boolean; details?: unknown }): void;
  activity(summary?: string): void;
};

type RuntimeSession = {
  abort?: () => void;
  hasFatalError?: () => boolean;
  completedSuccessfully?: () => boolean;
};

type RuntimeAttachment = {
  session?: RuntimeSession | null;
  flush?: () => void;
  closeOverride?: (exit: { code: number | null; signal: NodeJS.Signals | null }) => 'succeeded' | 'failed' | null;
};

type RuntimeAdapter = {
  id: RuntimeAdapterId;
  capabilities: RuntimeCapabilities;
  stdinMode(ctx: RuntimeContext): 'pipe' | 'ignore';
  prepareExternalMcp?(ctx: RuntimeContext): Promise<void>;
  attach(ctx: RuntimeAttachContext): RuntimeAttachment;
  deliverPrompt?(ctx: RuntimePromptContext): void;
};
```

### Edge Cases

- Qoder/Pi/JSON-event structured error frame 必须继续使 run failed，不能被当作普通 `agent` event 转发后成功结束。Source: `apps/daemon/src/server.ts:4088-4167,4196-4223`
- Pi/ACP session prompt delivery 与 stdin prompt delivery 互斥，避免 prompt 重复发送或 session 被破坏。Source: `apps/daemon/src/server.ts:3811-3860,4101-4154,4266-4268`
- ACP clean completion 后的 forced SIGTERM 仍应判定 succeeded；其他 signal/non-zero exit 保持 failed。Source: `apps/daemon/src/server.ts:4224-4244`, `apps/daemon/src/connectionTest.ts:1197-1220`
- Plain stdout 继续发 `stdout` 而不是 `agent`，避免改变 web/client event contract。Source: `apps/daemon/src/server.ts:4168-4172`
- `start` event 中的 `streamFormat` 如有客户端依赖可暂时保留为 opaque metadata，但上层代码不得再基于它分支。Source: `apps/daemon/src/server.ts:3787-3799`
- Claude CLI diagnostic tails 仍需从 raw stdout/stderr 捕获，迁移 adapter 时不能丢失诊断输入。Source: `apps/daemon/src/server.ts:3872-3882,4177-4183,4247-4264`

## Plan

- [ ] Step 1: Add adapter foundation
  - [ ] Substep 1.1 Implement: add runtime adapter id/capability/session/context types.
  - [ ] Substep 1.2 Implement: add adapter resolver covering every existing `AGENT_DEFS` runtime.
  - [ ] Substep 1.3 Implement: add normalized sink helpers without changing existing SSE channel names.
  - [ ] Substep 1.4 Verify: unit-test resolver coverage, unknown adapter failure, and sink channel mapping.
- [ ] Step 2: Move stream/session attachment behind adapters
  - [ ] Substep 2.1 Implement: migrate Claude/Qoder/Copilot/JSON-event/plain attachment logic into adapters.
  - [ ] Substep 2.2 Implement: migrate Pi/ACP session attachment and runtime session handles into adapters.
  - [ ] Substep 2.3 Implement: update `connectionTest.ts` to consume shared adapters first.
  - [ ] Substep 2.4 Verify: run daemon parser/session tests plus new fake-child adapter tests.
- [ ] Step 3: Refactor chat orchestration to adapter calls
  - [ ] Substep 3.1 Implement: replace `server.ts` stream-format dispatch with adapter attach/deliverPrompt/session/close policy calls.
  - [ ] Substep 3.2 Implement: move stdin mode, prompt delivery, external MCP preparation, and close overrides into adapter hooks.
  - [ ] Substep 3.3 Implement: preserve `run.acpSession` compatibility while introducing generic runtime session naming.
  - [ ] Substep 3.4 Verify: run daemon tests and add regression coverage for empty-output, structured error, and ACP clean SIGTERM behavior.
- [ ] Step 4: Remove upper-layer format knowledge
  - [ ] Substep 4.1 Implement: replace prompt mode and Critique Theater format checks with adapter capabilities.
  - [ ] Substep 4.2 Implement: add guard/regression check preventing direct runtime format dispatch in `server.ts` and `connectionTest.ts`.
  - [ ] Substep 4.3 Verify: run `pnpm --filter @open-design/daemon test`, `pnpm --filter @open-design/daemon typecheck`, `pnpm guard`, and `pnpm typecheck`.

## Notes

<!-- Optional sections — add what's relevant. -->

### Implementation

<!-- Files created/modified, decisions made during coding, deviations from design -->

### Verification

<!-- How the feature was verified: tests written, manual testing steps, results -->
