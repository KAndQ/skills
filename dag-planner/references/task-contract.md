# Task Contract

创建或修订 tasks/*.md 时读取本文件。本文件定义未来执行任务的结构和内容；不为当前 Planner 分配 Executor/Coordinator 职责。Planner 仍遵循 [SKILL.md](../SKILL.md) 的文档交付边界。

本文模板中的 modify/create/verify、业务 write_scope、execution_mode 和状态流转均属于 generated DAG execution contract，是为未来 Executor 会话编码的指令，不是 current dag-planner runtime instructions。Planner 只物化这些契约；契约允许执行者修改业务文件，不扩大 Planner 自身的 `.dag/<dag-id>/**` 写入范围。当前最终计划遵循 [Final Plan Contract](../SKILL.md#final-plan-contract)。

# Structured Source of Truth

tasks/*.md front matter 是 Task 结构化信息的 SSOT，DAG.md 索引、Mermaid、Text Graph、Parallel Plan 都从同一组任务派生；详见 [dag-format.md](dag-format.md#dag-model)。每个 Task 必须在没有原始聊天的独立 Session 中可执行，不能只写“见 CONTEXT”。

# Task Identity and Status

Task ID 在当前 DAG 内唯一，固定三位数字 T001 至 T999，与文件名和目录一致。ID 创建后保持稳定，不复用废弃 ID；达到容量时拆分独立需求，不改已有 ID 宽度。

Task status 允许 PLANNED、READY、BLOCKED、IN_PROGRESS、DONE、FAILED、SUPERSEDED。新任务默认 PLANNED，SUPERSEDED 不等于 DONE。Executor 自动更新和 Coordinator 同步规则由 [execution-protocol.md](execution-protocol.md#status-lifecycle) 定义；生成或修订这些规则时再读取并展开。

# Task Schema

每个 Task 的 YAML front matter 至少包含以下字段，正文提供执行细节；重复出现的值必须一致。

| 字段 | 类型与约束 |
|---|---|
| `id`, `dag_id`, `title`, `goal` | 非空字符串；ID 与文件名、目录一致 |
| `status` | Task Identity and Status 中的 Task 状态 |
| `type` | `analysis`, `research`, `design`, `implementation`, `test`, `validation`, `integration`, `documentation`, `migration`, `build`, `review` |
| `depends_on` | 当前 DAG 的 Task ID 数组；根节点为 `[]` |
| `parallel_group` | `P1`、`P2` 等批次；不替代依赖检查 |
| `agent_role` | 能力角色，不是模型名称或已存在 Agent 的声明 |
| `reasoning_requirement` | `low`, `medium`, `high` |
| `execution_mode` | `readonly`, `same_workspace`, `isolated_worktree`, `integration` |
| `read_scope`, `write_scope` | repository-relative 路径或 glob 数组 |
| `inputs` | 具名输入数组；依赖输入写明 `from`、`output`、`location` |
| `outputs` | 具名输出数组；写明 `name`、`location`、`contract` |
| `acceptance_criteria`, `verification` | 可观察标准与具体验证步骤数组；按 [Validation Task Contract](#validation-task-contract) 区分自动化与人工项 |
| `risks`, `forbidden_changes` | 字符串数组，明确无内容时为 `[]` |

发生隔离并行的预计冲突时补充 `merge_conflict_risk: expected` 和负责的 `integration_task`。无需默认添加无用途的字段。

角色按能力选择，如 repository-researcher、architect、typescript-implementer、cocos-implementer、backend-implementer、test-agent、performance-agent、review-agent、integration-agent；不绑定模型，不宣称角色对应已安装 Agent。reasoning_requirement 对简单定向调查可用 low，常规实现 medium，架构、复杂兼容和高耦合实现 high；它是给外部调度器的建议。

并行任务必须分析 write_scope 与 shared side effects；分析原则见 [SKILL.md](../SKILL.md#parallel--write-scope-conflict-analysis)。execution_mode 的详细含义见 [execution-protocol.md](execution-protocol.md#execution-modes)；选取或修订模式时必须读取该节。

# Research Task Contract

research Task（包括调用 research 技能完成调查的节点）必须在 `outputs` 中声明具名结论文件，在 `write_scope` 中列出其完整 repository-relative 路径。文件包含研究目标、调查基线、结论与依据、已确定的接口/约束、未决问题及对下游的影响；引用可定位的仓库路径或来源链接，区分事实、建议和未验证项。依赖这些结论的 Task 在 `depends_on`、`inputs` 和 `read_scope` 中声明生产者及同一结论文件，执行前读取并核对版本；文件缺失或关键问题未解决时不得开始依赖该结论的实现。

结论路径采用 research/Txxx-short-slug.md，规划阶段只声明，不预填尚未执行的研究结果。Expected Outputs 记录结论的链接与交接摘要，完整研究结论只维护一份。下游 depends_on、inputs、read_scope 必须指向生产者和同一文件，并记录版本及缺失时的解除条件。

# Validation Task Contract

validation 类型 Task 以及承担最终验收的 integration Task，必须按 [Verification Strategy](../SKILL.md#verification-strategy) 把验证拆成可自动执行与必须人工确认两部分，并在 Expected Outputs 报告中固定使用以下小节；其他 Task 的 Verification 也必须区分自动化步骤与人工项。

## Automated Verification

按 `Data > Pure Logic > Static Check > Build > Automated Test > Manual Gameplay Verification` 的顺序列出实际执行的确定性检查：数据与结构断言、Schema 与字段校验、数量与类型检查、invariant、纯逻辑测试、Type Check、Lint、Build/Compile、脚本或 CLI Test、Mock 环境验证。
每项写明命令、工作目录、前提条件、预期结果与实际结果；未执行的检查标明原因，不能等价于通过。
UI 功能背后存在可独立验证的数据状态时，验证数据状态（调用对应逻辑，断言配置或状态变化），而不是驱动 UI。
数据断言、invariant、输入输出对比、before/after diff、统计结果校验、边界值、空数据、重复数据及 ID/引用完整性检查必须尽可能补齐；禁止因不启动 GUI 而弱化验证。

## Manual Verification

列出无法确定性验证、必须由开发者在 Cocos Creator、Android、iOS 或真机上确认的项：拖拽、多点交互、点击链路、多步骤 UI/Popup Flow、Tween/Spine/Particle 动画、Camera 与 Sorting/Render Layer、Mask/Shader 视觉、Scene 生命周期、Native 与 Web 行为差异、真机性能、帧率、手感、动画视觉正确性。
每项写明操作步骤与预期表现，标记 `Manual Verification Required`。默认不为了这些检查自动启动 VSCode 内嵌浏览器、浏览器 Preview、Cocos Preview、游戏客户端、模拟器或 GUI 自动化环境；例外仅限用户明确要求、任务本身是交互或浏览器自动化测试、或已有稳定确定性的自动化 Harness。不要把“成功启动游戏 / 页面没有立即报错”当作验证证据。

## Verification Result

最终结果使用 `PASS`、`FAIL`、`PARTIAL`、`MANUAL_VERIFICATION_REQUIRED`：

| 结果 | 含义 |
|---|---|
| `PASS` | 全部必要自动化验证通过，且没有人工验证项 |
| `FAIL` | 至少一项必要自动化验证失败 |
| `PARTIAL` | 自动化验证通过，但仍有必须人工确认的游戏交互；固定表述 `PARTIAL — Automated checks passed; manual gameplay verification required.` |
| `MANUAL_VERIFICATION_REQUIRED` | 没有可执行的确定性验证，结论完全依赖人工确认 |

自动化验证通过但存在人工项时不得标记 `FAIL`，也不得宣称交互、视觉或手感已验证；人工项写入交接清单，由开发者在真实环境确认。结果不是 `PASS` 时，Expected Outputs 报告与交接摘要都必须保留该 token 及未决人工清单。

# Dependency Contracts

每个依赖输入的 `from` 必须位于 `depends_on` 中，`output` 必须对应生产者输出名称。每条依赖至少说明消费什么以及如何验证可用；外部输入单独标明来源，不伪装成本 DAG Task ID。

产物定位使用 repository:path 表示仓库文件；规划文件使用相对 Markdown 路径及锚点，按 [dag-format.md](dag-format.md#directory-layout) 的路径约定。字段中须写明产物的内容、版本和可获取条件；branch/commit/patch 等执行阶段交接策略见 [execution-protocol.md](execution-protocol.md#task-handoff)。

默认不创建 results/：Task 自身的 Expected Outputs 保存报告与产物引用，research 结论在独立文件。不仅凭聊天“完成”接受依赖，多个下游共同消费同一研究结论，不复制维护。

只有用户或执行系统明确选择 results 协议时，才使用 `results/Txxx.md`；一次统一更新所有产物位置和写入所有者。不要同时维护两份完成报告。

# Task Template

以下为可填充模板，不是可直接执行的任务。替换所有示意值；序列化 YAML 时对含冒号、日期或特殊字符的文本加引号。

```markdown
---
dag_id: YYYYMMDD-goal-slug
id: T002
title: 明确的单一任务
status: PLANNED
type: implementation
goal: 一个可验收结果
depends_on: [T001]
parallel_group: P2
agent_role: typescript-implementer
reasoning_requirement: medium
execution_mode: isolated_worktree
read_scope: [src/contracts/api.ts, src/client/cache.ts, .dag/YYYYMMDD-goal-slug/research/T001-design-contract.md]
write_scope: [src/client/cache.ts, tests/client/cache.test.ts, .dag/YYYYMMDD-goal-slug/tasks/T002-short-slug.md]
inputs:
  - from: T001
    output: api_contract
    location: "../research/T001-design-contract.md"
outputs:
  - name: client_cache
    location: "repository:src/client/cache.ts"
    contract: 实现已冻结接口及约定的失败行为
acceptance_criteria:
  - 相同 key 的并发读取只触发一次底层请求
verification:
  - 使用调查确认的命令运行并发读取测试，并记录退出码
risks:
  - 共享缓存状态可能跨请求泄漏
forbidden_changes:
  - 不更改已冻结的 public API
  - 不新增第三方依赖
---

# Execution Instruction
生成时在此展开 execution-protocol.md 的 Execution Instruction 模板，并按本任务补齐上下文；不得只保留引用或占位说明。

# Goal
写明该任务解决的问题和完成状态。

# Background
写明必要的已确认行为、当前模块职责、真实 API 和生命周期。

# Dependency Inputs
解释每个输入的内容、版本、获取位置及使用方式；缺失时如何解除阻塞。

# Read Scope
列出优先读取的文件、符号和上下文小节，路径基准为 repository root。

# Write Scope
说明允许新增、修改或删除的具体路径；包含相关测试、元数据及工具会改写的文件。必须列出本任务文档，并限定为 status、执行报告与产物引用维护；research 任务还须列出结论文件，不能授权写入整个 tasks/ 或 research/ 目录。

# Required Changes
描述具体行为、接口约束、数据流及必须处理的失败情况。

# Constraints
写明本任务适用的平台、性能、兼容及仓库规则。

# Forbidden Changes
列出禁止的无关重构、生成文件改写、API 或存档变更等实际边界。

# Acceptance Criteria
将结果拆成可观察、可测试的验收项。

# Verification
按 Validation Task Contract 拆分：自动化验证给出已调查的命令、工作目录、前提条件、预期结果与实际结果；人工验证给出操作步骤、预期表现并标记 `Manual Verification Required`，不要求执行者启动 GUI 环境。

# Expected Outputs
定义具名产物及交接位置。完成报告必须包括：修改文件、实现摘要、验证结果、剩余风险、blockers 和集成说明；已有 commit 时附 hash，不要求为报告强制提交。
由执行者在此小节持久化报告和产物引用，供后续 Task 读取。research 的完整结论存放在声明的独立文件，此处只记录交接摘要及链接，不维护两份完整结论。将产物落盘、验证与自动更新本任务 status 纳入完成条件。

# Risks
指出具体风险及需要报告的条件。

# Integration Notes
指定基础版本、依赖分支或产物、集成负责人和本任务的终止条件。
```

# Execution Text Assembly

生成 Task 的 Execution Instruction、handoff、status lifecycle、worktree 或 integration 条款时，读取 [execution-protocol.md](execution-protocol.md)，将适用规则展开到本任务文档。不能将上面的组装说明留在交付文件中，也不能要求未来执行者依赖本技能目录才能获得任务必需指令。

Task 本身仍须保留 Dependency Inputs、Expected Outputs、Integration Notes 的具体输入位置、输出契约、验证证据与集成基线；执行协议 reference 仅提供规则来源，不替代这些任务专属内容。
