# Task Preflight

在任何狀態或業務寫入前完成本節。Task 的依賴、Scope、輸出與驗收以 front matter 及正文為準，不能用 DAG 索引的顯示狀態覆蓋 Task SSOT。

## Target and Revision

- 接受單一實際 Task 檔案，不展開萬用字元、不自選下一個 Task。核對 repository root、`.dag/<dag-id>/tasks/`、檔名 ID、`dag_id` 與唯一性；拒絕 symlink/junction 逃出倉庫。
- 依 Planner schema 讀取完整契約：id/dag_id/title/status/type/goal、depends_on、parallel_group、agent_role、reasoning_requirement、execution_mode、read_scope/write_scope、inputs/outputs、acceptance_criteria/verification、risks/forbidden_changes。YAML 重複鍵或正文與結構欄位相互矛盾時停止，不自行修補。
- 讀取同一 DAG.md 的 front matter，固定 `revision`；舊 Task 不一定另有 revision 欄位，不能強加它。調用者/Checkpoint 帶有預期 revision 時核對一致。DAG 為 DRAFT、BLOCKED、DONE 或 SUPERSEDED 時不啟動新執行，請 Coordinator 核對全域條件；CONFIRMED/IN_PROGRESS 也不代表所有 Task READY。
- 記錄 Task 原文雜湊、排除 status/Expected Outputs 後的契約雜湊、Git HEAD 與基線。在每批編輯、長工具操作後、寫報告及完成前重讀 revision 與契約；發現漂移即停止、Checkpoint 並報 discrepancy。雜湊檢查不是鎖，不能宣稱已排除同時寫入。

## Status Gate

| Task status | 行為 |
|---|---|
| PLANNED | 明確指定本 Task 的執行請求可授權 readiness 檢查；全部前提滿足後，由 Executor 在自身 Task 記錄 READY，再進 IN_PROGRESS；不能僅因被指定就略過依賴 |
| READY | 前提重新核對通過後進 IN_PROGRESS |
| IN_PROGRESS | 預設停止以免雙重執行；只有明確恢復指示、原 Session 已停止且 Checkpoint/工作樹歸屬核對後才接續 |
| BLOCKED / FAILED | 明確恢復/重試且解除條件已滿足，保留歷史報告，重新檢查 READY 條件再執行；不得靜默洗掉 blocker 或失敗證據 |
| DONE | 回傳既有交接位置並停止；不重跑、不追加替代結果或重置狀態 |
| SUPERSEDED | 停止，回傳替代節點說明；不能自動改為執行替代 Task |

失敗 preflight 只在契約有效、具自身 Task 寫入權且確定沒有另一個執行者持有時，才將可維護的當前 Task 標為 BLOCKED 並保存原因。DONE、SUPERSEDED 或疑似他人執行中的狀態不得改動。

## Dependency Inputs

只讀直接依賴的 front matter 及指定交接小節，不載入所有兄弟任務。逐項核對：

1. `depends_on` 節點存在且為 DONE，無自依賴/廢棄依賴；`inputs.from` 位於 depends_on，output 名稱匹配生產者 outputs，每條依賴確有消費內容。
2. `location` 可定位；`repository:path` 相對 repository root，Markdown 路徑相對消費 Task，保留錨點含義。核對輸出名稱、接口、失敗行為、版本、驗收證據及取得條件；不是只看檔案存在。
3. 程式產物已在**目前** Git 基線可用；branch/commit/patch 必須由既有授權的機制整合到當前 worktree 或可直接消費的位置，不能只看到另一條分支的 DONE 報告便開始。
4. research 結論須有獨立持久化文件，先讀其版本、決策與未決問題；缺失或高影響問題未決時停止。上游手動項若只要求交接且已符合輸入契約，不因其 PARTIAL 自動拒絕依賴。
5. 外部輸入以 source/location 明示，不偽裝 DAG ID。遠端快照或 URI 無法核對時，請 Coordinator 提供可取得且版本明確的產物；不自動下載、cherry-pick 或執行另一個 Task。

缺依賴時保存可取得的 Checkpoint、缺少的 producer/output/location、恢復條件；不編造依賴內容、不修復生產者、不寫兄弟報告。

## Git, Scope and Mode

記錄 HEAD、branch 或 detached HEAD、worktree 標識，以及 staged/unstaged/untracked/unmerged 路徑。沒有 commit 基線、merge/rebase/cherry-pick 正在進行或有未解衝突時停止；不要自動 stash、reset、clean 或丟棄使用者改動。與 Task 無關的既有 dirty 檔案記入基線並保留，不能算作本次產物。Scope 內既有改動必須辨明所有權；恢復時逐項對比 Checkpoint 的檔案雜湊/patch，不能用一個 resume 參數當作覆寫許可。

`read_scope` 是定向載入範圍，不是一次讀完的清單。完整自身 Task、適用 AGENTS、必要 DAG metadata 與直接依賴的指定輸入屬於 preflight 的必要讀取；其他源碼按已聲明路徑/符號及觸發條件漸進載入。範圍外的必要調查先報差異，不能靜默擴大範圍。

對每個預期新增/修改/刪除、rename 的兩端、測試/生成器/安裝命令的連帶寫入，先核對 write_scope。路徑相對 repository root，使用 `/`；考慮目錄/glob、Windows 大小寫等價與 symlink/junction 真實目標。共享 DAG.md、CONTEXT.md、兄弟 Task、他人 research 及 `.git` 不因過寬 glob 而取得修改權。自身 Task 只能改 status、報告與產物引用，不改執行契約。

| execution_mode | 核對事項 |
|---|---|
| readonly | 業務文件只讀；只寫明列的自身狀態/報告及自身聲明的 research 結論。宿主完全只讀時交由 Coordinator 落盤 |
| same_workspace | Scope/副作用獨立，沒有同時修改同一範圍的執行者；不要求無關 dirty 檔案全部清空 |
| isolated_worktree | 已在指定獨立 worktree、分支/基線與依賴產物正確；不自行降級 same_workspace；需要建立 worktree 時由外部安排或取得既有明確授權 |
| integration | 只整合契約列出的產物與路徑；核對共同基線、取得/應用順序、衝突處理和驗證入口；不得自行合併未列入的分支 |

## Adaptive Context Review

新舊 Task 都不要求填固定 Token 目標、軟限、硬限、預留或窗口值。支援可選 context_management 與舊 context_budget；數字無可信 provenance 時僅提示。六類成本可定性/未知，有依據才量化；峰值與累計分開。完整一致契約見 [Planner Context reference](../../dag-planner/references/context-planning.md)，Worker 內建相同純判定模組，不需載入整套 Planner 才可執行。

核對當前真實模型窗口、宿主輸入/輸出與剩餘容量、使用者/平台明確上限；不以提高配置繞過。無遙測時明示未知、保守按需載入、保留工作/驗證/修復/交付餘地並視風險提前 Checkpoint；不能視為無限，也不僅因缺精確數字而阻塞。估值超舊人工門檻只警告，不拒絕 READY。

合理最佳化後仍有可信最低必要需求超過已核對容量/明確上限，或宿主回報可信無法繼續的容量故障，才因 Context 不足 BLOCKED + Split Request。需要 optimization_attempts 與 evidence；峰值上界或未證實的「超限」不夠。舊 Task 缺 Loading Plan 可在報告形成 Session 的動態策略，不修改 front matter 或歷史狀態。若只有 Session 歷史擁擠，可交接同一 Task 到新 Session，不必拆分。
