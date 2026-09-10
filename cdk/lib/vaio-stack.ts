import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import * as path from "path";

/** Physical resource name prefix. Kebab-case per the workspace CDK standard. */
const PREFIX = "vaio";

/**
 * SSM parameter holding the Gemini (Nano Banana Pro) API key.
 *
 * Created out of band as a SecureString — see scripts/put-gemini-key.ps1. The
 * key is never committed or placed in a Lambda environment variable; the API
 * handler reads it at cold start.
 */
const GEMINI_KEY_PARAM = `/${PREFIX}/gemini-api-key`;

/** Object key of the pre-built merge Lambda bundle (ffmpeg + moviepy, ~52 MB). */
const MERGE_BUNDLE_KEY = "merge-lambda.zip";

export interface VaioStackProps extends cdk.StackProps {
  /**
   * Allow visitors to create their own accounts.
   *
   * Defaults to false, and should stay false. The console is served from a public
   * CloudFront URL, so self-registration would let anyone inside the geo-restriction
   * create an account and start spending Bedrock inference on generation runs.
   *
   * With this off, the pool is admin-create-only: operators add users with
   * scripts/create-user.ps1. Invited users land in FORCE_CHANGE_PASSWORD and set
   * their own password on first sign-in through the existing challenge flow.
   *
   * Only enable it behind an additional control such as a pre-sign-up Lambda trigger
   * that restricts registration to an allowed email domain.
   */
  readonly allowSelfSignUp?: boolean;
}

export class VaioStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: VaioStackProps) {
    super(scope, id, props);

    // Closed by default: opening registration has to be a deliberate act.
    const allowSelfSignUp = props?.allowSelfSignUp ?? false;

    // ─────────────────────────────────────────────────────────
    // 1. S3 BUCKETS
    // ─────────────────────────────────────────────────────────

