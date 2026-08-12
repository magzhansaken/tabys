-- =====================================================================
-- 030_fiscal_prod.sql — Часть 23: боевая фискализация.
--
-- Что было (части 5, 17): провайдеры WebKassa/ReKassa + mock, очередь чеков
-- с ретраями, догон офлайн-чеков, правило «долг не фискализируется».
-- Чего не хватало для БОЯ:
--   1) режим test/prod — нельзя пускать боевые ключи без проверки;
--   2) проверка связи с ОФД ПЕРЕД запуском (тестовый чек в песочнице);
--   3) чек коррекции (МойСклад: «коррекция прихода/возврата прихода»).
--
-- Разбор конкурентов:
--   • Wipon: регистрацию ККМ проверяют в Кабинете налогоплательщика КГД,
--     сам Wipon кассу в КГД не регистрирует (это делает владелец с ЭЦП).
--   • МойСклад: WebKassa через Штрих-М по API учётной системы; регистрация
--     ККТ в ОФД требует КЭП; чек коррекции — приход/возврат прихода.
--   • UMAG: интеграция с WebKassa как внешним ОФД.
--
-- НАШ ВЫВОД: регистрация ККМ в КГД — прерогатива владельца с ЭЦП (граница
-- как по ЭСФ/910). Мы храним РНМ/ЗНМ, которые он получил, и проверяем связь
-- с ОФД тестовым чеком. Боевой режим включается ТОЛЬКО после успешной
-- проверки — иначе первый же реальный чек уйдёт в никуда, а это нарушение.
-- =====================================================================

-- Среда работы ККМ: пока не прошли проверку связи — боевые чеки не шлём.
DO $$ BEGIN
  CREATE TYPE fiscal_env AS ENUM ('test', 'production');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE kkm ADD COLUMN IF NOT EXISTS env fiscal_env NOT NULL DEFAULT 'test';
ALTER TABLE kkm ADD COLUMN IF NOT EXISTS connection_ok boolean NOT NULL DEFAULT false;
ALTER TABLE kkm ADD COLUMN IF NOT EXISTS connection_checked_at timestamptz;
ALTER TABLE kkm ADD COLUMN IF NOT EXISTS connection_error text;
-- ОФД возвращает адрес проверки чека покупателем (QR на чеке) — сохраняем
-- шаблон, чтобы касса печатала рабочий QR, а не заглушку.
ALTER TABLE kkm ADD COLUMN IF NOT EXISTS ofd_check_url text;

-- Чек коррекции: отдельная операция, не привязана к продаже (корректируем
-- «вообще смену», а не конкретный чек — так требует КГД). Добавляем в enum.
DO $$ BEGIN
  ALTER TYPE fiscal_op ADD VALUE IF NOT EXISTS 'correction';
EXCEPTION WHEN others THEN NULL; END $$;

-- Журнал чеков коррекции: что, когда, на какую сумму, по какой причине.
-- Коррекция — чувствительная операция (налоговая смотрит), нужен след.
CREATE TABLE IF NOT EXISTS fiscal_correction (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  kkm_id          uuid NOT NULL REFERENCES kkm(id),
  kind            text NOT NULL,                -- 'income' (приход) / 'income_refund' (возврат прихода)
  reason          text NOT NULL,                -- обоснование: «неучтённая выручка», «сбой ККМ»
  amount          numeric(14,2) NOT NULL,
  cash            numeric(14,2) NOT NULL DEFAULT 0,
  card            numeric(14,2) NOT NULL DEFAULT 0,
  fiscal_number   text,                         -- признак от ОФД после проведения
  status          fiscal_status NOT NULL DEFAULT 'pending',
  error           text,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  fiscalized_at   timestamptz
);

ALTER TABLE fiscal_correction ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fiscal_correction_isolation ON fiscal_correction;
CREATE POLICY fiscal_correction_isolation ON fiscal_correction
  USING (account_id = current_setting('app.account_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON fiscal_correction TO shop_app;
CREATE INDEX IF NOT EXISTS idx_fiscal_corr_account ON fiscal_correction(account_id, created_at DESC);

-- Готовность ККМ к бою: собирает в одном месте всё, что владелец должен
-- увидеть перед включением — есть ли РНМ/ЗНМ, прошла ли проверка связи,
-- в каком режиме работает. Кабинет показывает это как чек-лист.
CREATE OR REPLACE FUNCTION kkm_readiness(p_account uuid)
RETURNS TABLE (
  kkm_id uuid, cash_register text, provider text, env text,
  has_credentials boolean, has_reg_number boolean,
  connection_ok boolean, connection_checked_at timestamptz,
  is_active boolean, ready_for_production boolean
) LANGUAGE sql STABLE AS $$
  SELECT k.id, cr.name, k.provider::text, k.env::text,
         (k.api_login IS NOT NULL AND k.api_url IS NOT NULL),
         (k.reg_number IS NOT NULL AND k.serial_number IS NOT NULL),
         k.connection_ok, k.connection_checked_at, k.is_active,
         -- готов к бою: есть ключи, есть РНМ/ЗНМ, связь проверена
         (k.api_login IS NOT NULL AND k.api_url IS NOT NULL
          AND k.reg_number IS NOT NULL AND k.serial_number IS NOT NULL
          AND k.connection_ok)
  FROM kkm k
  JOIN cash_register cr ON cr.id = k.cash_register_id
  WHERE k.account_id = p_account AND k.deleted_at IS NULL;
$$;
