-- =====================================================================
-- 040_counterparty_check.sql — Часть 34: проверка контрагента (КГД).
--
-- Разбор рынка (веб-поиск, КЗ 2026):
--  • Портал КГД (portal.kgd.gov.kz) «Сведения по контрагентам»: по БИН/ИИН →
--    налоговый режим, СТАТУС ПЛАТЕЛЬЩИКА НДС + дата постановки, ОКЭД,
--    задолженность, реестр неблагонадёжных поставщиков.
--  • С 01.01.2026 в ЭСФ обязательное поле «дата постановки на учёт по НДС».
--  • НАЛОГОВЫЙ РИСК: КГД не примет НДС к зачёту, если поставщик не плательщик
--    НДС на дату сделки или сделка с недобросовестным поставщиком —
--    доначисления, пени, штрафы ложатся на ПОКУПАТЕЛЯ (нас), не на контрагента.
--
-- Разбор конкурентов:
--  • Wipon: kaspi-check и kgd-check — но это проверка ККМ (регистрация кассы),
--    НЕ контрагента. Мы делаем ШИРЕ и полезнее — проверку поставщика, что
--    реально защищает деньги владельца от доначислений НДС.
--  • UMAG, МойСклад: проверки контрагента по КЗ нет.
--
-- НАШ ВЫВОД:
--  1) Проверка контрагента по БИН/ИИН перед приёмкой и оптовой сделкой:
--     плательщик ли НДС, налоговый режим, в реестре неблагонадёжных ли,
--     есть ли задолженность. Предупредить о риске ДО сделки.
--  2) Провайдерный паттерн (как fiscal/payment/marketplace): интерфейс +
--     Mock + КГД-каркас. Боевой доступ к порталу КГД по ЭЦП/API.
--  3) Кэшируем результат (проверки КГД не мгновенные) с датой — чтобы не
--     дёргать на каждую операцию, но видеть свежесть.
--  4) Проверка ККМ (как у Wipon) — вторична; главное защитить от рисков НДС.
-- =====================================================================

-- поля проверки на контрагенте (последний известный статус)
ALTER TABLE counterparty ADD COLUMN IF NOT EXISTS vat_payer boolean;          -- плательщик НДС
ALTER TABLE counterparty ADD COLUMN IF NOT EXISTS vat_since date;             -- дата постановки на учёт НДС
ALTER TABLE counterparty ADD COLUMN IF NOT EXISTS tax_regime text;            -- режим налогообложения
ALTER TABLE counterparty ADD COLUMN IF NOT EXISTS is_unreliable boolean;      -- в реестре неблагонадёжных
ALTER TABLE counterparty ADD COLUMN IF NOT EXISTS has_tax_debt boolean;       -- есть задолженность
ALTER TABLE counterparty ADD COLUMN IF NOT EXISTS checked_at timestamptz;     -- когда проверяли

-- журнал проверок (аудит: кто и когда проверял, что вернул КГД)
CREATE TABLE IF NOT EXISTS counterparty_check (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  counterparty_id uuid REFERENCES counterparty(id) ON DELETE SET NULL,
  iin_bin       text NOT NULL,
  provider      text NOT NULL DEFAULT 'kgd',
  found         boolean NOT NULL DEFAULT false,
  name          text,                            -- название по данным КГД
  vat_payer     boolean,
  vat_since     date,
  tax_regime    text,
  is_unreliable boolean,
  has_tax_debt  boolean,
  risk_level    text,                            -- ok / warning / danger
  raw           jsonb,
  employee_id   uuid REFERENCES employee(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE counterparty_check ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cp_check_isolation ON counterparty_check;
CREATE POLICY cp_check_isolation ON counterparty_check
  USING (account_id = current_setting('app.account_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON counterparty_check TO shop_app;
CREATE INDEX IF NOT EXISTS idx_cp_check ON counterparty_check(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cp_check_bin ON counterparty_check(account_id, iin_bin);
