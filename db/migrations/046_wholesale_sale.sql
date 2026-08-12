-- =====================================================================
-- 046_wholesale_sale.sql — Этап 8: продажа из кабинета доводится до конца.
--
-- Разбор UMAG (раздел «Продажи», 279 строк — самый большой из оставшихся):
--  • продажа оформляется В КАБИНЕТЕ на контрагента, а не на кассе;
--  • в списке столбцы: номер, дата, контрагент, пользователь, сумма,
--    оплачено, в т.ч. бонусами, кэшбэк, комментарий;
--  • ЦВЕТ подчёркивания суммы = статус оплаты: зелёный — долг погашен,
--    красный — не погашен;
--  • по продаже создаётся платёж, возможна частичная оплата;
--  • выгрузка выбранных продаж в 1С.
--
-- ЧТО БЫЛО У НАС: оптовая воронка (часть 31) с этапами и позициями —
-- но она только МЕНЯЛА ЭТАП. Товар не списывался, долг не возникал,
-- оплата не принималась. То есть сделка «оплачена» в воронке, а на
-- складе товар всё ещё лежит, и денег в кассе нет.
--
-- РЕШЕНИЕ: не строим второй механизм рядом, а доводим существующий.
-- Отгрузка списывает товар и создаёт долг (через готовую проверку
-- лимита), оплата гасит долг и начисляет бонусы. Воронка остаётся
-- воронкой, но теперь за её этапами стоят настоящие движения.
-- =====================================================================

-- Оплата и бонусы по оптовой сделке
ALTER TABLE wholesale_order ADD COLUMN IF NOT EXISTS paid_sum      numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE wholesale_order ADD COLUMN IF NOT EXISTS bonus_used    numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE wholesale_order ADD COLUMN IF NOT EXISTS cashback_sum  numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE wholesale_order ADD COLUMN IF NOT EXISTS shipped_at    timestamptz;
ALTER TABLE wholesale_order ADD COLUMN IF NOT EXISTS warehouse_id  uuid REFERENCES warehouse(id);

-- Платежи по сделке: частичная оплата — обычное дело в опте
-- («половину сейчас, половину после реализации»).
CREATE TABLE IF NOT EXISTS wholesale_payment (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  order_id      uuid NOT NULL REFERENCES wholesale_order(id) ON DELETE CASCADE,
  amount        numeric(14,2) NOT NULL CHECK (amount > 0),
  bonus_used    numeric(14,2) NOT NULL DEFAULT 0,
  method        text NOT NULL DEFAULT 'cash',    -- cash / card / transfer
  comment       text,
  employee_id   uuid REFERENCES employee(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE wholesale_payment ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wholesale_payment_isolation ON wholesale_payment;
CREATE POLICY wholesale_payment_isolation ON wholesale_payment
  USING (account_id = current_setting('app.account_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON wholesale_payment TO shop_app;
CREATE INDEX IF NOT EXISTS idx_wholesale_payment ON wholesale_payment(order_id, created_at DESC);
