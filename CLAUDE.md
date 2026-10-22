# 工作流程（Wei 定的，2026-10-22 起）

每個需求都走七關，每一關的產出放在 `docs/work/<題目>/`，關卡之間要 Wei 說 OK 才往下：

1. **consulting** 跟 Wei 討論要件 → `01-要件.md` → Wei OK
2. **uiux** 設計畫面、更新 canvas → `02-設計.md` → Wei OK
3. **coder** 從 `develop` 開 feature 分支實作、自檢、commit、開 PR `feature → develop` → `03-實作.md`
4. **reviewer** 審那個 PR，findings 留在 PR 上 → `04-審查.md`；有 blocker 退回 coder 改，改完再審，通過後合併進 `develop`
5. **security** 審 develop 對 main 的 diff → `05-資安.md`（blocker 必須清零）　｜　6. **qa** 在 develop 上 mock 走流程＋regression → `06-測試.md`（5、6 平行）
7. **reporter** 開 PR `develop → main`，整理成一頁 → `07-總結.md`（含 PR 連結）→ Wei OK → Claude 合併 `develop → main`（= deploy）

分支：
- `main`＝正式環境，只接受 `develop → main` 的 PR，合併就 deploy。
- `develop`＝整合分支，feature 都從這裡分出來、合回這裡。
- `feature/<題目>`＝一個題目一條，coder 用。

硬規則：
- 所有修正都先討論修法，Wei 說好才做；要件以外的改動不順手做。
- 合併進 main 就是 deploy：training-api 的 GitHub Actions 自動 deploy，training-web 由 Cloudflare 建置。`develop → main` 的 PR 要 Wei 看完總結說 OK，Claude 才合併；不直接推 main。
- schema 有改就在總結裡寫「需要 npm run migrate」，Wei 本機跑（先 git pull）。
- UI 不顯示模型名稱；不把 secret 貼進對話或 commit。
- 設計 canvas：https://claude.ai/artifact/4Lc98VDehARXEZpFUfBZ7h（New-* 為定案樣式）。

Agent 定義在 `.claude/agents/`：consulting、uiux、coder、reviewer、security、qa、reporter。
