-- =====================================================================
-- 029_taxes.sql — Часть 22: налоговый блок Казахстана.
--
-- Разбор конкурентов:
--  • Wipon: регистры (продажи + 3 налоговых) → период → «Скачать»;
--    декларации 910.00/200.00 → код ОГД → заполнить поля → «Отправить».
--    Налоговые заявления у них — «в разработке».
--  • UMAG: налогового блока нет вообще.
--  • МойСклад: для КЗ только НДС и печатные формы; формы 910 нет (это
--    российская система под ФФД/СНО РФ).
--
-- ГЛАВНОЕ ОТЛИЧИЕ НАШЕГО ПОДХОДА: у Wipon владелец ЗАПОЛНЯЕТ поля
-- декларации руками. У нас доход уже разложен по продажам на нал/безнал/
-- QR/долг (часть 13) — значит строку 910.00.001 и весь расчёт ИПН мы
-- считаем САМИ из реальных чеков. Владельцу остаётся проверить и подписать.
--
-- Граница честности (та же, что по ЭСФ в части 11): отправку в ОГД делает
-- живой человек с ЭЦП через Кабинет налогоплательщика. Мы доводим до XML +
-- печатной формы + инструкции. Это 95% пользы без ложных обещаний «сдадим
-- за вас», которых мы выполнить не можем.
-- =====================================================================

-- Ставки и показатели РК на год. Меняются ежегодно законом о бюджете —
-- поэтому в таблице, а не в коде: новый год = одна строка INSERT, без
-- пересборки сервера. Значения 2026 подтверждены по источникам (МЗП 85000,
-- ИПН упрощёнки 4% с диапазоном маслихата 2–6%, соцналог отменён с 2026).
CREATE TABLE IF NOT EXISTS tax_year_params (
  year            integer PRIMARY KEY,
  mrp             numeric(14,2) NOT NULL,       -- месячный расчётный показатель
  mzp             numeric(14,2) NOT NULL,       -- минимальная зарплата (база соцплатежей)
  simplified_ipn_rate  numeric(5,4) NOT NULL,   -- ставка ИПН упрощёнки (0.04 = 4%)
  opv_rate        numeric(5,4) NOT NULL,        -- пенсионные взносы «за себя»
  opvr_rate       numeric(5,4) NOT NULL,        -- пенсионные работодателя
  so_rate         numeric(5,4) NOT NULL,        -- социальные отчисления
  vosms_base_mzp  numeric(5,2) NOT NULL,        -- база ВОСМС в долях МЗП (1.4)
  vosms_rate      numeric(5,4) NOT NULL,        -- ставка ВОСМС
  income_limit_mrp numeric(14,2) NOT NULL,      -- предел дохода упрощёнки (24 038 МРП)
  notes           text
);

INSERT INTO tax_year_params
  (year, mrp, mzp, simplified_ipn_rate, opv_rate, opvr_rate, so_rate,
   vosms_base_mzp, vosms_rate, income_limit_mrp, notes)
VALUES
  (2026, 4325, 85000, 0.04, 0.10, 0.035, 0.05, 1.4, 0.05, 24038,
   'Новый НК РК: соцналог отменён, ИПН упрощёнки 4% (маслихат 2–6%), ОПВР вырос до 3,5%')
ON CONFLICT (year) DO NOTHING;

-- Настройки налогоплательщика: ставка маслихата и заявленный доход для
-- соцплатежей задаёт владелец (регион и решение — его). Храним на аккаунт.
CREATE TABLE IF NOT EXISTS tax_settings (
  account_id       uuid PRIMARY KEY REFERENCES account(id) ON DELETE CASCADE,
  oged_code        text,                        -- код органа госдоходов (ОГД)
  maslikhat_ipn_rate numeric(5,4),              -- ставка маслихата, если ≠ базовой 4%
  declared_income_monthly numeric(14,2),        -- заявленный доход для ОПВ/СО/ВОСМС «за себя»
  born_before_1975 boolean NOT NULL DEFAULT false, -- ОПВР не платят рождённые до 1975
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tax_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tax_settings_isolation ON tax_settings;
CREATE POLICY tax_settings_isolation ON tax_settings
  USING (account_id = current_setting('app.account_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON tax_settings TO shop_app;
GRANT SELECT ON tax_year_params TO shop_app;

-- Журнал сформированных деклараций: что и когда посчитали, каким XML отдали.
-- Нужен для истории (Wipon показывает «историю запросов») и чтобы владелец
-- мог скачать повторно ту же декларацию, а не пересчитывать.
CREATE TABLE IF NOT EXISTS tax_declaration (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  form             text NOT NULL,               -- '910.00' / '200.00'
  period_year      integer NOT NULL,
  period_half      smallint NOT NULL,           -- 1 или 2 (полугодие)
  income_total     numeric(14,2) NOT NULL,      -- 910.00.001
  income_cash      numeric(14,2) NOT NULL,
  income_noncash   numeric(14,2) NOT NULL,
  ipn_amount       numeric(14,2) NOT NULL,      -- 910.00.004
  social_json      jsonb,                       -- ОПВ/ОПВР/СО/ВОСМС по месяцам
  computed_json    jsonb NOT NULL,              -- полный расчёт для печатной формы
  status           text NOT NULL DEFAULT 'draft', -- draft / exported
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tax_declaration ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tax_declaration_isolation ON tax_declaration;
CREATE POLICY tax_declaration_isolation ON tax_declaration
  USING (account_id = current_setting('app.account_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON tax_declaration TO shop_app;
CREATE INDEX IF NOT EXISTS idx_tax_decl_period ON tax_declaration(account_id, period_year, period_half);

-- =====================================================================
-- Функция дохода за период по способам оплаты. Возврат (return_of_id)
-- уменьшает доход — иначе в декларации будет завышение, а это штраф.
-- Долг (paid_credit) — это тоже доход «подлежащий получению» (в 910
-- отражается весь доход, включая безналичный и в кредит).
-- =====================================================================
CREATE OR REPLACE FUNCTION tax_income(
  p_account uuid, p_from timestamptz, p_to timestamptz
) RETURNS TABLE (cash numeric, noncash numeric, total numeric)
LANGUAGE sql STABLE AS $$
  SELECT
    coalesce(sum(CASE WHEN s.return_of_id IS NULL THEN s.paid_cash ELSE -s.paid_cash END), 0),
    coalesce(sum(CASE WHEN s.return_of_id IS NULL
                      THEN s.paid_card + s.paid_qr + s.paid_credit
                      ELSE -(s.paid_card + s.paid_qr + s.paid_credit) END), 0),
    coalesce(sum(CASE WHEN s.return_of_id IS NULL THEN s.total ELSE -s.total END), 0)
  FROM sale s
  WHERE s.account_id = p_account
    AND s.created_at >= p_from AND s.created_at < p_to;
$$;
