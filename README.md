# training-api

Strava 連動的馬拉松課表追蹤後端。兩個使用者，Node.js 22 + TypeScript，infra 用 AWS CDK。

```
Strava webhook → Lambda webhook → SQS activities → Lambda worker → Aurora（＋ Claude 單次判定）
Strava OAuth   → Lambda oauth   → Aurora
EventBridge Scheduler（每週日 21:00 JST）→ Lambda weekly → Claude API → Aurora
前端 → Lambda auth（Sign in with Apple → session token）
前端 → Lambda api（GET /plan, GET /activities, PUT /activities/{id}/review）→ Aurora
```

- 所有 Lambda 都不在 VPC 內（Aurora 有公開 endpoint；Lambda 要打 Strava / Claude）。
- 對外的四個 Lambda（webhook / oauth / auth / api）用 Function URL（auth NONE），沒有 API Gateway。
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
| `AUTO_REVIEW` | `true`（預設）：worker 每筆配對到課表的跑步都請 Claude 寫判定；`false` 關掉 |
| `APPLE_CLIENT_ID` | Sign in with Apple 的 **Services ID**（前端 Apple JS SDK 用的 `clientId`） |
| `SESSION_SECRET` | 隨機 32 字以上，簽 session token；換掉等於全部登出 |
| `CORS_ORIGIN` | 逗號分隔，例如 `https://training.pages.dev,http://localhost:5173` |
| `WEBHOOK_URL` | deploy 之後再填（給 `npm run subscribe-webhook` 用） |

`.env` 只在 `cdk synth` 時由 dotenv 讀進來，直接變成 Lambda 的環境變數（沒有 Secrets Manager）。本機跑 `migrate` / `seed` 也讀同一個 `.env`，DB 連線用你本機的 AWS credentials（需要對 `training` cluster 的 `rds-db:connect` 權限）。

## 2. 建 schema、灌課表

```bash
npm run migrate   # 執行 sql/schema.sql（可重跑；既有 DB 會用 add column if not exists 升級）
npm run seed      # 讀 seed/plans.json → users / plans / plan_weeks / planned_sessions（可重跑）
# …授權 Strava 之後：
npm run backfill  # 把課表開始日起的 Strava 跑步全部拉進 activities（走和 webhook 一樣的 worker 邏輯）
npm run seed      # 再跑一次：把 xlsx 裡手打的 判定／心得／提醒／天氣／鞋／裝置 掛到同一天的 activity 上
```

- `seed/plans.json` 由 `python3 scripts/xlsx-to-plans.py` 從 `../running/富士山馬拉松_2026_課表.xlsx` 產生（預設假設 `running` repo 和這個 repo 並排 clone；也可以把 xlsx 路徑當參數傳入。需要 `openpyxl`）。課表改了就重跑這個再 `npm run seed`。
- 兩個 user 的 uuid、`display_name`、`email` 寫死在 `seed/seed.ts` 的 `USERS`。`email` 填 Apple ID 的 email（或 private relay 位址）：第一次 Apple 登入會用 email 對到這一列並記下 `apple_sub`，之後只認 `apple_sub`。沒對到的人登入會拿到 403（封閉系統）。
- 類型正規化表在 `scripts/xlsx-to-plans.py` 的 `TYPE_MAP`；遇到沒看過的類型會直接報錯列出來。

## 3. 部署

### 手動

```bash
npm run build        # tsc 型別檢查
npx cdk bootstrap    # 第一次
npx cdk deploy
```

Output 會有四個 Function URL：`WebhookUrl`、`OauthUrl`、`AuthUrl`、`ApiUrl`。

### 自動（GitHub Actions，`.github/workflows/deploy.yml`）

- pull request：`npm ci` → `npm run build` → `cdk synth`（不碰 AWS）。
- push 到 `main`：同上，再用 OIDC 換 AWS role 跑 `cdk deploy --require-approval never`，最後印出 Function URL。
- `migrate` / `seed` / `backfill` 不在 CI 裡，schema 改動在本機跑。

一次性設定：

1. **AWS**：IAM → Identity providers 加 `token.actions.githubusercontent.com`（audience `sts.amazonaws.com`）。IAM → Roles → Create role → Web identity，organization `iamwuwei`、repository `training-api`。建好後把 trust policy 的 `sub` 條件改成下面這樣。兩個理由：deploy job 綁 `environment: prod`，所以 token 的 `sub` 是 `…:environment:prod` 而不是 `ref:refs/heads/main`；而且 GitHub 現在的 `sub` 長這樣 `repo:iamwuwei@17942614/training-api@1418352990:environment:prod`（owner / repo 後面帶 `@id`），console 產生的精確比對不會符合，要用 `StringLike` + `*`：

   ```json
   "Condition": {
     "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
     "StringLike": { "token.actions.githubusercontent.com:sub": [
       "repo:iamwuwei*/training-api*:environment:prod",
       "repo:iamwuwei*/training-api*:ref:refs/heads/main"
     ] }
   }
   ```

   deploy job 的「Show OIDC claims」步驟會印出實際的 `sub`，assume role 失敗時先對這個。

   role 的 inline policy 只要能 assume CDK bootstrap 的 role：

   ```json
   { "Version": "2012-10-17", "Statement": [{ "Effect": "Allow", "Action": "sts:AssumeRole", "Resource": "arn:aws:iam::*:role/cdk-hnb659fds-*" }] }
   ```

   `cdk bootstrap` 仍然要在本機先跑過一次。
