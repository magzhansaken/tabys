# Progon vseh testov. Zapusk: .\run_all.ps1
# Vnimanie: fail namerenno bez kirillicy i yunikod-simvolov -
# PowerShell 5.1 chitaet .ps1 kak WIN1251 i lomaetsya na nih.

chcp 65001 > $null
$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8

$env:PGUSER = "shop_app"
$env:PGPASSWORD = "change_me_in_prod"
$env:PGDATABASE = "shop_dev"
$env:PGHOST = "localhost"
if (-not $env:PGPORT) { $env:PGPORT = "5432" }
$env:PGCLIENTENCODING = "UTF8"

$tests = @(
  "auth.e2e", "sync.e2e", "goods.e2e", "import.e2e", "labels.e2e", "catalog.e2e",
  "stock.e2e", "stock2.e2e", "pos.e2e", "fiscal.e2e", "contragents.e2e",
  "finance.e2e", "reports.e2e", "documents.e2e", "loyalty.e2e", "equipment.e2e",
  "onboarding.e2e", "ai.e2e", "billing.e2e", "adminapi.e2e", "part16.pos-app.e2e", "part17.customers.e2e", "part18.acceptance.e2e", "part19.landing.e2e", "part20.operator.e2e",
  "part21.export.e2e", "part22.taxes.e2e", "part23.fiscal.e2e", "part24.people.e2e", "part25.cashplus.e2e", "part26.warehouse.e2e", "part27.automation.e2e", "part28.mobile.e2e", "part29.billing.e2e", "part30.marking.e2e", "part31.wholesale.e2e", "part32.marketplace.e2e", "part33.ai.e2e", "part34.verification.e2e", "part35.techcard.e2e", "part36.excise.e2e", "part37.rfm.e2e", "part38.signup.e2e", "part39.docs.e2e", "part40.reports.e2e", "part41.goods.e2e", "part42.cabinet-sale.e2e", "part1.criteria", "part4.criteria", "part1.frame"
)

$totalPass = 0
$totalFail = 0

foreach ($t in $tests) {
  $file = "test\$t.js"
  if (-not (Test-Path $file)) { continue }

  $out = node $file 2>&1 | Out-String

  # Itogovaya stroka testa: "=== ITOG: proideno 47, provaleno 0 ==="
  # Berem tolko chisla - tak ne zavisim ot kodirovki teksta.
  $p = 0; $f = 0
  $line = ($out -split "`n") | Where-Object { $_ -match '===.*\d+.*\d+.*===' } | Select-Object -Last 1
  if ($line -and ($line -match '(\d+)\D+(\d+)')) {
    $p = [int]$Matches[1]
    $f = [int]$Matches[2]
  } elseif ($LASTEXITCODE -ne 0) {
    $f = 1
  }

  $totalPass += $p
  $totalFail += $f

  $color = if ($f -gt 0) { "Red" } else { "Green" }
  Write-Host ("{0,-20} OK {1,-5} FAIL {2}" -f $t, $p, $f) -ForegroundColor $color

  if ($f -gt 0) {
    # pokazyvaem tolko provalivshiesya proverki
    ($out -split "`n") | Where-Object { $_ -match [char]0x2718 -or $_ -match 'ERROR|error:' } |
      Select-Object -First 5 | ForEach-Object { Write-Host "    $_" -ForegroundColor Yellow }
  }
}

Write-Host "======================================"
$c = if ($totalFail -gt 0) { "Red" } else { "Green" }
Write-Host ("TOTAL: passed {0}, failed {1}" -f $totalPass, $totalFail) -ForegroundColor $c
