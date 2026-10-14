import path from "node:path";
import * as cdk from "aws-cdk-lib";
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

export class TrainingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ---- config (from .env via dotenv in bin/app.ts, or cdk context) --------
    const dbClusterResourceId =
      (this.node.tryGetContext("dbClusterResourceId") as string | undefined) ?? required("DB_CLUSTER_RESOURCE_ID");
    const dbEnv = {
      DB_HOST: required("DB_HOST"),
      DB_PORT: process.env.DB_PORT ?? "5432",
      DB_NAME: process.env.DB_NAME ?? "postgres",
      DB_USER: process.env.DB_USER ?? "postgres",
    };
    const stravaEnv = {
      STRAVA_CLIENT_ID: required("STRAVA_CLIENT_ID"),
      STRAVA_CLIENT_SECRET: required("STRAVA_CLIENT_SECRET"),
    };
    const corsOrigin = process.env.CORS_ORIGIN ?? "https://iamwuwei.github.io";

    // IAM auth: rds-db:connect on the cluster's resource id / db user.
    const rdsConnect = new iam.PolicyStatement({
      actions: ["rds-db:connect"],
      resources: [`arn:aws:rds-db:${this.region}:${this.account}:dbuser:${dbClusterResourceId}/${dbEnv.DB_USER}`],
    });

    // ---- queue ----------------------------------------------------------------
    const dlq = new sqs.Queue(this, "ActivitiesDlq", {
      queueName: "activities-dlq",
      retentionPeriod: cdk.Duration.days(14),
    });
    const queue = new sqs.Queue(this, "ActivitiesQueue", {
      queueName: "activities",
      visibilityTimeout: cdk.Duration.seconds(90),
      retentionPeriod: cdk.Duration.days(4),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
    });

    // ---- lambdas --------------------------------------------------------------
    const fn = (name: string, extra: Partial<NodejsFunctionProps> = {}) =>
      new NodejsFunction(this, `${name[0].toUpperCase()}${name.slice(1)}Fn`, {
        functionName: `training-${name}`,
        entry: path.join(ROOT, "src", "handlers", `${name}.ts`),
        handler: "handler",
        projectRoot: ROOT,
        depsLockFilePath: path.join(ROOT, "package-lock.json"),
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 512,
        timeout: cdk.Duration.seconds(60),
        logGroup: new logs.LogGroup(this, `${name}Logs`, {
          logGroupName: `/aws/lambda/training-${name}`,
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
            // db.ts reads global-bundle.pem next to the bundled handler.
            afterBundling: (inputDir, outputDir) => [
              `cp "${path.join(inputDir, "src", "lib", "global-bundle.pem")}" "${outputDir}/"`,
            ],
          },
        },
        ...extra,
        environment: { ...dbEnv, ...(extra.environment ?? {}) },
      });

    const webhook = fn("webhook", {
      environment: {
        STRAVA_VERIFY_TOKEN: required("STRAVA_VERIFY_TOKEN"),
        QUEUE_URL: queue.queueUrl,
      },
    });
    queue.grantSendMessages(webhook);

    const worker = fn("worker", {
      timeout: cdk.Duration.seconds(90),
      environment: stravaEnv,
      reservedConcurrentExecutions: 2,
    });
    worker.addToRolePolicy(rdsConnect);
    worker.addEventSource(new SqsEventSource(queue, { batchSize: 1 }));

    const oauth = fn("oauth", { environment: stravaEnv });
    oauth.addToRolePolicy(rdsConnect);

    const weekly = fn("weekly", {
      environment: {
        ANTHROPIC_API_KEY: required("ANTHROPIC_API_KEY"),
        CLAUDE_MODEL: process.env.CLAUDE_MODEL ?? "claude-haiku-4-5",
      },
    });
    weekly.addToRolePolicy(rdsConnect);

    const api = fn("api");
    api.addToRolePolicy(rdsConnect);

    // ---- schedule: every Sunday 21:00 Asia/Tokyo -----------------------------
    new scheduler.Schedule(this, "WeeklyReviewSchedule", {
      scheduleName: "training-weekly-review",
      schedule: scheduler.ScheduleExpression.cron({
        minute: "0",
        hour: "21",
        weekDay: "SUN",
        timeZone: cdk.TimeZone.ASIA_TOKYO,
      }),
      target: new LambdaInvoke(weekly, { input: scheduler.ScheduleTargetInput.fromObject({}) }),
    });

    // ---- function URLs ---------------------------------------------------------
    const webhookUrl = webhook.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });
    const oauthUrl = oauth.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });
    const apiUrl = api.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: [corsOrigin],
        allowedMethods: [lambda.HttpMethod.GET],
        allowedHeaders: ["content-type"],
        maxAge: cdk.Duration.hours(1),
      },
    });

    new cdk.CfnOutput(this, "WebhookUrl", { value: webhookUrl.url });
    new cdk.CfnOutput(this, "OauthUrl", { value: oauthUrl.url });
    new cdk.CfnOutput(this, "ApiUrl", { value: apiUrl.url });
    new cdk.CfnOutput(this, "ActivitiesQueueUrl", { value: queue.queueUrl });
  }
}
