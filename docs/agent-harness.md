# 可选 Agent Harness：ZCode / Claude Code / Codex / pi

> 状态：实现于分支 `feat/selectable-harness`（基于上游 `29628c9`）。本文档描述设计、取舍、验证方式与已知限制。

## 1. 目标

ZCode 原本只有一个“后端执行器”：ZCode 自己的 agent loop（模型请求、工具执行、上下文管理都在 ZCode runtime 内）。
本改造让用户**在前端按会话选择由哪个 harness 运行这一轮对话**：

| Harness       | 谁跑 agent loop         | 谁选模型 / 管凭据                            | 工具实现             |
| ------------- | ----------------------- | -------------------------------------------- | -------------------- |
| ZCode（默认） | ZCode runtime           | ZCode 模型服务（设置页 Provider）            | ZCode 内置工具       |
| Claude Code   | 本机 `claude` CLI       | Claude Code 自己（`claude` 登录 / 环境变量） | Claude Code 内置工具 |
| Codex         | 本机 `codex app-server` | Codex 自己（`codex login`）                  | Codex 内置工具       |
| pi            | 本机 `pi --mode rpc`    | pi 自己（`pi` → `/login`）                   | pi 内置工具          |

注意这与“把 CLI 当作模型 Provider 接入”（旧分支 `feat/claude-code-codex-pi`）是两回事：
外部 harness **整体替换** ZCode 的 agent loop，ZCode 只负责 UI、会话、持久化、审批与投影。

## 2. 上游调研

### 2.1 仓库历史

上游公开仓库只有 3 个提交，没有可追溯的细粒度演进历史：

- `77432b6` Initial commit
- `872ad96` feat: open source
- `29628c9` feat: update v3.14.3

### 2.2 第三方 Agent / ACP 已退役

开源版本发布前，ZCode 曾经通过 ACP（Agent Client Protocol）接入第三方 agent（Claude、Codex 等），该能力在开源快照中已被移除，只剩下兼容性残留：

- `packages/shared/src/providers.ts`：agent 提供方枚举只剩 `ZCODE_PROVIDERS = ["glm"]`；
- `packages/services/test/nonCliAcpRetirement.test.ts`、`packages/ui/test/nonCliAcpRetirement.test.ts`：
  验证“旧的第三方 Agent 身份不再升级”“Claude ACP 文本不再被解释为答案”“退役的 Codex 昵称让位于 ZCode 子代理身份”等；
- 任务索引 SQLite 中历史遗留的 `acp_session_id` 列：只保证打开索引时不破坏旧行，不再读写。

也就是说，上游已经不再有 ACP 客户端、ACP 会话映射或第三方 agent 进程管理代码可以复用。

### 2.3 每个 harness 选 ACP 还是原生协议

| Harness     | 选择                                                                                                                                 | 理由                                                                                                                                                                                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | **原生 stream-json + 控制协议**（`claude -p --input-format stream-json --output-format stream-json --permission-prompt-tool stdio`） | 这是官方 Agent SDK 自己使用的双向协议：`control_request{subtype:"can_use_tool"}` 可以把每一次工具审批交给宿主；`tool_use_result.structuredPatch` 直接给出结构化 diff；`--resume <session_id>` 续接原生会话。走 ACP 需要额外安装第三方适配器包，且适配器同样是包了这套协议。                                                         |
| Codex       | **原生 `codex app-server`（JSON-RPC）**                                                                                              | 官方 IDE 插件使用的协议：`thread/start`/`thread/resume`/`turn/start`，命令与补丁审批以服务端请求 `item/commandExecution/requestApproval`、`item/fileChange/requestApproval` 发回宿主（accept / acceptForSession / decline）；`fileChange` 条目带 unified diff；`thread/tokenUsage/updated` 给出用量。ACP 同样需要第三方适配器。     |
| pi          | **原生 `pi --mode rpc`（JSONL）+ ZCode 生成的审批扩展**                                                                              | pi 的官方集成方式就是 RPC 模式；它没有内置的“工具审批”概念，但扩展可以在 `tool_call` 事件里调用 `ctx.ui.confirm(...)`，RPC 模式会把它变成 `extension_ui_request`，宿主用 `extension_ui_response` 应答。ZCode 自动写入并加载这个扩展（`~/.zcode/agent-harness/pi/zcode-approval.mjs`），由此把 pi 的写入 / 命令接入 ZCode 审批卡片。 |

