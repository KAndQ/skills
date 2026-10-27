This document defines the execution protocol encoded into generated DAG task
contracts. It does not assign Executor or Coordinator responsibilities to the
current dag-planner session.

The dag-planner may describe these rules in generated documents, but MUST NOT
execute DAG tasks, create execution sessions, start subagents, modify business
code, create implementation commits, or act as the Coordinator.

Executor and Coordinator instructions contained in references or generated
Task documents are quoted/encoded instructions for future sessions.
They MUST NOT be interpreted as authorization for the current Planner session
to assume those roles.

以下内容属于 generated DAG execution contract，不属于 current dag-planner runtime instructions。Execute DAG Task、set status to IN_PROGRESS、create worktree、integrate changes、update DONE 和 start implementation 都指未来被分配任务的会话；不会改变当前 Planner 的文档交付目标。当前可执行步骤及停止条件见 [Final Plan Contract](../SKILL.md#final-plan-contract) 和 [STOP Condition](../SKILL.md#stop-condition)。

# Execution Protocol

仅在生成或修订 Executor handoff、execution_mode、status lifecycle、worktree/integration 协议时读取。以下规则的主语是未来被分配任务的 Executor 或 Coordinator；Planner 只将适用规则写入 DAG/Task，不在当前会话执行。Task schema 与状态取值见 [task-contract.md](task-contract.md)，DAG 格式与状态取值见 [dag-format.md](dag-format.md)。

# Execution Instruction

以下文本用于生成 Task 的 Execution Instruction，必须展开到任务正文，并填入本任务上下文，不把这份模板视为当前会话的任务分配：

```text
你是整个 DAG 中的一个执行节点。只完成当前 Task，不实现兄弟任务，不重新规划整个功能。
先读取本任务及适用的仓库指令；按需读取同一 DAG 的 DAG.md、CONTEXT.md。
依赖必须已完成，且指定产物在当前工作基线上可用，才能开始修改。
遵守 Write Scope、Constraints、Forbidden Changes、Acceptance Criteria 和 Verification。
验证遵守 Validation Task Contract：优先执行确定性验证，不启动 GUI 环境替代确定性验证；无法确定性验证的游戏交互写入人工验证清单。
输入缺失时报告 blocker；规格与仓库冲突时报告 discrepancy。
需要扩大写入范围时报告原因，由 Planner 修订后继续，不静默扩大范围。
执行开始时自动将本任务 front matter 的 status 更新为 IN_PROGRESS。
结束前持久化声明的产物与验证报告；research 任务必须写入结论文件。
本任务产物、必要自动化验证、验收与交接报告齐全后，自动将 status 更新为 DONE，不等待用户提醒；validation 报告含 Automated Verification、Manual Verification 与 Verification Result。
人工项仅要求交接时，完成清单交接即可 DONE，报告中的 Verification Result 保留 PARTIAL 或 MANUAL_VERIFICATION_REQUIRED；这些 token 不得写入 status。人工确认若是当前任务明确要求的完成门禁，未确认前不得 DONE。
受阻或执行/验证失败时分别更新为 BLOCKED 或 FAILED，记录原因与恢复条件，不标记 DONE。
仅可修改本任务文档的 status、执行报告与产物引用，不改写任务契约。
完成本任务后输出交接报告并停止；不要修改全局 DAG 清单或启动后续任务。
```

# Execution Modes

| 模式 | 使用条件 |
|---|---|
| `readonly` | 调查、研究、设计或审查；业务文件只读，仅写入 scope 明确列出的任务状态/报告及研究结论文件 |
| `same_workspace` | 范围明确、低风险、写入及工具副作用独立 |
| `isolated_worktree` | 多 Agent 并行实现或重构的默认建议 |
| `integration` | 有限范围集成、冲突解决及最终构建验证 |

`readonly` 表示业务文件只读；仍须在 `write_scope` 中显式列出本任务文档及必要的研究结论文件，允许执行者维护 status、报告和结论，不允许修改业务文件或规划契约。如果宿主确实禁止所有写入，返回待落盘内容及阻塞原因，由协调者持久化并更新状态；写入未完成前不得声称任务 DONE。

# Copilot Execution Model

为每个可交付 Task 提供如下执行方式，并替换实际路径和 ID：

```text
Execute DAG Task:
.dag/<dag-id>/tasks/T002-short-slug.md

Read the task first and follow applicable repository instructions.
Read DAG.md and CONTEXT.md from the same DAG directory only when required.
Read declared dependency outputs before implementation.
Verify the task revision and dependency artifacts on your working baseline.
Strictly follow Write Scope, Constraints, Forbidden Changes,
Acceptance Criteria, and Verification.
Follow the Validation Task Contract: run deterministic checks first; do not
launch the VS Code browser, browser preview, Cocos Preview, game client,
emulator, or GUI automation in place of them; list gameplay items under
manual verification.
Complete only T002. Do not implement sibling tasks.
Automatically set this task's status to IN_PROGRESS when execution starts.
Persist declared outputs and verification evidence; research tasks must write
their declared conclusion file for dependent tasks to read.
Before stopping, automatically set this task's status to DONE when its outputs,
required automated checks, acceptance and handoff are complete. Validation
reports include the Verification Result and the manual verification list.
If manual items require handoff only, completing that handoff allows DONE;
keep PARTIAL or MANUAL_VERIFICATION_REQUIRED in the report's Verification
Result, never in status. If manual confirmation is an explicit completion
gate for this task, do not set DONE before it is satisfied. Record BLOCKED or
FAILED as applicable, with the reason and recovery conditions.
Only maintain this task's status, execution report and artifact references;
do not rewrite its contract or edit the shared DAG manifest.
Report changed files, results, risks, blockers and integration notes, then stop.
```

这是一份交接提示，不是启动 Agent 的命令。Planner 不创建会话、分支、worktree、PR 或 implementation commit。

# Worktree Strategy

在集成策略中指定共同基础版本；依赖实现完成后，明确下游使用包含哪些产物的集成基线，而不是继续使用缺少依赖的原始版本。为每个并行执行单元建议独立 Session 和 worktree。

worktree 仅隔离文件编辑，不消除语义冲突、共享服务或迁移副作用。无法使用 worktree 时，重新计算 same_workspace 冲突并串行化必要节点，不照搬原并行组。

不要要求所有环境必须 commit；实际合并采用环境支持且已获授权的方式，集成规范必须指定产物获取和应用顺序。

# Task Handoff

代码产物须交接 commit、branch 或协调者可获取的 patch/文件快照标识，不能只写“已实现”；不要求所有环境必须 commit。具名输入输出及定位规则见 [task-contract.md](task-contract.md#dependency-contracts)。

执行者将修改文件、实现摘要、验证结果、剩余风险、blockers、集成说明和产物定位持久化到自身 Task 的 Expected Outputs；已有 commit 时附 hash。research 任务另行落盘声明的独立结论文件，此处只保留摘要和链接。产物和必要验证完成后才进入 DONE；下游不能只依据聊天声明启动。

外部协调者获取依赖的代码、状态和报告，形成包含全部必要产物的下游基线。隔离 worktree 的交接包含任务状态、报告和 research 结论；报告存储协议由任务契约统一指定，不额外维护重复报告。

# Integration Strategy

存在多个并行实现任务时创建明确的 integration 节点；仅在已有外部集成机制完全覆盖时才省略，并说明该机制及负责人。

集成节点依赖全部待集成产物，列明基础版本、应用顺序、允许处理的冲突路径、构建/测试/API 与数据兼容检查及 Definition of Done。集成 Write Scope 必须覆盖实际应用的上游变更及有限集成测试，不能只声明一个测试文件却合并其他目录。

不满足验收的上游任务返回 `Txxx requires rework`，不得让集成 Agent 无限扩大范围或重新实现整个功能。发布、部署、生产迁移不因存在集成节点而自动获得授权。

# Status Lifecycle

状态字段的取值分别由 [Task 契约](task-contract.md#task-identity-and-status) 和 [DAG 格式](dag-format.md#dag-status) 定义。以下只规定未来执行阶段的流转，不授权 Planner 执行或协调任务。

新 Task 默认 PLANNED。用户、Executor 或协调者在依赖 DONE、产物可用、scope 已协调且契约已确定后置 READY，再进入 IN_PROGRESS；验收和报告齐全后才能 DONE。缺少外部条件用 BLOCKED，实际执行或验证失败用 FAILED，均记录原因与恢复条件。SUPERSEDED 不等于 DONE。

执行者必须自动维护自身 Task front matter 的 `status`：开始执行置 IN_PROGRESS；按 [Task Completion Boundary](task-contract.md#task-completion-boundary) 完成本任务产物、必要验证与报告后，在最终回复前置 DONE，无需用户另行提醒。仅待下游或开发者执行的人工交接项不阻止 DONE，验证结果保留在报告中；明确属于当前任务的人工完成门禁仍须满足。必要自动化未执行或实际失败时不能 DONE。失败或受阻按上述规则更新。状态更新仅限自身任务，不修改兄弟任务或契约字段。

共享 DAG.md 的执行状态和派生索引由一个协调者在接收任务交接后自动串行同步，不等待用户提醒。多个 Executor 各自写入本任务文档并返回报告，避免同时写全局清单；独立 worktree 的交接必须包含状态、报告及研究结论文件。单任务执行者未兼任协调者时在报告中注明待同步，由协调者完成全局更新。全局 DoD 与集成验证通过后，协调者才能把 DAG 置 DONE；存在未决人工验证项时，完成摘要保留对应 token 与人工清单，不宣称游戏交互、视觉效果或手感已验证。

交接时携带 DAG revision；执行者发现契约修订变化时核对影响后再继续。scope 变更或仓库差异交给 Planner 重规划，Executor 不静默扩大范围。必要环境不可用或依赖产物缺失时记录恢复条件；未执行验证不能等同于通过。
