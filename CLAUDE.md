# 工作流程（Wei 定的，2026-10-22 起）

每個需求都走六關，每一關的產出放在 `docs/work/<題目>/`，關卡之間要 Wei 說 OK 才往下：

1. **consulting** 跟 Wei 討論要件 → `01-要件.md` → Wei OK
2. **uiux** 設計畫面、更新 canvas → `02-設計.md` → Wei OK
3. **coder** 在分支實作、自檢、commit 到分支（不推 main）→ `03-實作.md`
4. **security** 審 diff → `04-資安.md`（blocker 必須清零）　｜　5. **qa** mock 走流程＋regression → `05-測試.md`（4、5 平行）
6. **reporter** 整理成一頁 → `06-總結.md` → Wei OK → 推 main（= deploy）

硬規則：
- 所有修正都先討論修法，Wei 說好才做；要件以外的改動不順手做。
- 推 main 就是 deploy：training-api 的 GitHub Actions 自動 deploy，training-web 由 Cloudflare 建置。沒有 Wei 的 OK 不推。
- schema 有改就在總結裡寫「需要 npm run migrate」，Wei 本機跑（先 git pull）。
- UI 不顯示模型名稱；不把 secret 貼進對話或 commit。
- 設計 canvas：https://claude.ai/artifact/4Lc98VDehARXEZpFUfBZ7h（New-* 為定案樣式）。

Agent 定義在 `.claude/agents/`：consulting、uiux、coder、security、qa、reporter。
