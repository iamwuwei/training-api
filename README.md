# training-api

Strava 連動的馬拉松課表追蹤後端。兩個使用者，Node.js 22 + TypeScript，infra 用 AWS CDK。

```
Strava webhook → API Gateway /strava/webhook → Lambda webhook → SQS activities → Lambda worker → Aurora（＋ Claude 單次判定）
Strava OAuth   → API Gateway /strava/oauth/* → Lambda oauth → Aurora
EventBridge Scheduler（每週日 21:00 JST）→ Lambda weekly → Claude API → Aurora
前端 → Cognito（登入，拿 ID token）
前端 → API Gateway HTTP API（Cognito JWT authorizer）→ Lambda api → Aurora
```

資源命名：全部 `training-api-<thing>-<STAGE>`；stack、HTTP API 和它後面的 api Lambda 都叫 `training-api-<STAGE>`。`STAGE` 預設 `prod`。

- 所有 Lambda 都不在 VPC 內（Aurora 有公開 endpoint；Lambda 要打 Strava / Claude）。
- 全部走同一個 API Gateway HTTP API（`make-it-api.life4like.com`）：`/plan`、`/activities*` 掛 Cognito JWT authorizer；`/strava/webhook`、`/strava/oauth/*` 不掛（Strava 來打的）。沒有 Function URL，所以 Lambda 重建 URL 也不變。
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
| `AUTO_REVIEW` | `true`（預設）：使用者把活動對應到課表後，worker 請 Claude 寫判定；`false` 關掉 |
| `STAGE` | 預設 `prod`，決定所有資源名稱的後綴 |
| `CORS_ORIGIN` | 逗號分隔，例如 `https://training.pages.dev,http://localhost:5173`；同時是 API CORS 和 Cognito 的 callback / logout URL |
| `COGNITO_DOMAIN_PREFIX` | hosted UI 網域前綴，預設 `training-api-prod-<account id>` |
| `API_DOMAIN` / `API_CERT_ARN` | 選填，兩個一起：API 自訂網域和它的 ACM 憑證（見 §3） |
| `APPLE_SERVICES_ID` / `APPLE_TEAM_ID` / `APPLE_KEY_ID` / `APPLE_PRIVATE_KEY` | 選填，四個都填才會在 Cognito 加 Sign in with Apple |
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

- `seed/plans.json` 一個使用者一筆，由 `python3 scripts/xlsx-to-plans.py` 產生，每次只替換指定使用者的那筆、其他人保留（需要 `openpyxl`）：
  - ww：`python3 scripts/xlsx-to-plans.py`（預設讀 `../running/富士山馬拉松_2026_課表.xlsx`）
  - gf：`python3 scripts/xlsx-to-plans.py ~/Downloads/Sara課表.xlsx --user gf --goal 5:30 --days 4`（`--goal`、`--days` 選填）
  課表改了就重跑這個再 `npm run seed`。
- 兩個 user 的 uuid、`display_name`、`email` 寫死在 `seed/seed.ts` 的 `USERS`。`email` 填 Apple ID 的 email（或 private relay 位址）：第一次 Apple 登入會用 email 對到這一列並記下 `apple_sub`，之後只認 `apple_sub`。沒對到的人登入會拿到 403（封閉系統）。
- 類型正規化表在 `scripts/xlsx-to-plans.py` 的 `TYPE_MAP`；遇到沒看過的類型會直接報錯列出來。

## 3. 部署

### 手動

```bash
npm run build        # tsc 型別檢查
npx cdk bootstrap    # 第一次
npx cdk deploy
```

Output：`ApiUrl`（自訂網域，沒設就是 execute-api）、`WebhookUrl` = `<ApiUrl>/strava/webhook`、`OauthStartUrl` = `<ApiUrl>/strava/oauth/start?user=<uuid>`、`ApiExecuteUrl`、`UserPoolId`、`UserPoolClientId`、`CognitoDomain`、`ApiDomainTarget`（有自訂網域時）。

### API 自訂網域（`make-it-api.life4like.com`）

憑證只做一次，之後 CDK 用 ARN 引用，deploy 不會卡在 DNS 驗證上：

```bash
# 1. 申請憑證（一定要 ap-northeast-1，HTTP API 是 regional）
aws acm request-certificate --region ap-northeast-1 --validation-method DNS \
  --domain-name make-it-api.life4like.com --query CertificateArn --output text
# 2. 拿驗證用的 CNAME，去 Cloudflare DNS 加（Proxy 關掉，DNS only）
aws acm describe-certificate --region ap-northeast-1 --certificate-arn <ARN> \
  --query 'Certificate.DomainValidationOptions[0].ResourceRecord'
# 3. 等 Status 變 ISSUED（通常幾分鐘）
aws acm describe-certificate --region ap-northeast-1 --certificate-arn <ARN> --query Certificate.Status
```

然後 `.env` 填 `API_DOMAIN` / `API_CERT_ARN`（GitHub 用 repository **variables** `API_DOMAIN`、`API_CERT_ARN`），deploy 後 output 會有 `ApiDomainTarget`，在 Cloudflare 加：