结论：**三个 harness 都用原生协议直连，不复活 ACP**。原因是上游已删除 ACP 客户端；原生协议提供 ACP 通用层拿不到的信息（结构化 diff、精确用量、按工具的审批语义）；用户也无需额外安装适配器。代价是要维护三个驱动（每个驱动 300～500 行，共用进程 / 通道骨架）。

## 3. 架构

```
前端 Composer（harness 选择器 / harness 模型 & 思考深度）
   │ Submission intent.harness  或  createSession config.harness
   ▼
bootstrap：session-flow / model-config  ──►  runtime.setHarnessSelection / applyHarnessSelection
   │                                              │  SessionHarnessChanged 事件 → V4 投影 config.harness
   ▼                                              ▼
core runtime executeTurnCommand
   ├─ harness = zcode → 原有 agent loop（不变）
   └─ harness = 外部 → runExternalHarnessTurn
          │  AgentHarnessRunnerPort.run(request)        （contracts 定义的端口）
          ▼
adapters/agent-harness：runner → claude-code / codex / pi 驱动 → 子进程（JSONL / JSON-RPC）
          │  归一化事件：session / text_delta / reasoning_delta / tool_call / tool_result(+fileChanges) / usage / notice
          ▼
HarnessTurnWriter：写成与原生 turn 完全相同的事件与持久化形状
   （assistant message / step / text & reasoning part / tool part / ToolCall* / Permission* / ModelStreaming）
          ▼
V4 投影、桌面 / Web UI、冷恢复——无需区分来源
```

关键文件：

- `packages/shared/src/agent-harness.ts`：harness id、选择 schema、目录（模型、思考深度、安装命令、登录提示、审批桥类型）、归一化工具函数、可用性 schema。
- `apps/zcode-cli/packages/contracts/src/interfaces/agent-harness.port.ts`：运行端口与归一化事件契约。
- `apps/zcode-cli/packages/adapters/src/agent-harness/*`：可执行文件定位、进程、三个驱动、运行器（含 `--version` 可用性检测，30 秒缓存）。
- `apps/zcode-cli/packages/core/src/runtime/harness/*`：会话 harness 状态、外部 turn 执行与投影、历史交接。
- `apps/zcode-cli/packages/bootstrap/src/app/agent-harness-runner.ts`：注入运行器、可用性检测。
- `packages/ui/src/v4/composer/{composerHarnessState.ts,V4ComposerHarnessControls.tsx,agentHarnessAvailabilityStore.ts}`：选择器状态（纯函数）、控件、可用性 store。

## 4. 前端