    const websiteBucket = new s3.Bucket(this, "WebsiteBucket", {
      bucketName: `${PREFIX}-frontend-${this.account}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
    });

    const assetsBucket = new s3.Bucket(this, "AssetsBucket", {
      bucketName: `${PREFIX}-assets-${this.account}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      cors: [
        {
          // Browsers PUT directly to presigned URLs for music, wallpaper, and
          // video uploads, so the bucket needs permissive CORS.
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.POST],
          allowedOrigins: ["*"],
          allowedHeaders: ["*"],
          maxAge: 3600,
        },
      ],
      lifecycleRules: [
        { id: "CleanupTempFiles", prefix: "tmp/", expiration: cdk.Duration.days(1) },
        { id: "CleanupTranscriptions", prefix: "transcriptions/", expiration: cdk.Duration.days(7) },
      ],
    });

    // ─────────────────────────────────────────────────────────
    // 2. COGNITO
    // ─────────────────────────────────────────────────────────

    const userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: `${PREFIX}-users`,
      // false sets AdminCreateUserConfig.AllowAdminCreateUserOnly, so the public
      // SignUp API is rejected and accounts can only be created by an operator.
      selfSignUpEnabled: allowSelfSignUp,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const userPoolClient = userPool.addClient("WebClient", {
      userPoolClientName: `${PREFIX}-web`,
      authFlows: { userPassword: true, userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true, implicitCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: ["https://localhost/callback"],
        logoutUrls: ["https://localhost/"],
      },
      preventUserExistenceErrors: true,
    });

    const userPoolDomain = userPool.addDomain("Domain", {
      cognitoDomain: { domainPrefix: `${PREFIX}-${this.account}` },
    });

    // ─────────────────────────────────────────────────────────
    // 3. IAM ROLE (shared by both Lambdas)
    // ─────────────────────────────────────────────────────────

    // The ARN is built by hand rather than imported with
    // ssm.StringParameter.fromStringParameterName, because that produces a
    // CloudFormation parameter reference and CloudFormation rejects SecureString
    // types. Nothing needs the value at deploy time (the handler reads it at runtime
    // through the SSM API), so only the IAM grant matters here.
    const geminiKeyArn = cdk.Stack.of(this).formatArn({
      service: "ssm",
      resource: "parameter",
      resourceName: GEMINI_KEY_PARAM.replace(/^\//, ""),
      arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
    });

    const lambdaRole = new iam.Role(this, "LambdaRole", {
      roleName: `${PREFIX}-lambda-role`,
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
      ],
      inlinePolicies: {
        AppPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              // Bedrock model access. Resource is "*" because the app fans out
              // across foundation models, cross-region inference profiles, and
              // async invocation ARNs in more than one region.
              actions: [
                "bedrock:InvokeModel",
                "bedrock:InvokeModelWithResponseStream",
                // Required by Nova Sonic text-to-speech.
                "bedrock:InvokeModelWithBidirectionalStream",
                "bedrock:Converse",
                "bedrock:ConverseStream",
                "bedrock:StartAsyncInvoke",
                "bedrock:GetAsyncInvoke",
                "bedrock:ListAsyncInvokes",
              ],
              resources: ["*"],
            }),
            new iam.PolicyStatement({
              actions: ["polly:SynthesizeSpeech"],
              resources: ["*"],
            }),
            new iam.PolicyStatement({
              // Transcribe job names are generated per request, so they cannot
              // be scoped to a fixed ARN.
              actions: [
                "transcribe:StartTranscriptionJob",
                "transcribe:GetTranscriptionJob",
                "transcribe:DeleteTranscriptionJob",
              ],
              resources: ["*"],
            }),
            new iam.PolicyStatement({
              actions: ["sagemaker:InvokeEndpoint"],
              resources: [
                `arn:aws:sagemaker:${this.region}:${this.account}:endpoint/${PREFIX}-sdxl-ip-adapter`,
                // The legacy endpoint is still the one that exists in-account.
                `arn:aws:sagemaker:${this.region}:${this.account}:endpoint/rit-sdxl-ip-adapter`,
              ],
            }),
            new iam.PolicyStatement({
              // The API Lambda self-invokes for long-running work and invokes
              // the merge Lambda for video assembly.
              actions: ["lambda:InvokeFunction"],
              resources: [
                `arn:aws:lambda:${this.region}:${this.account}:function:${PREFIX}-merge`,
                `arn:aws:lambda:${this.region}:${this.account}:function:${PREFIX}-api`,
              ],
            }),
            new iam.PolicyStatement({
              // Read the Gemini API key at runtime. Decryption uses the AWS-managed
              // alias/aws/ssm key, whose key policy already allows use by this
              // account through SSM, so no separate kms:Decrypt grant is required.
              actions: ["ssm:GetParameter"],
              resources: [geminiKeyArn],
            }),
          ],
        }),
      },
    });

    assetsBucket.grantReadWrite(lambdaRole);

    // ─────────────────────────────────────────────────────────
    // 4. MERGE LAMBDA
    // ─────────────────────────────────────────────────────────
    // The bundle carries a static ffmpeg binary and moviepy (~52 MB zipped),
    // which exceeds the direct-upload limit, so it is staged in S3 first by
    // scripts/upload-merge-bundle.ps1.

    const codeBucket = s3.Bucket.fromBucketName(
      this,
      "LambdaCodeBucket",
      `${PREFIX}-lambda-code-${this.account}`
    );

    const mergeHandler = new lambda.Function(this, "MergeHandler", {
      functionName: `${PREFIX}-merge`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "handler.handler",
      code: lambda.Code.fromBucket(codeBucket, MERGE_BUNDLE_KEY),
      memorySize: 10240,
      timeout: cdk.Duration.minutes(15),
      ephemeralStorageSize: cdk.Size.gibibytes(10),
      role: lambdaRole,
      environment: { ASSETS_BUCKET: assetsBucket.bucketName },
      logRetention: logs.RetentionDays.TWO_WEEKS,
    });

    // ─────────────────────────────────────────────────────────
    // 5. API LAMBDA
    // ─────────────────────────────────────────────────────────

    const apiHandler = new lambda.Function(this, "ApiHandler", {
      functionName: `${PREFIX}-api`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "handler.handler",
      // Built by scripts/build-api-lambda.ps1 — handler source plus
      // manylinux-targeted dependencies.
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "lambda", "api-build")),
      memorySize: 1024,
      timeout: cdk.Duration.minutes(15),
      role: lambdaRole,
      environment: {
        ASSETS_BUCKET: assetsBucket.bucketName,
        // Opus 5 handles the bilingual generation work (storyboards, narration,
        // character bibles) in both English and French.
        CLAUDE_MODEL_ID: "us.anthropic.claude-opus-5",
        // Sonnet 5 covers the short mechanical calls — prompt translation and
        // style condensation — at lower latency and cost.
        CLAUDE_FAST_MODEL_ID: "us.anthropic.claude-sonnet-5",
        CLAUDE_REGION: "us-east-1",
        SD35_REGION: "us-west-2",
        GEMINI_KEY_PARAM,
        SAGEMAKER_ENDPOINT: "rit-sdxl-ip-adapter",
        MERGE_FUNCTION_NAME: mergeHandler.functionName,
        DEFAULT_LANGUAGE: "en",
        POWERTOOLS_SERVICE_NAME: `${PREFIX}-api`,
      },
      logRetention: logs.RetentionDays.TWO_WEEKS,
    });

    // ─────────────────────────────────────────────────────────
    // 6. API GATEWAY — proxy+ catch-all routing
    // ─────────────────────────────────────────────────────────

    const api = new apigateway.RestApi(this, "Api", {
      restApiName: `${PREFIX}-api`,
      description: "Backend API for Video AI Orchestrator (VAIO)",
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ["Content-Type", "Authorization", "X-Amz-Date", "X-Api-Key"],
      },
      binaryMediaTypes: [
        "audio/*",
        "video/*",
        "image/*",
        "application/octet-stream",
        "multipart/form-data",
      ],
      deployOptions: { stageName: "prod", throttlingRateLimit: 50, throttlingBurstLimit: 100 },
    });

    const cognitoAuth = new apigateway.CognitoUserPoolsAuthorizer(this, "CognitoAuth", {
      cognitoUserPools: [userPool],
    });

    const lambdaIntegration = new apigateway.LambdaIntegration(apiHandler, { proxy: true });

    const authOpts: apigateway.MethodOptions = {
      authorizer: cognitoAuth,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    };

    // /health — intentionally unauthenticated so deployments can be smoke
    // tested. It returns only service name, status, and timestamp.
    api.root.addResource("health").addMethod("GET", lambdaIntegration);

    // /api/{proxy+} — every application route, all Cognito-protected.
    const apiResource = api.root.addResource("api");
    apiResource.addProxy({
      defaultIntegration: lambdaIntegration,
      defaultMethodOptions: authOpts,
      anyMethod: true,
    });

    // ─────────────────────────────────────────────────────────
    // 7. CLOUDFRONT (frontend only)
    // ─────────────────────────────────────────────────────────

    const oac = new cloudfront.S3OriginAccessControl(this, "OAC", {
      originAccessControlName: `${PREFIX}-oac`,
    });

    const distribution = new cloudfront.Distribution(this, "CDN", {
      comment: "Video AI Orchestrator (VAIO)",
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(websiteBucket, {
          originAccessControl: oac,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      },
      defaultRootObject: "index.html",
      geoRestriction: cloudfront.GeoRestriction.allowlist("CA"),
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: cdk.Duration.seconds(0),
        },
      ],
    });

    // ─────────────────────────────────────────────────────────
    // 8. DEPLOY FRONTEND
    // ─────────────────────────────────────────────────────────

    new s3deploy.BucketDeployment(this, "DeployWebsite", {
      sources: [s3deploy.Source.asset(path.join(__dirname, "..", "..", "web-ui-dist"))],
      destinationBucket: websiteBucket,
      distribution,
      distributionPaths: ["/*"],
    });

    // ─────────────────────────────────────────────────────────
    // 9. OUTPUTS
    // ─────────────────────────────────────────────────────────

    new cdk.CfnOutput(this, "CloudFrontURL", {
      value: `https://${distribution.distributionDomainName}`,
    });
    new cdk.CfnOutput(this, "ApiGatewayURL", { value: api.url });
    new cdk.CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new cdk.CfnOutput(this, "UserPoolClientId", { value: userPoolClient.userPoolClientId });
    // The frontend reads this via generated config.js so the sign-in screen always
    // matches what the pool actually permits, instead of offering a Sign up link
    // that Cognito would reject.
    new cdk.CfnOutput(this, "SelfSignUpEnabled", {
      value: String(allowSelfSignUp),
      description: "Whether visitors can register their own accounts",
    });
    new cdk.CfnOutput(this, "CognitoDomain", {
      value: `${userPoolDomain.domainName}.auth.${this.region}.amazoncognito.com`,
    });
    new cdk.CfnOutput(this, "AssetsBucketName", { value: assetsBucket.bucketName });
    new cdk.CfnOutput(this, "WebsiteBucketName", { value: websiteBucket.bucketName });
    new cdk.CfnOutput(this, "ApiFunctionArn", { value: apiHandler.functionArn });
    new cdk.CfnOutput(this, "MergeFunctionArn", { value: mergeHandler.functionArn });
  }
}
