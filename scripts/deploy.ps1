<#
.SYNOPSIS
  Full deploy: build both bundles, deploy the stack, then rewrite the frontend
  config from the resulting stack outputs.

.DESCRIPTION
  Runs in three phases because the frontend needs values that only exist after
  the stack is created:

    1. Build the API Lambda bundle and a config-less frontend bundle.
    2. cdk deploy.
    3. Regenerate config.js from the stack outputs and re-upload the frontend.

  On the very first deploy there are no outputs yet, hence the placeholder
  config in phase 1 and the second frontend pass in phase 3.

.PARAMETER SkipDeps
  Reuse already-installed Lambda dependencies (faster handler-only iteration).

.PARAMETER Region
  Target region. Defaults to us-east-1.
#>
[CmdletBinding()]
param(
    [switch]$SkipDeps,
    [string]$Region = "us-east-1"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$cdkDir = Join-Path $repoRoot "cdk"
$stackName = "VaioStack"

function Invoke-Step {
    param([string]$Label, [scriptblock]$Body)
    Write-Host ""
    Write-Host "=== $Label ===" -ForegroundColor Magenta
    & $Body
    if ($LASTEXITCODE -ne 0 -and $null -ne $LASTEXITCODE) {
        throw "$Label failed (exit $LASTEXITCODE)"
    }
}

Invoke-Step "1/5 Bootstrap out-of-band resources" {
    & (Join-Path $PSScriptRoot "bootstrap-resources.ps1") -Region $Region
}

Invoke-Step "2/5 Build API Lambda bundle" {
    if ($SkipDeps) {
        & (Join-Path $PSScriptRoot "build-api-lambda.ps1") -SkipDeps
    }
    else {
        & (Join-Path $PSScriptRoot "build-api-lambda.ps1")
    }
}

Invoke-Step "3/5 Stage frontend" {
    # Reuse existing outputs when the stack is already deployed so the very first
    # BucketDeployment already carries a working config.
    aws cloudformation describe-stacks --stack-name $stackName --region $Region 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
        & (Join-Path $PSScriptRoot "build-frontend.ps1") -StackName $stackName -Region $Region
    }
    else {
        Write-Host "Stack not deployed yet - staging with a placeholder config." -ForegroundColor Yellow
        & (Join-Path $PSScriptRoot "build-frontend.ps1") -SkipConfig
    }
    $global:LASTEXITCODE = 0
}

Invoke-Step "4/5 Deploy stack" {
    Push-Location $cdkDir
    try {
        if (-not (Test-Path (Join-Path $cdkDir "node_modules"))) {
            Write-Host "Installing CDK dependencies..." -ForegroundColor Cyan
            npm install --silent
            if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
        }
        npx cdk deploy $stackName --require-approval never
        if ($LASTEXITCODE -ne 0) { throw "cdk deploy failed" }
    }
    finally {
        Pop-Location
    }
}

Invoke-Step "5/5 Publish frontend with real config" {
    & (Join-Path $PSScriptRoot "build-frontend.ps1") -StackName $stackName -Region $Region

    $bucket = (aws cloudformation describe-stacks --stack-name $stackName --region $Region `
            --query "Stacks[0].Outputs[?OutputKey=='WebsiteBucketName'].OutputValue" --output text).Trim()
    $distDir = Join-Path $repoRoot "web-ui-dist"

    Write-Host "Syncing $distDir to s3://$bucket" -ForegroundColor Cyan
    aws s3 sync $distDir "s3://$bucket" --delete --region $Region
    if ($LASTEXITCODE -ne 0) { throw "Frontend sync failed" }

    $distId = (aws cloudfront list-distributions `
            --query "DistributionList.Items[?Comment=='Video AI Orchestrator (VAIO)'].Id | [0]" `
            --output text).Trim()
    if ($distId -and $distId -ne "None") {
        Write-Host "Invalidating CloudFront distribution $distId" -ForegroundColor Cyan
        aws cloudfront create-invalidation --distribution-id $distId --paths "/*" | Out-Null
    }
}

Write-Host ""
Write-Host "=== Deploy complete ===" -ForegroundColor Green
aws cloudformation describe-stacks --stack-name $stackName --region $Region `
    --query "Stacks[0].Outputs[].{Key:OutputKey,Value:OutputValue}" --output table