```
CNAME  make-it-api  →  <ApiDomainTarget>   （d-xxxx.execute-api.ap-northeast-1.amazonaws.com）
```

Proxy 開關都可以：DNS only 最單純；要開 Cloudflare proxy 的話 SSL/TLS 模式設 Full (strict)。

### 舊 stack

命名改成 `training-api-<thing>-prod` 之前的 stack 叫 `TrainingBackend`，資源名不衝突但要手動刪：

```bash
aws cloudformation delete-stack --stack-name TrainingBackend
```

刪掉後舊的 Function URL 失效：Strava callback domain 改成 `ApiUrl` 的 host，`npm run subscribe-webhook` 會自動把指到舊 URL 的 subscription 換掉。

### 自動（GitHub Actions，`.github/workflows/deploy.yml`）

- pull request：`npm ci` → `npm run build` → `cdk synth`（不碰 AWS）。
- push 到 `main`：同上，再用 OIDC 換 AWS role 跑 `cdk deploy --require-approval never`，最後印出 API / webhook / oauth 的 URL。
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
   | `APPLE_SERVICES_ID` / `APPLE_TEAM_ID` / `APPLE_KEY_ID` / `APPLE_PRIVATE_KEY` | 選填 |

   非 secret 的（`DB_HOST`、`CLAUDE_MODEL`、`AUTO_REVIEW`、`STAGE`）寫在 workflow 的 `env`；`CORS_ORIGIN`、`API_DOMAIN`、`API_CERT_ARN` 用 repository **variables**（不是 secret）。

## 4. Cognito 使用者

封閉系統，沒有自助註冊。deploy 完用 `UserPoolId` 建兩個使用者（email 要和 `seed/seed.ts` `USERS` 裡的一樣，api Lambda 第一次呼叫會靠 email 把 Cognito `sub` 連到 users 列）：

```bash
POOL=<UserPoolId>
aws cognito-idp admin-create-user --user-pool-id $POOL --username you@example.com \
  --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true --message-action SUPPRESS
aws cognito-idp admin-set-user-password --user-pool-id $POOL --username you@example.com --password '<密碼>' --permanent
```

前端登入兩種方式擇一：

- Hosted UI：`<CognitoDomain>/login?client_id=<UserPoolClientId>&response_type=code&scope=openid+email+profile&redirect_uri=<前端 origin>/`，拿 code 到 `<CognitoDomain>/oauth2/token` 換 token（PKCE）。
- SDK：`amazon-cognito-identity-js` 或 Amplify Auth，SRP 直接登入。

之後每個 api 請求帶 `Authorization: Bearer <ID token>`（要 **ID token**，不是 access token，因為第一次連結要 `email` claim）。API Gateway 驗簽失敗回 401；驗過但 users 表沒對到回 403。

Aurora 閒置 5 分鐘會 pause，之後第一個請求要等它醒（15〜30 秒），HTTP API 的上限是 30 秒，所以 api 在 20 秒放棄並回 **503 + `Retry-After: 8`**；前端收到 503 等幾秒重試一次即可。不想有這個等待就把 cluster 的 min ACU 調到 0.5（約每月 $43）。

## 5. Strava 設定

1. 到 https://www.strava.com/settings/api，把 **Authorization Callback Domain** 填 `ApiUrl` 的 host：自訂網域就是 `make-it-api.life4like.com`，還沒設的話是 `xxxx.execute-api.ap-northeast-1.amazonaws.com`。
2. 把 `WebhookUrl` 填進 `.env` 的 `WEBHOOK_URL`，然後：

   ```bash
   npm run subscribe-webhook
   # 或 npm run subscribe-webhook -- https://make-it-api.life4like.com/strava/webhook
   ```

   會先 GET 檢查有沒有既有 subscription，有就跳過；沒有才 POST。Strava 會在這時打 `WebhookUrl` 做 `hub.challenge` 驗證。

## 6. 授權流程

把 `OauthStartUrl`（`<ApiUrl>/strava/oauth/start?user=<uuid>`）傳給使用者點（uuid 從 `npm run seed` 的輸出拿）。流程：302 到 Strava → 同意 `activity:read_all` → `/callback` 用 code 換 token 寫進 `strava_connections` → 顯示「設定完成 ✓」。之後每次新活動 Strava 會推 webhook，worker 抓細節、配對課表、寫進 `activities`。

## API

型別在 `types/api.ts`。全部要帶 `Authorization: Bearer <Cognito ID token>`。

