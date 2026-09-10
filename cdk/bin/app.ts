#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { VaioStack } from "../lib/vaio-stack";

const app = new cdk.App();

// Account and region are overridable from the CDK CLI context so the stack can
// be deployed into another account without editing source:
//   cdk deploy -c account=111122223333 -c region=us-east-1
const account = app.node.tryGetContext("account") ?? process.env.CDK_DEFAULT_ACCOUNT ?? "493512621622";

// us-east-1 is required, not just conventional: Nova Sonic bidirectional
// streaming, Nova Canvas, and the `us.anthropic.*` Claude inference profiles
// this app depends on are not all available in ca-central-1.
const region = app.node.tryGetContext("region") ?? "us-east-1";

const stack = new VaioStack(app, "VaioStack", {
  env: { account, region },
  description:
    "Video AI Orchestrator (VAIO) — bilingual (EN/FR) storyboard and video generation studio",
});

cdk.Tags.of(stack).add("Project", "vaio");
cdk.Tags.of(stack).add("Environment", "dev");
cdk.Tags.of(stack).add("ManagedBy", "cdk");
