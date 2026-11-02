# Reporting, Checkpoint and Recovery

報告是既有 Task `# Expected Outputs` 的執行資料，front matter 的 status 仍是 SSOT。預設不建立 results/；只有契約已明確選用 results 協議且 write_scope 允許時才寫該位置，Task 保留引用，不維護兩份完整報告。以下例子均為假設資料，不代表已執行任何任務。

## Structured Handoff

在 Expected Outputs 中追加 `### Execution Report` 的 YAML。記錄 task_id/dag_id/dag_revision、目前 task_status、Git/契約基線、變更路徑與所有權、輸出名稱/版本/位置/可取得條件、驗證、驗收、blockers、context observation、Checkpoint 和整合說明。run_id 只識別本次報告，不是新 Task ID，也不是執行鎖。

validation 與最終 integration 的報告保留 `Automated Verification`、`Manual Verification`、`Verification Result` 小節，其他 Task 也區分自動與人工。可在這些小節寫摘要並指向同一 Execution Report 的欄位，避免複製維護兩份結果。結果非 PASS 時，摘要及最終交接都保留 token 與未決人工清單。

```yaml
run_id: T002-example-run
task_id: T002
dag_id: 20261101-worker-example
dag_revision: 3
task_status: DONE
baseline:
  head: example-head-identifier
  branch: worker/T002-example
  worktree_ref: worktree:T002-example
  contract_sha256: example-only-not-a-measured-hash
  dirty_at_start: []
changes:
  - {path: src/result.txt, kind: modified, summary: "完成本 Task 的純邏輯結果", sha256: example-only-not-a-measured-hash}
  - {path: .dag/20261101-worker-example/tasks/T002-result.md, kind: modified, summary: "僅狀態與報告"}
outputs:
  - name: result
    location: "repository:src/result.txt"
    availability: "與自身 Task 狀態/報告一同存在於指定 worktree，待 Coordinator 整合"
    verification: "下列確定性檢查通過，人工項按契約只要求交接"
automated_verification:
  - command: "node tests/result.test.mjs"
    cwd: "."
    required: true
    prerequisites: "使用 Task 指定 mock，無外部服務"
    expected: "全部斷言通過，退出碼 0"
    result: PASS
    exit_code: 0
    evidence: "本次工具結果：所有斷言通過；範例非真實執行紀錄"
manual_verification:
  - step: "在約定的人工驗證環境操作結果展示"
    expected: "結果與資料狀態一致"
    owner: "下游驗證負責人"
    completion_gate: false
    confirmed: false
    note: Manual Verification Required
verification_result: PARTIAL
verification_summary: "PARTIAL — Automated checks passed; manual gameplay verification required."
acceptance:
  completed: ["純邏輯結果及人工清單交接"]
  pending: []
context_observation:
  current_peak_tokens: null
  projected_peak_tokens: null
  remaining_work_tokens: null
  evidence: "無宿主遙測與可靠數字；已按接口分階段讀取並保留交付證據，未宣稱實測"
checkpoint:
  baseline: "worktree:T002-example at submitted DAG revision 3"
  artifacts:
    - {location: "repository:src/result.txt", verification: "確定性驗證通過"}
  completed_acceptance: ["純邏輯結果及人工清單交接"]
  pending_acceptance: []
  resume_notes: "本 Task 已完成；不自動恢復執行。人工項由下游接收。"
blockers: []
integration_notes:
  artifact_ref: "worktree:T002-example"
  include: [src/result.txt, .dag/20261101-worker-example/tasks/T002-result.md]
  order: "由 Coordinator 按原 DAG 整合順序處理"
  remaining_risks: ["人工展示尚未確認"]
coordinator_sync: pending
```

`verification_result: null` 只用於因阻塞而無法形成驗證結論，不是新增第五個結果 token。單項檢查的 NOT_RUN 與退出碼 null 寫明未執行原因；不能設成零。輸出/驗收尚未齊全時 task_status 不得 DONE；上述人工清單交接完成必須是原契約允許的完成邊界。

## Checkpoint Triggers and Contents

在可控中斷、依賴消失、revision/契約漂移、新增必要源碼/耦合、修復迭代、工具輸出暴增、交付空間風險或長操作前保存 Checkpoint；不使用固定 Token/百分比觸發器。沿用 baseline/artifacts/completed_acceptance/pending_acceptance/resume_notes，詳細變更與證據保存在同一報告，不新增必填 Task 欄位。

Checkpoint 必須足以讓後續 Session 找到 Git HEAD/分支、worktree/patch/快照標識，區分 Session 開始前既有 dirty 與本次變更；對要恢復的檔案記可比對的雜湊/patch 及可取得位置，保存退出碼、失敗用例、尚未跑的檢查、剩餘驗收和第一個安全下一步。不要在報告中貼密鑰、完整敏感日誌或資料庫內容。

只引用已允許寫入/已存在可取得的檔案，或外部 Coordinator 實際保存的快照。不為 Checkpoint 自動 commit、push、建立 worktree、另寫未授權 patch 檔或新增 results 目錄。沒有可取得產物時 artifacts 為空，說明尚未產出及可重建步驟，不虛構快照。程序被強制終止/斷電後不能保證自動保存，因此依賴階段性 Checkpoint，不宣稱已實作訊號監控或自動恢復服務。

## Recovery

