# Worker Guard Validation

工具需要 Node.js 24，依賴鎖定於本 Skill 的 scripts/；不使用或修改業務應用工具鏈。從 repository root 執行：

```powershell
npm ci --prefix .codex/skills/dag-worker/scripts
npm run check --prefix .codex/skills/dag-worker/scripts
npm test --prefix .codex/skills/dag-worker/scripts
```

沒有建置/開發服務步驟。測試在 OS 臨時 Git 倉庫使用合成契約，核對正常交接、缺依賴/版本、越界/rename/symlink、上下文超限、驗證失敗、人工門禁、恢復、舊 Task、歷史證據與 Planner Split Request 相容性；不執行業務 DAG Task、不呼叫外部服務、不啟動 Agent。Planner 相容性測試使用其既有唯讀校驗器的臨時副本及 Worker 的相同 YAML 解析依賴，不改 Planner 原檔。

指定實際單一檔案時，可做**只讀** preflight；以下是調用格式，替換路徑後才執行：

```powershell
node .codex/skills/dag-worker/scripts/check_task.mjs .dag/<dag-id>/tasks/T002-short-slug.md --revision 3
node .codex/skills/dag-worker/scripts/check_task.mjs .dag/<dag-id>/tasks/T002-short-slug.md --revision 3 --path src/client/cache.ts
```

`--path` 可重複，檢查預期寫入；`--read-path` 檢查定向讀取。`--resume` 只表達恢復意圖，不證明原 Session 已停止、不授予覆寫 dirty 檔案權限。IN_PROGRESS/BLOCKED/FAILED 恢復仍須依 preflight/recovery 文檔核對交接與解除條件。DONE 回傳 no-op，SUPERSEDED 不重跑；工具永不寫狀態/報告、不執行驗證命令。

可選 `--context-observation <JSON-file>` 提供當前可信容量/剩餘工作與最佳化證據；task_id/dag_revision 如有須匹配。未知值合法，不自動取得 Token 遙測。API preflight 接受 contextObservation；assessOutcome 接受 contextTask/contextObservation 並使用相同 assessContext。舊 contextExceeded boolean 或只有 CONTEXT_BUDGET_EXCEEDED 字樣的 blocker，沒有充分證據時僅回傳 context_review_required，不能單獨機械阻塞。

輸出包含 errors、warnings、pinned revision、契約雜湊、Git 基線及 no_op。退出碼 0 表示其靜態/本地檢查通過，1 表示已知前提不滿足，2 表示參數/讀取/解析錯誤。警告中的內容語意、版本證據、Session 所有權、Scope 內 dirty 歸屬和宿主能力核對，是執行前仍需完成的檢查；0 不是自動開工許可。

工具只讀指定 Task、必要 metadata/直接依賴與產物定位。context_management/舊 context_budget 可缺省，六類成本可定性/未知；有值仍檢查數字型別、範圍和舊完整包絡。沒有可信 provenance 的門檻/估算超限只警告，只有合理最佳化後的真實容量/明確資源上限與最低必要需求或可信宿主故障才阻塞。未知資料不代表無限或永久阻塞。遠端產物與內容語意仍要核對。

exports `scopeAllows` / `auditTaskEdit` / `assessOutcome` 為只讀判定函式，供回歸測試或其他宿主調用；不負責應用狀態轉換。`auditTaskEdit` 檢查自身 status/報告範圍及歷史保留；assessOutcome 僅根據提供的事實建議結果，不能證明輸出真的存在或測試真的執行。讀寫檔案、狀態持久化仍由被授權的 Worker 執行並重新核對。

系統不實作全域鎖、租約、Token 遙測、命令攔截、Session 生命週期、快照服務或任務調度。正式多 Agent 環境仍需外部 Coordinator/Orchestrator 管理所有權、基線整合和共享 DAG 串行同步；Skill 與檢查器不能代替 sandbox 或防止未經過工具的寫入。
