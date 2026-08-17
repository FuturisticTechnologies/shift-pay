<#
.SYNOPSIS
    Run a ShiftPay test case and produce its Word evidence record.

.DESCRIPTION
    One command: it signs in if needed, opens a browser, runs the case, and
    writes a branded .docx that opens when it is done.

    Three of the nine automated cases are EXPECTED TO FAIL — TC-SP-004 and
    TC-SP-005 on real defects, TC-SP-009 on a deliberately introduced one. A red
    verdict there is a correct run, and this script still exits 0 because the
    failing document is the deliverable. See testing/README.md.

.PARAMETER Case
    One or more case ids, or 'all'. Defined in TEST-CASES-SHIFTPAY.md.

.EXAMPLE
    .\testing\run-case.ps1 TC-SP-003

.EXAMPLE
    .\testing\run-case.ps1 TC-SP-004 TC-SP-005 -Headless

.EXAMPLE
    .\testing\run-case.ps1 all
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0, ValueFromRemainingArguments = $true)]
    [string[]] $Case,

    # Run without a visible browser. The default is headed, because watching the
    # case drive the widget is most of the value during a demo.
    [switch] $Headless,

    # Do not open the document when it is built.
    [switch] $NoOpen,

    # Skip the login refresh and reuse whatever session is saved.
    [switch] $NoAuth
)

$ErrorActionPreference = 'Stop'

$automation = Join-Path $PSScriptRoot 'automation'
$runner = Join-Path $automation 'run-case.mjs'

if (-not (Test-Path $runner)) {
    Write-Error "run-case.mjs not found at $runner"
    exit 1
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error 'Node.js is not on PATH. Install Node 20.6+ (24 recommended) and re-run.'
    exit 1
}

$args = @($Case)
if ($Headless) { $args += '--headless' }
if ($NoOpen)   { $args += '--no-open' }
if ($NoAuth)   { $args += '--no-auth' }

Push-Location $automation
try {
    & node $runner @args
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
