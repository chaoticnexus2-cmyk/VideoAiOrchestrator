<#
.SYNOPSIS
  Create a VAIO console user.

.DESCRIPTION
  Self-registration is disabled by default, so this is the supported way to grant
  access. The user is created directly in the Cognito pool with a temporary password
  and lands in FORCE_CHANGE_PASSWORD: on first sign-in the console prompts for a new
  password through the challenge flow that is already wired up.

  The email address is marked verified, because an admin-created user has been vetted
  by whoever ran this script and would otherwise be unable to reset their own password.

.PARAMETER Email
  The user's email address. Also their sign-in name, since the pool uses email as its
  sign-in alias.

.PARAMETER TemporaryPassword
  Temporary password. Generated if omitted. Must satisfy the pool policy: at least 8
  characters with upper case, lower case, and a digit.

.PARAMETER SendEmail
  Have Cognito email the invitation containing the temporary password. Omitted by
  default so the password is not sent over email; it is printed here instead for you
  to pass along over a channel you trust.

.PARAMETER StackName
  CloudFormation stack to read the pool id from. Defaults to VaioStack.

.PARAMETER Region
  AWS region holding the stack. Defaults to us-east-1.

.EXAMPLE
  .\scripts\create-user.ps1 -Email someone@example.com

.EXAMPLE
  .\scripts\create-user.ps1 -Email someone@example.com -TemporaryPassword 'Chosen1Pass' -SendEmail
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Email,

    [string]$TemporaryPassword,

    [switch]$SendEmail,

    [string]$StackName = "VaioStack",

    [string]$Region = "us-east-1"
)

$ErrorActionPreference = "Stop"

if ($Email -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') {
    throw "'$Email' does not look like an email address."
}

# ── Resolve the user pool from the stack ─────────────────────────────────
$poolId = (aws cloudformation describe-stacks `
        --stack-name $StackName `
        --region $Region `
        --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" `
        --output text)
if ($LASTEXITCODE -ne 0 -or -not $poolId -or $poolId -eq "None") {
    throw "Could not read UserPoolId from stack $StackName in $Region. Is it deployed?"
}
$poolId = $poolId.Trim()

# ── Temporary password ───────────────────────────────────────────────────
if (-not $TemporaryPassword) {
    # Assemble from explicit character classes rather than a random slice, so the
    # result always satisfies the pool policy instead of usually satisfying it.
    $upper = -join ((65..90)  | Get-Random -Count 3 | ForEach-Object { [char]$_ })
    $lower = -join ((97..122) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
    $digit = -join ((48..57)  | Get-Random -Count 3 | ForEach-Object { [char]$_ })
    $TemporaryPassword = "$upper$lower$digit"
}

Write-Host "Creating user in pool $poolId" -ForegroundColor Cyan

$createArgs = @(
    "cognito-idp", "admin-create-user",
    "--user-pool-id", $poolId,
    "--username", $Email,
    "--user-attributes", "Name=email,Value=$Email", "Name=email_verified,Value=true",
    "--temporary-password", $TemporaryPassword,
    "--region", $Region
)
if (-not $SendEmail) {
    # SUPPRESS stops Cognito emailing the temporary password.
    $createArgs += @("--message-action", "SUPPRESS")
}

$result = & aws @createArgs 2>&1
if ($LASTEXITCODE -ne 0) {
    if ($result -match "UsernameExistsException") {
        throw "A user with the address $Email already exists. Use reset-user-password.ps1 to issue a new temporary password."
    }
    throw "admin-create-user failed: $result"
}

Write-Host ""
Write-Host "User created." -ForegroundColor Green
Write-Host "  Email:    $Email"
if ($SendEmail) {
    Write-Host "  Password: emailed to the user by Cognito"
}
else {
    Write-Host "  Temporary password: $TemporaryPassword" -ForegroundColor Yellow
    Write-Host "  Share this over a channel you trust. It was not emailed." -ForegroundColor DarkGray
}
Write-Host ""
Write-Host "The user must set a new password on first sign-in; the console prompts for it."
Write-Host "Console URL:" -NoNewline
$cloudFront = (aws cloudformation describe-stacks `
        --stack-name $StackName --region $Region `
        --query "Stacks[0].Outputs[?OutputKey=='CloudFrontURL'].OutputValue" `
        --output text 2>$null)
if ($LASTEXITCODE -eq 0 -and $cloudFront -and $cloudFront -ne "None") {
    Write-Host " $($cloudFront.Trim())"
}
else {
    Write-Host " (see the CloudFrontURL stack output)"
}
