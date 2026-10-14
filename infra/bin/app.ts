#!/usr/bin/env node
import path from "node:path";
import * as cdk from "aws-cdk-lib";
import dotenv from "dotenv";
import { TrainingApiStack } from "../lib/stack";

// .env is read only at synth time; values end up as plain Lambda env vars.
dotenv.config({ path: path.join(__dirname, "..", "..", ".env"), quiet: true });

const app = new cdk.App();
const stage = process.env.STAGE ?? "prod";

new TrainingApiStack(app, `training-api-${stage}`, {
  stage,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.AWS_REGION ?? "ap-northeast-1",
  },
});
