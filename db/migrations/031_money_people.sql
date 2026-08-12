-- =====================================================================
-- 031_money_people.sql — Часть 24: деньги и люди.
--
-- Разбор конкурентов:
--  • МойСклад: зарплата = «Начисление» (документ: оклад/сдельно) + «Выплата»
--    (расходный ордер по статье «Зарплата»). Договоры между организацией и
--    контрагентом (купли-продажи/комиссии). Объединение дублей с выбором
--    основного и переносом всех связей. Отделы = разграничение прав.
--  • Wipon: «Должности» сотрудников (у нас поле position уже есть). Зарплаты
--    как отдельного модуля нет.
--  • UMAG: «Пользователи» с ролями; зарплаты нет — консультантов считают в Excel.
--
-- НАШ ВЫВОД для магазина у дома:
--  1) Зарплата проще, чем у МоегоСклада (нет производства/сдельщины по этапам):
--     оклад + смены (по факту отработанных) + премия/удержание. Плюс у нас
--     уже есть комиссия консультантов (часть 18) — сводим всё в одну ведомость
--     «к выплате», чего нет ни у кого.
--  2) Выплата ложится на готовый fin_move (статья «Зарплата», employee_id) —
--     сразу видна в ДДС и П&У. Не изобретаем второй денежный контур.
--  3) Отделы делаем лёгкими: группировка сотрудников. Полное разграничение
--     прав по отделам (как у МоегоСклада) для 3–5 продавцов избыточно —
--     оставляем задел (department_id у сотрудника), но не усложняем права.
--  4) Договоры — простые (номер, тип, даты, контрагент): магазину нужен номер
--     для ЭСФ/АВР и контроль сроков, а не конструктор из 20 полей.
-- =====================================================================

-- ----- ОТДЕЛЫ -----
CREATE TABLE IF NOT EXISTS department (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
ALTER TABLE department ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS department_isolation ON department;
CREATE POLICY department_isolation ON department
  USING (account_id = current_setting('app.account_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON department TO shop_app;

ALTER TABLE employee ADD COLUMN IF NOT EXISTS department_id uuid REFERENCES department(id);
-- зарплатные поля сотрудника: оклад за месяц и ставка за смену (что заполнено,
-- то и берём в расчёт). Магазин платит либо окладом, либо за смены — редко смешанно.
ALTER TABLE employee ADD COLUMN IF NOT EXISTS salary_monthly numeric(14,2);
ALTER TABLE employee ADD COLUMN IF NOT EXISTS salary_per_shift numeric(14,2);

-- ----- НАЧИСЛЕНИЕ ЗАРПЛАТЫ -----
-- Документ начисления за период. Итоговая сумма = оклад (или смены×ставку) +
-- комиссия консультанта + премия − удержание. Выплата отдельным движением.
CREATE TABLE IF NOT EXISTS payroll (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  employee_id   uuid NOT NULL REFERENCES employee(id),
  period_from   date NOT NULL,
  period_to     date NOT NULL,
  base_amount   numeric(14,2) NOT NULL DEFAULT 0,   -- оклад или смены×ставка
  shifts_count  integer NOT NULL DEFAULT 0,
  commission    numeric(14,2) NOT NULL DEFAULT 0,   -- комиссия консультанта (часть 18)
  bonus         numeric(14,2) NOT NULL DEFAULT 0,   -- премия
  deduction     numeric(14,2) NOT NULL DEFAULT 0,   -- удержание (недостача, аванс)
  total_accrued numeric(14,2) NOT NULL DEFAULT 0,   -- итого начислено
  paid_amount   numeric(14,2) NOT NULL DEFAULT 0,   -- сколько уже выплачено
  status        text NOT NULL DEFAULT 'draft',      -- draft / accrued / paid
  comment       text,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE payroll ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payroll_isolation ON payroll;
CREATE POLICY payroll_isolation ON payroll
  USING (account_id = current_setting('app.account_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON payroll TO shop_app;
CREATE INDEX IF NOT EXISTS idx_payroll_emp ON payroll(account_id, employee_id, period_from);

-- ----- ДОГОВОРЫ -----
CREATE TABLE IF NOT EXISTS contract (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  counterparty_id uuid NOT NULL REFERENCES counterparty(id),
  number         text NOT NULL,
  kind           text NOT NULL DEFAULT 'sale',       -- sale / commission / supply
  signed_date    date,
  valid_until    date,
  amount         numeric(14,2),                       -- сумма договора (если фикс)
  comment        text,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);
ALTER TABLE contract ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contract_isolation ON contract;
CREATE POLICY contract_isolation ON contract
  USING (account_id = current_setting('app.account_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON contract TO shop_app;
CREATE INDEX IF NOT EXISTS idx_contract_cp ON contract(account_id, counterparty_id);

-- ----- ОБЪЕДИНЕНИЕ ДУБЛЕЙ КОНТРАГЕНТОВ -----
-- Модель МоегоСклада: выбираем основного, остальные архивируем, все ссылки
-- переносим на основного. Отменить нельзя — поэтому функция атомарна и
-- переносит ВСЕ связи (продажи, движения денег, долги, договоры), иначе
-- «осиротевшие» документы теряют контрагента.
CREATE OR REPLACE FUNCTION merge_counterparties(
  p_account uuid, p_primary uuid, p_dupes uuid[]
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  moved integer := 0;
  dupe uuid;
BEGIN
  -- защита: основной не может быть среди дублей
  IF p_primary = ANY(p_dupes) THEN
    RAISE EXCEPTION 'Основной контрагент не может быть в списке дублей';
  END IF;

  FOREACH dupe IN ARRAY p_dupes LOOP
    -- переносим все ссылки на основного
    UPDATE sale SET customer_id = p_primary
      WHERE account_id = p_account AND customer_id = dupe;
    UPDATE fin_move SET counterparty_id = p_primary
      WHERE account_id = p_account AND counterparty_id = dupe;
    UPDATE contract SET counterparty_id = p_primary
      WHERE account_id = p_account AND counterparty_id = dupe;
    -- долги/бонусы дубля прибавляем к основному, затем обнуляем у дубля
    UPDATE counterparty_balance pb
       SET balance = pb.balance + coalesce(
             (SELECT balance FROM counterparty_balance
               WHERE counterparty_id = dupe AND account_id = p_account), 0)
     WHERE pb.counterparty_id = p_primary AND pb.account_id = p_account;
    DELETE FROM counterparty_balance
      WHERE counterparty_id = dupe AND account_id = p_account;
    -- архивируем дубль
    UPDATE counterparty SET deleted_at = now()
      WHERE id = dupe AND account_id = p_account;
    moved := moved + 1;
  END LOOP;
  RETURN moved;
END;
$$;