- `GET <ApiUrl>/me` → `MeResponse { user, strava, strava_connect_url }`：目前使用者（`users.id`、名字、email）、Strava 連結狀態（`null` 表示還沒連）、以及連結 Strava 要開的網址。前端的設定頁用這支。
- `DELETE <ApiUrl>/me/strava` → `{ ok: true }`：解除 Strava 連結。會先向 Strava 撤銷授權（失敗也照刪），再刪掉 `strava_connections` 那列；已匯入的 activities 保留。
- `GET <ApiUrl>/plan` → `PlanResponse { plan, weeks, sessions, activities, unassigned }`：active plan、每週階段/重點、未 superseded 的 sessions（含原始 `label`、`content`、`target` 原文、配速/心拍上下限、`week_no`、`phase`）、已對應的 activities、`unassigned`（最近 45 天還沒對應的活動，任何運動）（含 `review`、最高心拍、功率、卡路里、鞋、裝置、天氣、每公里分段）。
- `GET <ApiUrl>/activities?status=unplanned` → `ActivitiesResponse`（所有運動；不會自動配對，`unplanned` 是等使用者選的），`status` 可為 `auto | confirmed | unplanned | ignored`，省略則全部。
- `PUT <ApiUrl>/activities/{id}/review` body `PutReviewRequest { verdict, comment?, reminders?, rpe? }` → 手動判定，會覆蓋 Claude 的。
- `PUT <ApiUrl>/activities/{id}/memo` body `PutMemoRequest { memo, rpe? }` → 跑者自己的心得和 RPE（1〜10）。存完如果那筆的判定是 Claude 寫的，會刪掉重評，新的判定會參考這段自述；手動判定不動。
- `PUT <ApiUrl>/activities/{id}/session` body `PutSessionRequest { session_id, memo?, rpe?, replace?, status? }` → 使用者指定這筆活動是哪堂課（`confirmed`），可同時帶心得與 RPE。原本 `auto` 占著那個 session 的活動會退回 `unplanned`；`confirmed` 占著回 409（帶 `replace: true` 才換）。指定後舊的 Claude 判定刪掉、丟回 SQS 重評一次。`session_id: null` 配 `status: "ignored"` 表示這筆不算。

## 心得 vs 判定

- **跑者這邊**：`activities.memo` / `rpe`（app 裡寫，`PUT …/memo`），`activities.description`（Strava 上寫的，自動同步）。前端顯示 `memo ?? description`。
- **教練這邊**：`reviews`（Claude 或手動的 verdict / comment / reminders）。每筆活動的判定會把跑者自己寫的 RPE 和心得連同數據一起給 Claude，並要求評語直接回應自述；每週總結也會帶入該週每筆活動的自述。非跑步活動（重訓、Hyrox）對應到課表後也會被評，只是不看配速與距離。

## 判定（reviews）

- 來源兩種：`source = 'claude'`（worker 在 `AUTO_REVIEW=true` 且活動已被使用者對應到課表時寫，每筆 activity 只寫一次，不覆蓋既有）、`source = 'manual'`（`PUT …/review`，或 seed 從 xlsx V/L/W 欄帶入）。手動永遠贏。
- `verdict` 只有 `達成 / 達成但有提醒 / 未達成`；「跳過」是課表層級的狀態，前端用「過去的 session 沒有配對 activity」自己判斷。
- 天氣沒有自動來源：`activities.weather` 只在 seed 帶歷史值，之後為 null，前端沒值就不顯示。

## 配對（使用者自己選）

Strava 同步進來的活動（所有運動）一律存成 `unplanned`、`session_id = null`，**不會自動配對，也不會自動請 Claude 評**。

流程：前端今天頁列出 `/plan` 回的 `unassigned`（最近 45 天未對應的活動）→ 使用者點課表 → 選哪個活動是這堂課（一天多個活動也不會配錯）→ 填 RPE 與心得 → `PUT /activities/{id}/session`（`session_id` + `memo` + `rpe`）。這個請求把活動標成 `confirmed`、存心得、清掉舊的 Claude 判定並丟回 SQS，worker 只會請 Claude 評一次。

- 同一個 session 只能有一個活動。已 `confirmed` 的持有者要換掉得帶 `replace: true`，否則 409。
- `{ session_id: null, status: "ignored" }` 把活動排除在清單外；`{ session_id: null }` 退回 `unplanned`。
- 重跑 Strava update 事件不會動使用者的選擇。

## 週總結（`src/handlers/weekly.ts`）

每週日 21:00 JST 對每個 active plan 抓本週（一〜日）的課表和活動，加上接下來兩週的課表，請 Claude 回 `{ summary, adjustments[] }`，整包寫進 `weekly_reviews`。**第一版只記錄不套用 adjustments。** 要補跑某一週：在 Lambda console 用 `{"week_start": "2026-10-12"}`（週一）手動 invoke。

## 檔案

```
training-api/
├── infra/        CDK（bin/app.ts, lib/stack.ts）
├── src/
│   ├── handlers/ webhook / worker / oauth / weekly / api
│   ├── lib/      db（IAM token + pg Pool）、strava、claude
│   └── types.ts  內部 row / Strava 型別
├── types/        api.ts — API request/response 型別（前端直接複製用）
├── sql/          schema.sql
├── seed/         plans.json、seed.ts
└── scripts/      migrate.ts、backfill.ts、sql.ts（npm run sql -- "select …"）、subscribe-webhook.ts、xlsx-to-plans.py
```
