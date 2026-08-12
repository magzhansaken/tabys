#!/bin/bash
export PGUSER=shop_app PGPASSWORD=change_me_in_prod PGDATABASE=shop_dev NODE_ENV=test
total=0; failed=0
# Сторожа идут ПЕРВЫМИ: они не требуют базы, работают доли секунды и
# ловят пропажу важных решений раньше, чем начнётся долгий прогон.
echo "── Сторожа (правила, которые нельзя нарушать)"
node ../scripts/check-invariants.js || { echo "ОСТАНОВЛЕНО: нарушены правила выше"; exit 1; }
echo "── Касса (без базы, доли секунды)"
node test/pos-desktop.test.js | tail -1
echo

for t in auth.e2e sync.e2e goods.e2e import.e2e labels.e2e catalog.e2e stock.e2e stock2.e2e pos.e2e fiscal.e2e contragents.e2e finance.e2e reports.e2e documents.e2e loyalty.e2e equipment.e2e onboarding.e2e ai.e2e billing.e2e adminapi.e2e part16.pos-app.e2e part17.customers.e2e part18.acceptance.e2e part19.landing.e2e part20.operator.e2e part21.export.e2e part22.taxes.e2e part23.fiscal.e2e part24.people.e2e part25.cashplus.e2e part26.warehouse.e2e part27.automation.e2e part28.mobile.e2e part29.billing.e2e part30.marking.e2e part31.wholesale.e2e part32.marketplace.e2e part33.ai.e2e part34.verification.e2e part35.techcard.e2e part36.excise.e2e part37.rfm.e2e part38.signup.e2e part39.docs.e2e part40.reports.e2e part41.goods.e2e part42.cabinet-sale.e2e part1.criteria part4.criteria part1.frame; do
  pkill -f 'dist/main.js' 2>/dev/null; sleep 0.5
  out=$(timeout 150 node --no-warnings test/$t.js 2>&1)
  n=$(echo "$out" | grep -c "✔")
  f=$(echo "$out" | grep -c "✘")
  total=$((total+n)); failed=$((failed+f))
  printf "%-18s ✔ %-4s ✘ %s\n" "$t" "$n" "$f"
  [ "$f" != "0" ] && echo "$out" | grep "✘" | head -3
done
echo "======================================"
echo "ИТОГО: пройдено $total, провалено $failed"