2. **GitHub** → Settings → Environments → 建 `prod` → 在裡面加 environment secrets（deploy job 綁 `environment: prod`；repository secrets 也可以）：

   | Secret | 來源 |
   |---|---|
   | `AWS_ROLE_ARN` | 上面那個 role 的 ARN |
   | `DB_CLUSTER_RESOURCE_ID` | `aws rds describe-db-clusters --db-cluster-identifier training --query 'DBClusters[0].DbClusterResourceId' --output text` |
   | `STRAVA_CLIENT_ID` / `STRAVA_CLIENT_SECRET` / `STRAVA_VERIFY_TOKEN` | 同 `.env` |
   | `ANTHROPIC_API_KEY` | 同 `.env` |
   | `APPLE_CLIENT_ID` / `SESSION_SECRET` | 同 `.env` |

   非 secret 的（`DB_HOST`、`CLAUDE_MODEL`、`AUTO_REVIEW`）寫在 workflow 的 `env`；`CORS_ORIGIN` 可以用 repository **variable**（不是 secret）覆蓋。

## 4. Sign in with Apple 設定

1. developer.apple.com → Identifiers → 建一個 **App ID**（勾 Sign in with Apple）和一個 **Services ID**（這個是 `APPLE_CLIENT_ID`），Services ID 的 Web Authentication 設定裡填前端網域和 return URL。
2. 前端用 Apple JS SDK（`appleid.auth.init({ clientId, scope: "email", usePopup: true })`），拿到 `authorization.id_token` 後 `POST <AuthUrl>/apple` body `{ "id_token": "…" }`，回 `{ token, expires_at, user }`。
3. 之後每個 api 請求帶 `Authorization: Bearer <token>`。token 30 天有效、無狀態（HMAC），`GET <AuthUrl>/me` 可以驗。

## 5. Strava 設定

1. 到 https://www.strava.com/settings/api，把 **Authorization Callback Domain** 改成 `OauthUrl` 的 domain（只要 host，例如 `xxxx.lambda-url.ap-northeast-1.on.aws`）。
2. 把 `WebhookUrl` 填進 `.env` 的 `WEBHOOK_URL`，然後：

   ```bash
   npm run subscribe-webhook
   # 或 npm run subscribe-webhook -- https://xxxx.lambda-url.ap-northeast-1.on.aws/
   ```

   會先 GET 檢查有沒有既有 subscription，有就跳過；沒有才 POST。Strava 會在這時打 `WebhookUrl` 做 `hub.challenge` 驗證。

## 6. 授權流程

把 `<OauthUrl>/start?user=<uuid>` 傳給使用者點（uuid 從 `npm run seed` 的輸出拿）。流程：302 到 Strava → 同意 `activity:read_all` → `/callback` 用 code 換 token 寫進 `strava_connections` → 顯示「設定完成 ✓」。之後每次新活動 Strava 會推 webhook，worker 抓細節、配對課表、寫進 `activities`。

## API

型別在 `types/api.ts`。全部要帶 `Authorization: Bearer <session token>`，沒有或過期回 401。

- `GET <ApiUrl>/plan` → `PlanResponse { plan, weeks, sessions, activities }`：active plan、每週階段/重點、未 superseded 的 sessions（含原始 `label`、`content`、`target` 原文、配速/心拍上下限、`week_no`、`phase`）、已配對的 activities（含 `review`、最高心拍、功率、卡路里、鞋、裝置、天氣、每公里分段）。
- `GET <ApiUrl>/activities?status=unplanned` → `ActivitiesResponse`，`status` 可為 `auto | confirmed | unplanned | ignored`，省略則全部。
- `PUT <ApiUrl>/activities/{id}/review` body `PutReviewRequest { verdict, comment?, reminders?, rpe? }` → 手動判定，會覆蓋 Claude 的。
- `POST <AuthUrl>/apple`、`GET <AuthUrl>/me` 見上。

## 判定（reviews）

- 來源兩種：`source = 'claude'`（worker 在 `AUTO_REVIEW=true` 時自動寫，每筆 activity 只寫一次，不覆蓋既有）、`source = 'manual'`（`PUT …/review`，或 seed 從 xlsx V/L/W 欄帶入）。手動永遠贏。
- `verdict` 只有 `達成 / 達成但有提醒 / 未達成`；「跳過」是課表層級的狀態，前端用「過去的 session 沒有配對 activity」自己判斷。
- 天氣沒有自動來源：`activities.weather` 只在 seed 帶歷史值，之後為 null，前端沒值就不顯示。

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
│   ├── handlers/ webhook / worker / oauth / weekly / api / auth
│   ├── lib/      db（IAM token + pg Pool）、strava、matcher、claude、auth
│   └── types.ts  內部 row / Strava 型別
├── types/        api.ts — API request/response 型別（前端直接複製用）
├── sql/          schema.sql
├── seed/         plans.json、seed.ts
└── scripts/      migrate.ts、backfill.ts、subscribe-webhook.ts、xlsx-to-plans.py
```
