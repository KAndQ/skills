---
name: dag-worker
description: 執行或恢復一個明確指定的 .dag Task，檢查依賴、revision、Git 與 Scope，依實際容量和剩餘工作自適應管理上下文，驗證並持久化狀態、Checkpoint 與交接。不用於規劃 DAG、批量執行、調度或啟動其他 Agent。
---

# DAG Worker

只接收一個明確的 `.dag/<dag-id>/tasks/Txxx-*.md` 檔案，在獨立 Session 完成該 Task 後停止。使用者必須指定實際單一檔案；只有 DAG 目錄、Task ID、萬用字元或「下一個任務」時，先取得唯一目標，不自行挑選或遍歷執行。建立/修改 Worker Skill、展示範例或測試工具均不是執行業務 Task 的授權。

## Contract Boundary

沿用 dag-planner 的 Task Schema、Execution Protocol、Status Lifecycle 與驗收規則；Task front matter 是 SSOT。不新增必填 Task 欄位，不遷移舊 Task，不改 Task ID、依賴、Scope、預算、驗收或 revision。僅維護自身 `status`、Expected Outputs 執行報告及產物引用；不修改兄弟 Task、共享 DAG.md、CONTEXT.md 或 Split Resolution。

只執行當前 Task 的 Required Changes。不能因驗證失敗而擴大 Write Scope、重做架構、實作依賴/後繼，或自行拆分 DAG、建立子 Task、啟動 Agent。需要重規劃時交回 Planner，需要狀態同步/依賴整合時交給外部 Coordinator。Task 不會自動授權部署、真實服務變更、發布、commit 或 push。

## Invocation

在 Codex CLI 或其他 Agent 的新 Session 中傳入：

```text
使用 $dag-worker 執行且只執行以下 Task：
.dag/<dag-id>/tasks/T002-short-slug.md
預期 DAG revision：3
```

恢復時明確寫「恢復同一 Task」，提供上一個 Checkpoint/交接位置及停止原 Session 的確認。沒有預期 revision 時，在 preflight 讀取並固定當前 revision；不把缺省值當作永遠接受未來修訂。範例路徑必須替換，不能直接執行。

## Workflow and Reference Loading

1. **Preflight**：先讀 [references/preflight.md](references/preflight.md)，完整讀取指定 Task 與適用 AGENTS。核對狀態、DAG revision、直接依賴及產物、Git 基線、讀寫範圍和執行模式。只讀 DAG 必需小節和直接依賴，不載入整個 DAG。未滿足前提便停止業務操作，按下述狀態/報告規則交接。
2. **Context**：按動態 Loading Plan 選讀規則、依賴、源碼與測試，可在原 Scope/驗收內調整順序和片段。遵守真實模型/宿主限制與明確使用者上限；舊 context_budget 的估值只作提示。持續評估必要上下文、剩餘實作/測試/修復/交付與可用空間，無依據則記未知/定性風險，峰值與累計分開，不虛構遙測。缺數字不永久阻塞，也不改 Task 補欄位。
3. **Execute / Verify**：通過 preflight 後，讀 [references/execution.md](references/execution.md)。只更新自身合法狀態，執行 Required Changes；每批操作前後核對 revision、契約與預期寫入路徑。優先資料、純邏輯、靜態、編譯及自動化驗證；記錄真實結果與未執行項。
4. **Checkpoint / Recovery**：中斷、依賴消失、revision 漂移或上下文不足時，讀 [references/reporting-recovery.md](references/reporting-recovery.md)，在自身 Expected Outputs 保存基線、已完成工作、變更、驗證證據與剩餘事項。恢復必須重新 preflight，不能只信聊天或把部分產物當作依賴 DONE。
5. **Persist / Stop**：依同一 reference 保存報告；產物、必要驗證與驗收齊全後 DONE，外部條件不足 BLOCKED，實際失敗 FAILED。Context 只有在合理最佳化後仍有可信實際不足證據時，才 BLOCKED + Checkpoint/相容 Split Request（CONTEXT_BUDGET_EXCEEDED）；單純估值超舊門檻只複核。回報結果、產物及待 Coordinator 同步項後停止。

## Completion and Failure

- `PASS`、`FAIL`、`PARTIAL`、`MANUAL_VERIFICATION_REQUIRED` 是 Verification Result，不是 Task status。必要自動化未執行不能 DONE，也不能因人工項未執行而報 FAIL。
- 人工項只要求交接時，完整交接可 DONE，Verification Result 保留 PARTIAL 或 MANUAL_VERIFICATION_REQUIRED；人工確認明確屬於本 Task 的完成門禁時，未確認必須保持未完成。
- DONE / SUPERSEDED 不重新執行或重置。IN_PROGRESS 的恢復須先確認原執行者已停止；BLOCKED / FAILED 的恢復須核對解除條件及既有證據。
- Task 無效、缺少自身文檔寫入權、檔案正由其他執行者持有、宿主只讀或寫入失敗時，回傳未落盤的報告及原因，交 Coordinator 持久化；不越權寫入、不宣稱已更新狀態或保存 Checkpoint。
- 不直接更新共享 DAG 狀態，不以單一 Task DONE 宣告整個 DAG 完成；隔離 worktree 的交接須包含自己的狀態/報告、程式產物和必要 research 結論。

## Tools and Validation

技能附帶只讀檢查工具及臨時 Git fixture 測試；不自動執行命令、寫入狀態或實作 Orchestrator。安裝、檢查、回歸測試和能力邊界見 [references/validation.md](references/validation.md)。工具通過後仍須核對產物內容、基線版本、人工門禁及 Session 所有權。
