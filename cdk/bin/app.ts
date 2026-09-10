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

// Cognito self-registration is OFF by default. The console sits behind a public
// CloudFront URL, so open registration would let anyone within the geo-restriction
// create an account and spend Bedrock inference. Operators add users with
// scripts/create-user.ps1.
//
// Opening it up is deliberate and explicit:
//   cdk deploy -c allowSelfSignUp=true
// Only do that behind a further control, such as a pre-sign-up Lambda trigger that
// restricts registration to an allowed email domain.
const allowSelfSignUp = app.node.tryGetContext("allowSelfSignUp") === "true";

const stack = new VaioStack(app, "VaioStack", {
  env: { account, region },
  allowSelfSignUp,
  description:
    "Video AI Orchestrator (VAIO) — bilingual (EN/FR) storyboard and video generation studio",
});

cdk.Tags.of(stack).add("Project", "vaio");
cdk.Tags.of(stack).add("Environment", "dev");
cdk.Tags.of(stack).add("ManagedBy", "cdk");
