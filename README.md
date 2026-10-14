# training-api

Strava 連動的馬拉松課表追蹤後端。兩個使用者，Node.js 22 + TypeScript，infra 用 AWS CDK。

```
Strava webhook → Lambda webhook → SQS activities → Lambda worker → Aurora
Strava OAuth   → Lambda oauth   → Aurora
EventBridge Scheduler（每週日 21:00 JST）→ Lambda weekly → Claude API → Aurora
前端（GitHub Pages）→ Lambda api（GET /plan, GET /activities）→ Aurora
```

- 所有 Lambda 都不在 VPC 內（Aurora 有公開 endpoint；Lambda 要打 Strava / Claude）。
- 對外的三個 Lambda 用 Function URL（auth NONE），沒有 API Gateway。
- DB 認證走 IAM：`@aws-sdk/rds-signer` 產 token 當密碼，SSL 用打包進 Lambda 的 RDS global CA bundle（`src/lib/global-bundle.pem`）。
- Aurora Serverless v2 min 0 ACU，閒置 5 分鐘會 pause；第一次連線要等 10–15 秒。Lambda timeout 60 秒（worker 90 秒），worker 連線失敗會 throw 讓 SQS 重送（3 次後進 DLQ）。

## 1. 安裝與 `.env`

```bash
npm i
cp .env.example .env
```

`.env` 要填：

| 變數 | 說明 |
|---|---|
| `AWS_REGION` | `ap-northeast-1` |
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` | Aurora writer endpoint、5432、`postgres`、`postgres` |
| `DB_CLUSTER_RESOURCE_ID` | `aws rds describe-db-clusters --db-cluster-identifier training --query 'DBClusters[0].DbClusterResourceId' --output text`（CDK 用它組 `rds-db:connect` 的 ARN；也可用 `cdk synth -c dbClusterResourceId=...`） |
| `STRAVA_CLIENT_ID` / `STRAVA_CLIENT_SECRET` | https://www.strava.com/settings/api |
| `STRAVA_VERIFY_TOKEN` | 自己亂打一串，註冊 webhook 時 Strava 會拿它來驗證 |
| `ANTHROPIC_API_KEY` | 週總結用 |
| `CLAUDE_MODEL` | 預設 `claude-haiku-4-5` |
| `CORS_ORIGIN` | 預設 `https://iamwuwei.github.io` |
| `WEBHOOK_URL` | deploy 之後再填（給 `npm run subscribe-webhook` 用） |

`.env` 只在 `cdk synth` 時由 dotenv 讀進來，直接變成 Lambda 的環境變數（沒有 Secrets Manager）。本機跑 `migrate` / `seed` 也讀同一個 `.env`，DB 連線用你本機的 AWS credentials（需要對 `training` cluster 的 `rds-db:connect` 權限）。

## 2. 建 schema、灌課表

```bash
npm run migrate   # 執行 sql/schema.sql（可重跑）
npm run seed      # 讀 seed/plans.json → users / plans / planned_sessions（可重跑，不會重複）
```

- `seed/plans.json` 由 `python3 scripts/xlsx-to-plans.py` 從 `../running/富士山馬拉松_2026_課表.xlsx` 產生（預設假設 `running` repo 和這個 repo 並排 clone；也可以把 xlsx 路徑當參數傳入。需要 `openpyxl`）。課表改了就重跑這個再 `npm run seed`。
- 兩個 user 的 uuid 和 `display_name` 寫死在 `seed/seed.ts` 的 `USERS`，要改名字就改那裡再重跑 seed。seed 完會印出每個 user 的 uuid，前端和 OAuth 連結都用這個 uuid。
- 類型正規化表在 `scripts/xlsx-to-plans.py` 的 `TYPE_MAP`；遇到沒看過的類型會直接報錯列出來。

## 3. 部署

```bash
npm run build        # tsc 型別檢查
npx cdk bootstrap    # 第一次
npx cdk deploy
```

Output 會有三個 Function URL：`WebhookUrl`、`OauthUrl`、`ApiUrl`。

## 4. Strava 設定

1. 到 https://www.strava.com/settings/api，把 **Authorization Callback Domain** 改成 `OauthUrl` 的 domain（只要 host，例如 `xxxx.lambda-url.ap-northeast-1.on.aws`）。
2. 把 `WebhookUrl` 填進 `.env` 的 `WEBHOOK_URL`，然後：

   ```bash
   npm run subscribe-webhook
   # 或 npm run subscribe-webhook -- https://xxxx.lambda-url.ap-northeast-1.on.aws/
   ```

   會先 GET 檢查有沒有既有 subscription，有就跳過；沒有才 POST。Strava 會在這時打 `WebhookUrl` 做 `hub.challenge` 驗證。

## 5. 授權流程

把 `<OauthUrl>/start?user=<uuid>` 傳給使用者點（uuid 從 `npm run seed` 的輸出拿）。流程：302 到 Strava → 同意 `activity:read_all` → `/callback` 用 code 換 token 寫進 `strava_connections` → 顯示「設定完成 ✓」。之後每次新活動 Strava 會推 webhook，worker 抓細節、配對課表、寫進 `activities`。

## API

型別在 `types/api.ts`（`PlanResponse` / `ActivitiesResponse` / `ErrorResponse`）。

- `GET <ApiUrl>/plan?user=<uuid>` → `{ plan, sessions, activities }`：active plan、未 superseded 的 sessions、已配對的 activities。
- `GET <ApiUrl>/activities?user=<uuid>&status=unplanned` → `{ activities }`，`status` 可為 `auto | confirmed | unplanned | ignored`，省略則全部。

第一版沒有認證，user uuid 當 bearer。

## 配對規則（`src/lib/matcher.ts`）

候選：該 user 的 active plan、活動日期 ±2 天、未 superseded、未被其他活動配走的 session（rest 不配）。
1. 同一天 → 選距離最接近的。
2. 沒有同一天 → 距離差 < 30% 的視為提前/延後，先看日期近的再看距離。
3. 都沒有 → `match_status = 'unplanned'`、`session_id = null`。

配到的標 `auto`，不會自動變 `confirmed`。update 事件重跑時，已經是 `confirmed` / `ignored` 的不會被覆蓋。

## 週總結（`src/handlers/weekly.ts`）

每週日 21:00 JST 對每個 active plan 抓本週（一〜日）的課表和活動，加上接下來兩週的課表，請 Claude 回 `{ summary, adjustments[] }`，整包寫進 `weekly_reviews`。**第一版只記錄不套用 adjustments。** 要補跑某一週：在 Lambda console 用 `{"week_start": "2026-10-12"}`（週一）手動 invoke。

## 檔案

```
training-api/
├── infra/        CDK（bin/app.ts, lib/stack.ts）
├── src/
│   ├── handlers/ webhook / worker / oauth / weekly / api
│   ├── lib/      db（IAM token + pg Pool）、strava、matcher、claude
│   └── types.ts  內部 row / Strava 型別
├── types/        api.ts — API request/response 型別（前端直接複製用）
├── sql/          schema.sql
├── seed/         plans.json、seed.ts
└── scripts/      migrate.ts、subscribe-webhook.ts、xlsx-to-plans.py
```
