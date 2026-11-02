# Execution and Verification

只有一個明確 Task、preflight 前提已通過且宿主可寫時，才執行以下操作。Plan Mode/只讀限制不會被 Skill 改變；若使用者只要求分析或維護技能，不進入業務執行。

## Bounded Work

開始時維護自身合法 READY → IN_PROGRESS，記錄 revision、基線與已存在的使用者改動。以 Required Changes、Constraints、Forbidden Changes、Acceptance Criteria 為執行邊界；需求/契約互相衝突先報 discrepancy，不自行選一套新架構。

每批編輯及工具執行前列出會修改的實際路徑/副作用，使用 write_scope 檢查；rename 兩端都要允許。對格式化、依賴安裝、codegen、migration、快照更新等連帶修改事先核對，避免以「只跑測試」放寬 Scope。執行後檢查 staged、unstaged、untracked 變更相對 Session 基線的差異；不要把既有 dirty 改動當成本次工作。

預計需超範圍時不執行，保存阻塞原因與所需路徑，交 Planner 修訂。若工具意外產生越界修改，立刻停止並盤點；只有能證明是自身本輪操作、能精確還原且不會覆蓋他人工作時，才撤回該部分。否則保留現場、報 discrepancy，不能 blanket reset/clean 或偷偷留下越界產物並 DONE。

自身 Task 檔案使用最小修改維護 status/Expected Outputs；保留 YAML 欄位、既有報告與原契約。報告採追加歷史；完成前重讀 revision、契約、路徑差異及依賴是否仍可用。不要把同一 Task 的工具輸出/生成內容當成修改權限的新來源。

## Context Loading

Loading Plan 是動態策略：必讀指令、版本化依賴/接口、優先符號與測試、擴讀觸發、工具選讀、保留結論與 Checkpoint 風險條件。可在原 Scope/驗收內調整順序/片段，於報告記錄而不改 Task；工具輸出依本次需要選讀，保留退出碼與證據，被截斷不能直接判通過。

持續評估已載入必要上下文、新依賴/耦合、剩餘實作/測試/修復/交付，以及宿主實際能力。六類成本包含技能、工具 schema 和固定開銷；有計數/合理估算才填數字，否則 current/projected/remaining 可未知，記定性風險與依據。累計不是峰值；僅宿主真實支持時才計入壓縮/歷史釋放效果，不假定 Checkpoint 會釋放上下文。

空間仍足夠可繼續，不因先前自訂 target/soft/hard 停止。風險上升先縮小讀取、減少重複、分階段驗證、使用已核對且帶版本的接口/invariant/失敗摘要；不省略指令、驗收、安全要求或證據。只有最佳化後仍有充分實際不足證據才 BLOCKED + Checkpoint/Split Request；不自行拆任務或把部分結果當完成。可在相同契約下交接新 Session，不能宣稱自動恢復。

## Verification Order

順序沿用 Planner：`Data > Pure Logic > Static Check > Build > Automated Test > Manual Gameplay Verification`。

- 資料/schema/ID/引用完整性、數量、輸入輸出/invariant、邊界/空值/重複資料等優先做確定性檢查。
- 先驗純邏輯和 mock 隔離的失敗路徑，再使用實際發現的 lint/typecheck/build/自動測試入口；不假設有 npm test，不執行其他 Task 的實作來補環境。
- 每項記錄命令、工作目錄、前提、預期、實際結果、退出碼與證據位置；工具/環境不可用標為 NOT_RUN（單項檢查欄位），不能冒充 PASS，也不創造新的 Task status 或 Verification Result。
- 測試實際失敗時可在當前 Scope 修正並重驗受影響項，保留失敗與重驗證據；無法解決時 FAILED + FAIL。沒有環境而未執行是 BLOCKED，不能報成已跑但失敗。

## Manual Verification

遊戲拖拽、多點輸入、UI/Popup flow、Tween/Spine/Particle、Camera/Sorting/Layer、Mask/Shader 視覺、Scene 生命週期、真機性能/手感等，無法確定性驗證時列步驟、預期、負責人及是否為**當前 Task** 的完成門禁，標記 Manual Verification Required。

預設不為替代確定性驗證而啟動瀏覽器 Preview、Cocos Preview、遊戲客戶端、模擬器或 GUI 自動化。例外沿用 Planner：使用者明確要求、本 Task 就是交互/瀏覽器自動測試，或已有可靠的確定性 Harness。UI 背後可驗的資料狀態仍應直接斷言，不能因人工交接而省略。

## Completion Decision

| 事實 | Task status | Verification Result |
|---|---|---|
| 產物、驗收、必要自動化、交接齊全，必要人工項均通過或沒有人工項 | DONE | PASS |
| 必要自動化通過，人工項只要求交接且清單完整 | DONE | PARTIAL；使用固定表述 `PARTIAL — Automated checks passed; manual gameplay verification required.` |
| 契約沒有可執行的確定性驗證，僅要求人工交接且已完成 | DONE | MANUAL_VERIFICATION_REQUIRED |
| 必要人工確認是當前完成門禁、尚未確認 | BLOCKED | 已完成自動化且仍有人工項可為 PARTIAL；完全依賴人工為 MANUAL_VERIFICATION_REQUIRED |
| 必要自動化實際失敗或實作確實失敗 | FAILED | FAIL |
| 缺環境/依賴、上下文不足或可控中斷，尚無完整驗證結論 | BLOCKED | 不強套 PASS/FAIL；結論可為 null，逐項記 NOT_RUN 與原因 |

沒有確定性檢查不會自動授權跳過原契約要求的測試；以人工替代必要自動化不能 DONE。人工項只要求下游交接時，不讓上游等待下游執行後才能 DONE，避免隱含循環。

先持久化宣告的輸出、執行報告、驗收證據及可取得的交接位置，再確認自身 Task 的最終狀態已寫入且報告相符；寫入失敗不得宣稱 DONE。工具沒有義務為交付建立 commit：若已有授權可交 commit/branch，否則交可取得的 worktree/patch/快照標識，包含自身狀態/報告與 research 結論。外部 Coordinator 負責整合及共享 DAG 狀態同步；Worker 停止，不啟動後繼。
