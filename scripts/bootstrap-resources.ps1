<#
.SYNOPSIS
  Creates the out-of-band resources the VAIO stack expects to already exist.

.DESCRIPTION
  Two things cannot live inside the stack:

  1. The Lambda code bucket. The merge Lambda bundle is ~52 MB (static ffmpeg
     plus moviepy), past the direct-upload limit, so the object must be staged in
     S3 before the function that references it is created.

  2. The Gemini API key. Committing it or putting it in a Lambda environment
     variable would expose it, so it lives in SSM Parameter Store as a
     SecureString and the handler reads it at cold start.

  Safe to re-run: existing resources are left alone unless -GeminiApiKey is
  supplied, which overwrites the parameter value.

.PARAMETER GeminiApiKey
  Gemini (Nano Banana Pro) API key. Omit to leave any existing value untouched.

.PARAMETER MergeBundleSource
  s3:// URI of an existing merge Lambda bundle to copy in. When omitted, the script
  looks for the predecessor project's bundle in the current account and, failing that,
  tells you how to supply one. Nothing about the source is hardcoded, so the script is
  safe to publish.

.PARAMETER Region
  Target region. Defaults to us-east-1.
#>
[CmdletBinding()]
param(
    [string]$GeminiApiKey,
    [string]$MergeBundleSource,
    [string]$Region = "us-east-1"
)

$ErrorActionPreference = "Stop"

$accountId = (aws sts get-caller-identity --query Account --output text)
if ($LASTEXITCODE -ne 0) {
    throw "Could not resolve the AWS account. Check your credentials."
}
$accountId = $accountId.Trim()

$codeBucket = "vaio-lambda-code-$accountId"
$geminiParam = "/vaio/gemini-api-key"

# -- 1. Lambda code bucket ------------------------------------------------
aws s3api head-bucket --bucket $codeBucket --region $Region 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "Code bucket already exists: $codeBucket" -ForegroundColor DarkGray
}
else {
    Write-Host "Creating code bucket $codeBucket" -ForegroundColor Cyan
    if ($Region -eq "us-east-1") {
        aws s3api create-bucket --bucket $codeBucket --region $Region | Out-Null
    }
    else {
        aws s3api create-bucket --bucket $codeBucket --region $Region `
            --create-bucket-configuration "LocationConstraint=$Region" | Out-Null
    }
    if ($LASTEXITCODE -ne 0) { throw "Failed to create bucket $codeBucket" }

    aws s3api put-public-access-block --bucket $codeBucket `
        --public-access-block-configuration "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true" | Out-Null
    aws s3api put-bucket-encryption --bucket $codeBucket `
        --server-side-encryption-configuration '{\"Rules\":[{\"ApplyServerSideEncryptionByDefault\":{\"SSEAlgorithm\":\"AES256\"}}]}' | Out-Null
    Write-Host "  Public access blocked, SSE-S3 enabled" -ForegroundColor DarkGray
}

# -- 2. Merge Lambda bundle -----------------------------------------------
# The bundle carries a static ffmpeg binary plus moviepy (~52 MB zipped), which is
# past Lambda's direct-upload limit, so it has to be staged in S3 before the function
# that references it can be created.
$mergeKey = "merge-lambda.zip"
aws s3api head-object --bucket $codeBucket --key $mergeKey --region $Region 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "Merge bundle already staged: s3://$codeBucket/$mergeKey" -ForegroundColor DarkGray
}
else {
    if (-not $MergeBundleSource) {
        # Derived from the resolved account rather than hardcoded, so no account id
        # appears in source. This is where the predecessor project kept its bundle.
        $candidate = "s3://rit-video-generator-code-$accountId/merge-lambda-v2.zip"
        aws s3api head-object --bucket "rit-video-generator-code-$accountId" `
            --key "merge-lambda-v2.zip" --region $Region 2>$null
        if ($LASTEXITCODE -eq 0) {
            $MergeBundleSource = $candidate
            Write-Host "Found an existing bundle to reuse: $candidate" -ForegroundColor DarkGray
        }
        else {
            throw @"
No merge Lambda bundle available.

Build one from cdk/lambda/merge (see its Dockerfile; it needs Linux wheels plus a
static ffmpeg binary) and upload it:

  aws s3 cp merge-lambda.zip s3://$codeBucket/$mergeKey --region $Region

Or point at an existing bundle:

  .\scripts\bootstrap-resources.ps1 -MergeBundleSource s3://your-bucket/your-bundle.zip
"@
        }
    }

    Write-Host "Copying merge bundle from $MergeBundleSource" -ForegroundColor Cyan
    aws s3 cp $MergeBundleSource "s3://$codeBucket/$mergeKey" --region $Region
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to copy the merge bundle from $MergeBundleSource"
    }
}

# -- 3. Gemini API key ----------------------------------------------------
if ($GeminiApiKey) {
    Write-Host "Writing SecureString $geminiParam" -ForegroundColor Cyan
    aws ssm put-parameter `
        --name $geminiParam `
        --value $GeminiApiKey `
        --type SecureString `
        --description "Gemini (Nano Banana Pro) API key used by the VAIO API Lambda" `
        --overwrite `
        --region $Region | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Failed to write $geminiParam" }
    Write-Host "  Stored (value not echoed)" -ForegroundColor DarkGray
}
else {
    aws ssm get-parameter --name $geminiParam --region $Region 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Gemini key parameter already present: $geminiParam" -ForegroundColor DarkGray
    }
    else {
        Write-Warning "$geminiParam does not exist. Image generation will fail until you run:"
        Write-Warning "  .\scripts\bootstrap-resources.ps1 -GeminiApiKey '<key>'"
    }
}

Write-Host ""
Write-Host "Bootstrap complete." -ForegroundColor Green
Write-Host "  Account:     $accountId"
Write-Host "  Region:      $Region"
Write-Host "  Code bucket: $codeBucket"
Write-Host "  Gemini key:  $geminiParam"
