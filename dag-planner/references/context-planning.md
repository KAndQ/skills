# Adaptive Context Management

用於成本分析、動態載入、粒度判斷及 Context 不足後的重規劃。Token 估算輔助決策，不是固定執行門禁；不改變 ID、status、Plan Mode、Scope、SSOT、驗收或 Coordinator 職責。Split Request 格式仍見 [execution-protocol.md](execution-protocol.md#context-budget-blocker-and-split-request)。

## Estimation Model

保留六類成本分析，可在 Task 正文 Loading Plan 中說明，或使用可選 context_management.estimate。只有有合理計數/估算依據時才填 Token 範圍；其餘記 null、定性風險、依據與未知項，不為通過校驗編造數字。

| 類別 | 分析內容 |
|---|---|
| fixed_instructions | 完整 Task、適用指令、Worker 技能、宿主/工具 schema 開銷；不可觀測部分標未知 |
| source_reading | 必要源碼符號、相關調用方、測試/配置；依觸發條件擴讀 |
| dependency_inputs | 版本化接口、研究結論、驗收證據及可取得條件 |
| tool_output | 選擇性載入搜尋、diff、診斷、測試輸出；完整日誌保留可取得位置 |
| working | 剩餘實作、耦合狀態、失敗路徑、測試修復與中間方案空間 |
| delivery | 輸出、驗證報告、Checkpoint、人工交接及恢復所需空間 |

單次峰值 peak_tokens 是同時駐留的指令、必要資料與後續工作/交付需求；累計 cumulative_tokens 是多輪輸入/輸出、重送、重讀和重試總消耗，不能當作單次窗口需求。沒有資訊時兩者都可未知。不同階段的檔案未必同駐，不能將整個 read_scope 大小當成峰值，也不能用累計超過窗口阻塞任務。

依據可以是實際 tokenizer、宿主計數、可定位片段的樣本估算；註明來源、信心、去重及同駐假設。新格式不要求六項數字相加等於峰值；舊格式若完整宣告六項數值包絡，仍檢查其算術一致性。

## Adaptive Context Schema

不增加 Task 必填欄位；沒有 context_management、context_budget 或 Token 數值的新/舊 Task 均合法。新建/重規劃時，按風險在正文或可選映射記錄六類成本與動態 Loading Plan，不要求填固定目標、軟限、硬限、預留或模型窗口數字。

```yaml
context_management:
  mode: adaptive
  estimate:
    confidence: unknown
    basis: "假設示例：尚無宿主遙測；按契約、模組邊界與剩餘驗證分析，未量化。"
    components:
      fixed_instructions: {tokens: null, basis: "完整 Task 與適用指令必須保留"}
      source_reading: {tokens: null, basis: "先接口與目標符號，按調用關係擴讀", risk: "耦合待調查"}
      dependency_inputs: {tokens: null, basis: "只載入指定版本與交接證據"}
      tool_output: {tokens: null, basis: "摘要、退出碼和必要失敗片段"}
      working: {tokens: null, basis: "為實作、測試與修復保留動態空間"}
      delivery: {tokens: null, basis: "必須能保存產物、Checkpoint 與驗收報告"}
    peak_tokens: null
    cumulative_tokens: null
  constraints: []
```

components 可為範圍、null、定性說明，或 `{tokens: null/範圍, basis: 說明, risk: 風險}`。peak/cumulative 可缺省、null 或 `[lower, upper]` 非負整數範圍；有數字仍檢查型別、上下界及累計不小於相應峰值。estimate 可缺省，confidence 為 unknown/low/medium/high；依據不足警告，不永久阻塞。採用 Context metadata 時仍提供非空 Context Loading Plan。

## Real Constraints and Evidence

只有適用於當前模型/宿主/Session 的實際容量，或使用者/平台明確資源上限，才是 binding 約束。未知不能當無限，也不能因沒有遙測就永久阻塞；輸入、輸出、剩餘窗口各別遵守，不用合計估算放寬其他限制。

可選 constraints 每項為 `{dimension, tokens, source, confidence, evidence}`：

- dimension：context/input/output/remaining 是相應容量上限；cumulative 僅用於使用者/平台明確累計上限；headroom 是使用者/平台明定的最低剩餘工作餘量，須配合可驗證 remaining 評估。
- tokens 為非負整數或 null；沒有通用窗口、固定百分比或 Token 預設。
- source 為 model/host/user/platform/planner/unknown；confidence 為 verified/explicit/estimated/unknown。
- model/host 只有 verified 且 evidence 非空才可作 binding；user/platform 的 explicit 或 verified 且有 evidence 才可作明確約束。planner/unknown 或 estimated 不能冒充物理容量。
- evidence 指明真實來源、適用模型/Session/版本與核對方式；工具不會自行驗證來源真實/新鮮。缺來源的數值待複核，不能只加 verified 標籤就宣稱實測。

## Context Budget Schema

保留舊 context_budget，無需遷移歷史 Task。model_context_tokens、target_tokens、soft_limit_tokens、hard_limit_tokens、reserve_tokens 均可缺省/未知；有數字檢查型別。沒有可信來源時均為歷史估算提示，不因 peak 超過它們而拒絕 READY、拆分或重設狀態。舊排序與 reserve/窗口算式也不再是通用執行門禁。

舊值確由使用者明定或來自已核對宿主時，可在既有允許的修訂中使用可選 provenance：逐欄位記 source/confidence/evidence/dimension，語義與 constraints 相同。未指定 dimension 時一般數值指 context，reserve_tokens 指 headroom；reserve 是最低餘量而非最大容量。也可由調用者在目前 observation.constraints 提供約束，無需 Worker 改寫 Task。

改 provenance 或真正執行約束仍按 revision/運行中契約保護；不得替舊估值補造「使用者指定」，也不得提高配置繞過真實限制。未知來源不自動升格為 binding，已確認的使用者限制不因 adaptive 失效。

## Adaptive Decision and Runtime Observation

Planner 與 Worker 使用相同 assessContext 判定模組；各 Skill 保有獨立副本，測試檢查內容與行為一致，避免 Worker 必須安裝 Planner。模組只消費提供的證據，不具遙測/Orchestrator 能力。

1. 確認可取得的真實限制與來源，標記未知項。
2. 結合複雜度、耦合、必要輸入、已載入內容與剩餘實作/測試/修復/交付，決定下一批讀取。小型可一次完成，常規按需載入，大型先分析模組/驗收邊界；不套固定配額。
3. 風險上升時縮小讀取、去重、選讀工具輸出、分階段驗證；保留必要指令、接口、驗收、安全要求與證據。
4. 合理最佳化後，可信的最低必要需求仍超過 binding 容量，或宿主回報可信且無法繼續的容量故障，才因 Context 不足阻塞。僅峰值上界超某數字、缺遙測、定性複雜或舊 boolean 提示不足以證明不能完成。
5. 空間足夠則繼續，在報告更新觀察；否則保存 Checkpoint、BLOCKED 與相容 Split Request，交外部協調恢復/重規劃。只是 Session 歷史擁擠時，可交接新 Session 並保留同一 Task，不必拆成微型任務。

可選 assessment（規劃）或 runtime observation（執行）包含 current_peak_tokens、projected_peak_tokens、remaining_work_tokens（均可未知）、constraints、minimum_required_tokens（各維度可信最低必要範圍）、optimization_attempts 及 evidence。runtime observation 描述本次狀態，可替換規劃 assessment；不改 Scope/驗收或移除 Task 的 binding 約束。只有相應最低需求下界已超限，且有最佳化與證據，才足以判定無法容納；含糊範圍只警告。

無數字時可選 capacity_signal：source=host/platform、confidence=verified、非空 evidence，code 為 CONTEXT_EXHAUSTED / INPUT_LIMIT_EXCEEDED / OUTPUT_LIMIT_EXCEEDED / RESOURCE_UNAVAILABLE。必須是真實且仍適用的故障，仍需 optimization_attempts，不能把 Planner 預估改名為宿主訊號。

以下僅是假設 fixture，數字不是預設或建議配額：

```yaml
constraints:
  - dimension: remaining
    tokens: 9000
    source: host
    confidence: verified
    evidence: "假設 fixture：已由宿主核對的當前 Session 可用餘量。"
minimum_required_tokens:
  remaining: [11000, 13000]
optimization_attempts: ["已縮至必要接口、不可再縮的驗證資料與交付，並去除重複輸出"]
evidence: "假設 fixture：最佳化後仍必需的資料與交付下界有可定位依據。"
```

## Dynamic Context Loading Plan

Loading Plan 是策略，不是 Token 分配表：必讀規則與完整 Task；必要依賴/版本/證據；優先符號/檔案；擴讀觸發條件；工具輸出選讀；保留的接口/invariant/失敗行為/驗收結論；Checkpoint 風險條件。數字有依據才列，可全用定性內容。

Worker 可在原 Read Scope/Write Scope/驗收與其他契約內調整讀取順序/片段，記入報告，不改 Task 或自動增 revision。片段定位失效先搜尋符號；擴大 Scope、改接口/驗收/約束則交 Planner 修訂。

| 情況 | 載入策略 | 保留/Checkpoint 條件 |
|---|---|---|
| 小型、單一結果 | 必讀規則、單一實作與測試可一次載入 | 輸出異常擴大時重估 |
| 常規、接口明確 | 先接口/版本，再按符號讀取及選取失敗摘要 | 新依賴、修復迭代或空間風險增加時保存 |
| 大型或高耦合 | 依模組/狀態流分階段閱讀與驗證，保留跨階段結論 | 共享狀態、證據或交付空間將受損前保存；不為降低估值拆開核心狀態機 |

只有宿主確實支持壓縮/歷史釋放時才計入效果，並保留必要指令與恢復證據。Checkpoint 不等於歷史已釋放，也不等於自動恢復服務。

## Recursive Decomposition

按可獨立交付、所有權、接口/驗收邊界、寫入衝突及實際容量風險決定拆分。先改善載入；仍有真實風險且存在獨立邊界時，保留原目標/驗收映射、具名輸出與版本，重新檢查子任務/集成節點的必要上下文與重複成本。

高耦合任務可保持一個 Task，分階段執行/恢復。沒有獨立驗收邊界、重複載入增加累計消耗、只是 Session 需要交接時停止遞迴。Planner 不執行研究節點或啟動 Worker，不以提高配置「解決」真實不足。

## Repeatable Validation

只讀工具使用各 Skill scripts/ 的鎖定依賴；沒有業務建置/部署/資料庫步驟。從倉庫根執行：

```powershell
npm ci --prefix .codex/skills/dag-planner/scripts
npm run check --prefix .codex/skills/dag-planner/scripts
npm test --prefix .codex/skills/dag-planner/scripts
node .codex/skills/dag-planner/scripts/validate_dag.mjs .dag/<dag-id> --before C:/temp/before/.dag/<dag-id>
```

替換示意路徑後執行。可選 `--context-observations <JSON-file>` 提供 `{T001: observation, ...}`；如有 task_id/dag_revision 須匹配目前基線。這是證據輸入介面，不自動取得遙測。

保留 YAML/ID/status、依賴存在/無環、Scope 結構、具名輸出/位置、SSOT、revision、歷史狀態、Split Request/Resolution/Checkpoint 與驗收映射檢查。缺數值合法、未知警告；有值的型別/範圍/舊完整包絡算術仍須合法。READY 閉包及 DONE/IN_PROGRESS 保護不變，純文案仍做 CONTRACT_TEXT_REVIEW 語義審查。

退出碼 0 表示覆蓋檢查通過，1 表示契約錯誤/有證據的容量不足，2 表示參數/讀取/YAML/JSON 失敗。沒有 --before 或現有錯誤阻止對比時，明示未執行狀態保護。tests 使用 OS 臨時 fixture，不執行業務 Task。

校驗器不能證明宿主證據真實/新鮮、所有權已停穩、摘要保真或驗收語意完整。仍需人工/外部 Coordinator 核對限制與 Session、做語義審查及串行同步；不宣稱不存在的遙測、壓縮或自動恢復能力。