- **Harness 选择器**（Composer 左侧，模式切换之前）：列出 ZCode / Claude Code / Codex / pi，显示说明、可用性（`已安装 <版本>` / `未安装 — <安装命令>` / `尚未检测`）以及登录提示（`claude`、`codex login`、`pi → /login`）。已知未安装的 harness 禁止提交。
- **可用性检测**：宿主在 `workspace/readPresentation` 的附加字段 `harnesses` 中返回检测结果（agent 进程内执行 `<cli> --version`），前端按工作区缓存。可执行文件按 `PATH` 及常见安装目录查找，可用 `ZCODE_CLAUDE_CODE_PATH` / `ZCODE_CODEX_PATH` / `ZCODE_PI_PATH` 覆盖。
- **Harness 感知的模型选择器**：选中外部 harness 时，ZCode 模型选择器替换为该 harness 的模型目录（首项“默认模型”= 交给 harness 自己的配置）与思考深度目录（Claude Code `--effort`，Codex `effort`，pi `--thinking`）。ZCode 模型选择保留在草稿中，切回 ZCode 时继续生效。
- **持久化**：选择保存在 Composer 草稿（`harness` 字段）与会话状态（`SESSION_ENTRY_HARNESS_STATE`）中；投影里的 `config.harness` 驱动已有会话的选择器回显。
- **切换提示**：草稿选择与会话当前 harness 不同时，菜单内显示“下一条消息将由新 harness 在新会话中接手，之前的对话以文本形式交接”。
- **原生工具卡片 / diff / 推理**：驱动把工具名与参数映射为 ZCode 同名工具（Bash、Read、Write、Edit、Grep、Glob、LS、WebSearch…），因此复用 ZCode 原生卡片；文件改动统一转成 ZCode diff hunks（Claude `structuredPatch`、Codex unified diff、pi `details.patch`、新建文件全文），显示在卡片与“本轮改动文件”汇总中；思考内容映射为 reasoning part。能够还原改动前全文时（新建文件，或用改动后全文反向应用 hunks），额外写入与原生 Write/Edit 相同的 workspace checkpoint，因此“N 个文件已更改”面板可以展开 diff，并可用“撤销”回滚这一轮的文件改动。

## 5. 权限模式映射

| ZCode 模式                | Claude Code                      | Codex（sandbox / approvalPolicy） | pi（ZCode 审批扩展策略）                      |
| ------------------------- | -------------------------------- | --------------------------------- | --------------------------------------------- |
| 计划（plan，或开启 Plan） | `--permission-mode plan`         | `read-only` / `never`             | `read-only`：`--tools read,grep,find,ls`      |
| 修改前询问（build，默认） | `--permission-mode default`      | `workspace-write` / `untrusted`   | `ask-mutations`：bash / edit / write 均需审批 |
| 自动编辑（edit）          | `--permission-mode acceptEdits`  | `workspace-write` / `on-request`  | `ask-bash`：只审批 bash                       |
| auto                      | `--permission-mode auto`         | `workspace-write` / `on-request`  | `ask-bash`                                    |
| 完全访问（yolo）          | `--dangerously-skip-permissions` | `danger-full-access` / `never`    | `off`                                         |

## 6. 审批桥接

外部 harness 的审批请求 → `PermissionRequested`（`optionsPolicy: "session-always-allow"`）→ ZCode `permissionBroker` → 审批卡片（允许一次 / 本会话始终允许 / 拒绝 / 反馈）→ `PermissionResolved` → 回给 harness：

- Claude Code：`control_response`（`allow` + `updatedInput`；会话允许时带上 CLI 给出的 `permission_suggestions`；`deny` + 原因）；
- Codex：`accept` / `acceptForSession` / `decline`；
- pi：`extension_ui_response{confirmed}`。

“本会话始终允许”同时记入 ZCode 运行时的 `sessionApprovedTools`（纯内存），同一会话后续同名工具直接放行。
其它 harness 交互（Codex 的 MCP elicitation、向用户提问；pi 其它扩展的对话框；Claude 非 `can_use_tool` 控制请求）暂不桥接：明确拒绝 / 取消，避免 harness 无限等待。

无 UI 的场景（`zcode -p` 无头模式）沿用 ZCode 既有行为：审批请求被拒绝（yolo 模式下不会产生审批）。

## 7. 会话续接与中途切换

- 会话状态保存 `{selection, binding: {harness, nativeSessionId}}`。
- **同一 harness 的后续轮次**：用原生会话续接（Claude `--resume`、Codex `thread/resume`、pi `--session-id`），只发送本轮输入。冷启动 / 重开会话同样续接。
- **首次使用某 harness 或中途切换**：新建原生会话，并把 ZCode 已持久化的可见对话（用户输入、助手正文、工具调用摘要；不含推理）包在 `<zcode_conversation_handoff>` 中放在本轮输入之前，预算 24k 字符，超出时丢弃最早部分。
- **只保留最后一个绑定**：A → B → A 时，回到 A 也会新建会话并交接——这是有意为之，因为 B 期间的对话必须带给 A。
- **续接失败**（原生会话被清理 / 换了机器）且尚未产生输出：清除绑定，改为新会话 + 交接重试一次。
- 外部 harness 的会话不调用 ZCode 模型生成标题（避免把对话发给另一家模型服务），保留首条输入作为标题。