1. 只恢復同一明確 Task。讀最新持久化報告/Checkpoint，確認原 Session 已停止及使用者/Coordinator 授權接手；不能因看到 IN_PROGRESS 就搶佔。
2. 重新 preflight：當前 revision、原契約雜湊、依賴輸出及版本、Git HEAD/dirty 路徑、宿主預算。逐項對照既有檔案與 Checkpoint，保留原成果和報告；其他使用者的差異不可覆蓋。
3. revision/契約不一致時交 Planner/Coordinator 判定影響與解除條件，不自行 rebase、改 scope 或沿用舊驗收。BLOCKED/FAILED 只有在原 blocker 已解除、必要輸入可用、Scope/所有權確認後才能重回 READY/IN_PROGRESS；上下文 Split Request 發出後不能直接再試一次。
4. 同一基線且未變更的成果可保留；依據變更影響重新驗證，不把舊 PASS 當作已覆蓋新差異。不重複外部副作用；無法確認操作是否已發生時停止核對。
5. 追加新 run_id 的報告，引用前次 Checkpoint，說明保留/重新驗證的內容。完成或再次受阻後持久化狀態與交接，停止。

若同一 Task 在新 Session 接續而未拆 DAG，於舊 Split Request 後追加 Execution Report：recovery.from_checkpoint 指向原 Request 的 checkpoint.baseline，recovery.coordinator_ack 記錄原執行者已停止及 blocker 解除的確認。報告保留當前 task_id/dag_id/dag_revision/task_status、run_id、blockers 與最新 context_observation 證據；不能僅改 status 隱藏未解除的請求。已有匹配 Split Resolution 時沿用其交接；不必為恢復而虛構 replacement_tasks 或修改舊報告。

## Planner-Compatible Split Request

先合理最佳化載入、工具輸出與分階段驗證；仍有充分真實容量/剩餘工作不足證據才 BLOCKED，在 Expected Outputs 追加 Split Request。單純估值超舊 target/soft/hard 不觸發。格式保留舊欄位，Token 觀察可缺省/null，evidence、最佳化、Checkpoint 和恢復條件不可省；可擴充可信 constraints/minimum_required_tokens/capacity_signal，語義與 Planner 一致。舊數字報告繼續可讀，不回寫歷史。

```yaml
blocker_code: CONTEXT_BUDGET_EXCEEDED
task_id: T002
dag_revision: 3
reason: "假設示例：已最佳化載入和驗證，宿主仍回報本 Session 容量耗盡，須保存結果交接。"
context_observation:
  current_peak_tokens: null
  projected_peak_tokens: null
  remaining_work_tokens: null
  capacity_signal:
    source: host
    confidence: verified
    code: CONTEXT_EXHAUSTED
    evidence: "假設 fixture 的當前宿主容量故障；不是實際專案的遙測。"
  optimization_attempts: ["只保留必要接口、驗證與交付，已減少重複輸出"]
  evidence: "無可靠 Token 數字；故障與剩餘驗收有可信依據，不能僅用預估超限推論。"
attempted_reductions: ["僅讀接口和目標符號，測試輸出僅保留退出碼與失敗摘要"]
checkpoint:
  baseline: "worktree:T002-example at submitted DAG revision 3"
  artifacts:
    - {location: "repository:src/result.txt", verification: "部分邏輯已驗證，整體驗收未完成"}
  completed_acceptance: ["接口失敗行為已確認"]
  pending_acceptance: ["實作與驗證兩個模組"]
  resume_notes: "保留既有修改與失敗測試，恢復須核對原 Session 停止、revision 與檔案差異。"
proposed_split:
  - key: first
    goal: "第一模組可獨立驗收"
    depends_on: []
    read_scope: [src/first.ts]
    write_scope: [src/first.ts, tests/first.test.ts]
    outputs: [first_result]
    acceptance_criteria: ["第一模組與失敗路徑可驗證"]
  - key: second
    goal: "第二模組與第一模組接口整合可驗收"
    depends_on: [first]
    read_scope: [src/first.ts, src/second.ts]
    write_scope: [src/second.ts, tests/second.test.ts]
    outputs: [second_result]
    acceptance_criteria: ["第二模組與接口整合可驗證"]
```

建議只提供局部 key/依賴、目標、範圍、輸出與驗收，不分配正式 Txxx ID，也不建立檔案。沒有合理邊界可用 `proposed_split: []`，reason 說明不可分原因。Worker 不編寫 Split Resolution、不套用新 DAG；Planner 保留 Checkpoint/歷史 ID/結果修訂契約，外部 Coordinator 再判定 READY 及路由 Session。

同一 Task 再次受阻時追加當前提交 revision 的新 Request，不覆蓋舊報告；BLOCKED 的部分成果不能直接作為下游已完成依賴。若要跨任務復用，須由 Planner 明示凍結快照/外部 source 與版本，不能新增指向 BLOCKED/SUPERSEDED 的執行依賴。

## Compatibility Sources

本 Skill 的操作規則對應現有 Planner 的 [Task Schema / Completion Boundary](../../dag-planner/references/task-contract.md)、[Execution Protocol / Status Lifecycle](../../dag-planner/references/execution-protocol.md)、[Context Budget](../../dag-planner/references/context-planning.md) 和 [DAG Format](../../dag-planner/references/dag-format.md)。這些是維護相容性時的來源連結，不要求每個 Worker Session 重讀整套 Planner，也不將 Planner 的角色限制錯套成 Worker 不得執行明確授權 Task。

Planner 與 Worker 各自包含相同 context-policy.mjs，回歸檢查來源及行為一致。runtime observation 可描述當前 Session，而不改 Task；新/舊 Context metadata 均可缺省、數值未知合法。真正約束只有可信 provenance/constraints，不能靠改人工配置繞過。觀察/報告可選擴充欄位不改 Split Resolution、Checkpoint 和 Task status 的既有格式。
