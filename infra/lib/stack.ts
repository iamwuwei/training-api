import path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpUserPoolAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction, OutputFormat, type NodejsFunctionProps } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import { LambdaInvoke } from "aws-cdk-lib/aws-scheduler-targets";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

const ROOT = path.join(__dirname, "..", "..");

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} — add it to .env (see .env.example)`);
  return v;
}

export interface TrainingApiStackProps extends cdk.StackProps {
  stage: string; // "prod" → every resource is named training-api-<thing>-prod
}

export class TrainingApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: TrainingApiStackProps) {
    super(scope, id, props);
    const { stage } = props;
    const name = (thing?: string) => (thing ? `training-api-${thing}-${stage}` : `training-api-${stage}`);

    // ---- config (from .env via dotenv in bin/app.ts, or cdk context) --------
    // Database: DATABASE_URL (Supabase pooler URL, a secret) or Aurora with IAM auth.
    const databaseUrl = process.env.DATABASE_URL;
    const dbEnv: Record<string, string> = databaseUrl
      ? { DATABASE_URL: databaseUrl }
      : {
          DB_HOST: required("DB_HOST"),
          DB_PORT: process.env.DB_PORT ?? "5432",
          DB_NAME: process.env.DB_NAME ?? "postgres",
          DB_USER: process.env.DB_USER ?? "postgres",
        };
    const dbClusterResourceId = databaseUrl
      ? undefined
      : (this.node.tryGetContext("dbClusterResourceId") as string | undefined) ?? required("DB_CLUSTER_RESOURCE_ID");
    const stravaEnv = {
      STRAVA_CLIENT_ID: required("STRAVA_CLIENT_ID"),
      STRAVA_CLIENT_SECRET: required("STRAVA_CLIENT_SECRET"),
    };
    const claudeEnv = {
      ANTHROPIC_API_KEY: required("ANTHROPIC_API_KEY"),
      CLAUDE_MODEL: process.env.CLAUDE_MODEL ?? "claude-sonnet-5-5",
      CLAUDE_MODEL_WEEKLY: process.env.CLAUDE_MODEL_WEEKLY ?? "claude-sonnet-5-5",
      CLAUDE_MODEL_COACH: process.env.CLAUDE_MODEL_COACH ?? "claude-sonnet-5-5",
    };
    // Comma-separated front-end origins, e.g. "https://training.pages.dev,http://localhost:5173"
    const corsOrigins = (process.env.CORS_ORIGIN ?? "https://iamwuwei.github.io")
      .split(",").map((s) => s.trim()).filter(Boolean);

    // Aurora only: IAM auth needs rds-db:connect on the cluster's resource id / db user.
    const rdsConnect = dbClusterResourceId
      ? new iam.PolicyStatement({
          actions: ["rds-db:connect"],
          resources: [`arn:aws:rds-db:${this.region}:${this.account}:dbuser:${dbClusterResourceId}/${dbEnv.DB_USER}`],
        })
      : undefined;
    const grantDb = (fn: lambda.Function) => { if (rdsConnect) fn.addToRolePolicy(rdsConnect); };

    // ---- queue ----------------------------------------------------------------
    const dlq = new sqs.Queue(this, "ActivitiesDlq", {
      queueName: name("activities-dlq"),
      retentionPeriod: cdk.Duration.days(14),
    });
    const queue = new sqs.Queue(this, "ActivitiesQueue", {
      queueName: name("activities"),
      visibilityTimeout: cdk.Duration.seconds(90),
      retentionPeriod: cdk.Duration.days(4),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
    });

    // ---- lambdas --------------------------------------------------------------
    const fn = (handler: string, extra: Partial<NodejsFunctionProps> = {}) => {
      const functionName = extra.functionName ?? name(handler);
      return new NodejsFunction(this, `${handler[0].toUpperCase()}${handler.slice(1)}Fn`, {
        functionName,
        entry: path.join(ROOT, "src", "handlers", `${handler}.ts`),
        handler: "handler",
        projectRoot: ROOT,
        depsLockFilePath: path.join(ROOT, "package-lock.json"),
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 512,
        timeout: cdk.Duration.seconds(60),
        logGroup: new logs.LogGroup(this, `${handler}Logs`, {
          logGroupName: `/aws/lambda/${functionName}`,
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        bundling: {
          target: "node22",
          format: OutputFormat.CJS, // db.ts relies on __dirname
          bundleAwsSDK: true, // pin our @aws-sdk versions instead of the runtime's
          sourceMap: false,
          minify: false,
          commandHooks: {
            beforeBundling: () => [],
            beforeInstall: () => [],
            // db.ts reads the CA bundles (global-bundle.pem for Aurora,
            // supabase-ca.pem for Supabase) next to the bundled handler.
            afterBundling: (inputDir, outputDir) => [
              `cp "${path.join(inputDir, "src", "lib")}"/*.pem "${outputDir}/"`,
            ],
          },
        },
        ...extra,
        environment: { STAGE: stage, ...dbEnv, ...(extra.environment ?? {}) },
      });
    };

    const webhook = fn("webhook", {
      environment: {
        STRAVA_VERIFY_TOKEN: required("STRAVA_VERIFY_TOKEN"),
        QUEUE_URL: queue.queueUrl,
      },
    });
    queue.grantSendMessages(webhook);

    const worker = fn("worker", {
      timeout: cdk.Duration.seconds(90),
      environment: { ...stravaEnv, ...claudeEnv, AUTO_REVIEW: process.env.AUTO_REVIEW ?? "true" },
      reservedConcurrentExecutions: 2,
    });
    grantDb(worker);
    worker.addEventSource(new SqsEventSource(queue, { batchSize: 1 }));

    const oauth = fn("oauth", { environment: stravaEnv });
    grantDb(oauth);

    const weekly = fn("weekly", { environment: claudeEnv });
    grantDb(weekly);

    // training-api-prod, same name as the HTTP API. HTTP API cuts requests at
    // 30 s, so give up on a cold Aurora at 20 s and answer 503 instead.
    const api = fn("api", {
      functionName: name(),
      environment: {
        DB_CONNECT_TIMEOUT_MS: "20000", DB_DEBUG: process.env.DB_DEBUG ?? "false", QUEUE_URL: queue.queueUrl,
        COACH_DAILY_LIMIT: process.env.COACH_DAILY_LIMIT ?? "0", // 0 = no cap (two known athletes)
      },
    });
    grantDb(api);
    queue.grantSendMessages(api); // re-review after a manual session assignment

    // ---- schedule: every Sunday 21:00 Asia/Tokyo -----------------------------
    new scheduler.Schedule(this, "WeeklyReviewSchedule", {
      scheduleName: name("weekly-review"),
      schedule: scheduler.ScheduleExpression.cron({
        minute: "0",
        hour: "21",
        weekDay: "SUN",
        timeZone: cdk.TimeZone.ASIA_TOKYO,
      }),
      target: new LambdaInvoke(weekly, { input: scheduler.ScheduleTargetInput.fromObject({}) }),
    });

    // ---- Cognito: closed user pool (admin creates the two users) -------------
    const userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: name("users"),
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      passwordPolicy: { minLength: 10, requireSymbols: false, requireUppercase: false, requireDigits: false },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Optional Sign in with Apple federation: set all four APPLE_* vars to enable.
    const apple = process.env.APPLE_SERVICES_ID && process.env.APPLE_TEAM_ID && process.env.APPLE_KEY_ID && process.env.APPLE_PRIVATE_KEY
      ? new cognito.UserPoolIdentityProviderApple(this, "Apple", {
          userPool,
          clientId: process.env.APPLE_SERVICES_ID,
          teamId: process.env.APPLE_TEAM_ID,
          keyId: process.env.APPLE_KEY_ID,
          privateKey: process.env.APPLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
          scopes: ["email", "name"],
          attributeMapping: { email: cognito.ProviderAttribute.APPLE_EMAIL },
        })
      : undefined;

    const webClient = userPool.addClient("WebClient", {
      userPoolClientName: name("web"),
      generateSecret: false, // public SPA client
      authFlows: { userSrp: true },
      preventUserExistenceErrors: true,
      supportedIdentityProviders: [
        cognito.UserPoolClientIdentityProvider.COGNITO,
        ...(apple ? [cognito.UserPoolClientIdentityProvider.APPLE] : []),
      ],
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: corsOrigins.map((o) => `${o}/`),
        logoutUrls: corsOrigins.map((o) => `${o}/`),
      },
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
    });
    if (apple) webClient.node.addDependency(apple);

    const domain = userPool.addDomain("Domain", {
      cognitoDomain: { domainPrefix: process.env.COGNITO_DOMAIN_PREFIX ?? `${name()}-${this.account}` },
    });

    // ---- HTTP API in front of the api Lambda, JWT (Cognito ID token) required ----
    const httpApi = new apigw.HttpApi(this, "HttpApi", {
      apiName: name(),
      corsPreflight: {
        allowOrigins: corsOrigins,
        allowMethods: [apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.POST, apigw.CorsHttpMethod.PUT, apigw.CorsHttpMethod.DELETE, apigw.CorsHttpMethod.OPTIONS],
        allowHeaders: ["content-type", "authorization"],
        maxAge: cdk.Duration.hours(1),
      },
    });
    const authorizer = new HttpUserPoolAuthorizer("CognitoJwt", userPool, { userPoolClients: [webClient] });
    const integration = new HttpLambdaIntegration("ApiIntegration", api);
    for (const [p, methods] of [
      ["/me", [apigw.HttpMethod.GET]],
      ["/me/strava", [apigw.HttpMethod.DELETE]],
      ["/plan", [apigw.HttpMethod.GET]],
      ["/activities", [apigw.HttpMethod.GET]],
      ["/activities/{id}/review", [apigw.HttpMethod.PUT]],
      ["/activities/{id}/session", [apigw.HttpMethod.PUT]],
      ["/activities/{id}/memo", [apigw.HttpMethod.PUT]],
      ["/activities/{id}/rereview", [apigw.HttpMethod.POST]],
      ["/weekly", [apigw.HttpMethod.GET]],
      ["/weekly/{id}/adjustments/{index}", [apigw.HttpMethod.POST]],
      ["/coach", [apigw.HttpMethod.GET]],
      ["/coach/seen", [apigw.HttpMethod.PUT]],
      ["/coach/messages", [apigw.HttpMethod.POST]],
    ] as const) {
      httpApi.addRoutes({ path: p, methods: [...methods], integration, authorizer });
    }

    // Strava-facing routes on the same API, no authorizer (Strava calls them):
    // the URL then follows the API / custom domain, not the Lambda.
    httpApi.addRoutes({
      path: "/strava/webhook",
      methods: [apigw.HttpMethod.GET, apigw.HttpMethod.POST],
      integration: new HttpLambdaIntegration("WebhookIntegration", webhook),
    });
    httpApi.addRoutes({
      path: "/strava/oauth/{proxy+}",
      methods: [apigw.HttpMethod.GET],
      integration: new HttpLambdaIntegration("OauthIntegration", oauth),
    });

    // ---- custom domain (optional): API_DOMAIN + API_CERT_ARN -------------------
    // The ACM cert (ap-northeast-1, DNS-validated) is created once by hand so a
    // deploy never blocks on DNS validation; see README. DNS lives outside AWS:
    // CNAME API_DOMAIN -> the ApiDomainTarget output.
    const apiDomain = process.env.API_DOMAIN;
    let customApiUrl: string | undefined;
    if (apiDomain) {
      const domainName = new apigw.DomainName(this, "ApiDomain", {
        domainName: apiDomain,
        certificate: acm.Certificate.fromCertificateArn(this, "ApiCert", required("API_CERT_ARN")),
      });
      new apigw.ApiMapping(this, "ApiMapping", { api: httpApi, domainName });
      customApiUrl = `https://${apiDomain}`;
      new cdk.CfnOutput(this, "ApiDomainTarget", {
        value: domainName.regionalDomainName,
        description: `CNAME target for ${apiDomain}`,
      });
    }

    const baseUrl = customApiUrl ?? httpApi.apiEndpoint;
    new cdk.CfnOutput(this, "ApiUrl", { value: baseUrl });
    new cdk.CfnOutput(this, "WebhookUrl", { value: `${baseUrl}/strava/webhook` });
    new cdk.CfnOutput(this, "OauthStartUrl", { value: `${baseUrl}/strava/oauth/start?user=<uuid>` });
    new cdk.CfnOutput(this, "ApiExecuteUrl", { value: httpApi.apiEndpoint });
    new cdk.CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new cdk.CfnOutput(this, "UserPoolClientId", { value: webClient.userPoolClientId });
    new cdk.CfnOutput(this, "CognitoDomain", { value: domain.baseUrl() });
    new cdk.CfnOutput(this, "ActivitiesQueueUrl", { value: queue.queueUrl });
  }
}