## 8. 命令行

```bash
zcode -p "修复测试" --harness claude-code --harness-model sonnet --harness-thought high
zcode -p "继续" --resume <sessionId>            # 沿用会话的 harness，续接原生会话
zcode -p "换 Codex 看看" --resume <sessionId> --harness codex   # 切换：新会话 + 交接
```

## 9. 验证

- 单元测试（`node --import tsx --test`）：
  - `apps/zcode-cli/packages/adapters/test/agent-harness/agentHarness.test.ts`：三种权限映射、Claude / Codex / pi 流解析（去重、diff、用量、失败）、pi 工具映射、事件通道、基于假进程的 Claude `can_use_tool` 与 pi `extension_ui_request` 审批桥、未安装检测。
  - `apps/zcode-cli/packages/core/test/harness/harness.test.ts`：交接文本、截断、`toDiffHunks`、持久化状态校验、turn harness 解析。
  - `packages/ui/test/composerHarnessState.test.ts`：选择器状态（切换重置、模型 / 思考目录、可用性合并、提交门禁、提交配置）。
- 端到端（无真实密钥）：本地 mock 同时实现 Anthropic Messages、OpenAI Responses、OpenAI Chat Completions 流式协议，真实的 `claude` / `codex` / `pi` CLI 指向 mock，经 ZCode runtime（`dist/zcode.cjs` 无头模式与 Web UI）运行：写文件、编辑、审批允许 / 拒绝、同 harness 原生续接、冷恢复、跨 harness 切换交接。
- Web UI：Playwright 无头浏览器脚本截图（选择器、可用性、模型 / 思考深度菜单、审批卡片、diff、切换交接）。

## 10. 已知限制

- 宿主需要能启动 ZCode agent 进程（桌面 / Web 正常安装即满足）；agent 进程的 `PATH` 来自登录 shell，CLI 需在登录 shell 的 `PATH` 或常见安装目录中，否则显示“未安装”（可用 `ZCODE_*_PATH` 覆盖）。
- 外部 harness 运行期间不支持“中途插话”（steer）：新输入进入队列，本轮结束后作为下一轮发送。
- `/compact` 原样交给外部 harness；ZCode 的 SessionStart hook、系统提示词与上下文构造在外部 harness 轮次中跳过。
- 排队中的输入不携带 harness，执行时按会话当前选择。
- 附件（图片 / 文件）暂不转发给外部 harness。
- 回退（rewind）不会回退外部 harness 的原生会话；回退后的下一轮仍续接原生会话。
- 文件改动检查点在 harness 报告工具结果时生成：改动后全文读取自磁盘；若同一文件随后又被 harness 的 shell 命令修改，或无法反推改动前全文（例如非标准 diff），该改动只计入汇总、不支持撤销。Bash 等命令造成的文件改动不在汇总内（与原生 ZCode 一致）。
- pi 不报告实际模型名（显示为默认）。
- 可用性检测按 agent 进程缓存 30 秒；安装 CLI 后最长 30 秒才会在选择器中出现。
- 子代理（Claude Task 工具等）内部过程不单独展示，只显示所属工具卡片。
- Codex 的 MCP elicitation / 提问、pi 其它扩展的对话框不桥接（按拒绝 / 取消处理）。

## 11. 待讨论问题

1. 是否需要把 harness 选择做成工作区 / 全局默认值（目前是按会话 + 草稿）？
2. 回退时是否应当清除原生会话绑定，让下一轮以交接方式重建上下文？
3. 外部 harness 是否应该允许使用 ZCode 已配置的 Provider（例如把 ZCode 的 API Key 注入 harness 的环境变量）？目前刻意不做，凭据完全由各 harness 自己管理。
4. “本会话始终允许”目前按工具名记忆；是否需要按命令前缀等更细粒度？
