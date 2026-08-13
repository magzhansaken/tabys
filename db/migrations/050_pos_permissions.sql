-- =====================================================================
-- 050_pos_permissions.sql — Права по действиям на кассе и настройки
-- скидок.
--
-- ЗАЧЕМ. Разбор конкурентов показал: у UMAG самое сильное решение
-- контроля кассира — не запреты, а РАЗРЕШЕНИЕ С ПОДТВЕРЖДЕНИЕМ.
-- Для каждого опасного действия владелец выбирает: доступно всем,
-- только администратору или никому. Если кассир пытается сделать то,
-- что разрешено администратору, касса просит его PIN прямо на месте.
--
-- Почему это лучше простого запрета: кассир не заблокирован и очередь
-- не стоит, но действие оставляет след и делается с чужого ведома.
-- Запрет заставил бы звонить владельцу, разрешение без следа — не
-- защищает вовсе.
--
-- Список действий взят из практики, а не выдуман: это ровно те четыре
-- операции, которыми выносят деньги из кассы (возврат, возврат без
-- чека, удаление позиции, уменьшение количества), плюс скидка и
-- изъятие денег.
--
-- НАСТРОЙКИ СКИДОК — у МоегоСклада: скидки можно запретить вовсе или
-- ограничить потолком. «Разрешить скидки до 15%» честнее, чем
-- запретить совсем: продавцу иногда нужно уступить сто тенге, чтобы
-- не потерять покупателя.
-- =====================================================================

-- Кому доступно действие: всем, только администратору, никому.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'pos_action_access') THEN
    CREATE TYPE pos_action_access AS ENUM ('everyone', 'admin_only', 'nobody');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS pos_settings (
  account_id        uuid PRIMARY KEY REFERENCES account(id) ON DELETE CASCADE,

  -- Опасные действия. Умолчания выбраны так, чтобы новый магазин
  -- работал сразу, но самое рискованное требовало подтверждения.
  act_refund        pos_action_access NOT NULL DEFAULT 'everyone',
  act_refund_free   pos_action_access NOT NULL DEFAULT 'admin_only',  -- возврат без чека
  act_remove_item   pos_action_access NOT NULL DEFAULT 'everyone',
  act_reduce_qty    pos_action_access NOT NULL DEFAULT 'everyone',
  act_discount      pos_action_access NOT NULL DEFAULT 'everyone',
  act_price_change  pos_action_access NOT NULL DEFAULT 'admin_only',
  act_cash_out      pos_action_access NOT NULL DEFAULT 'admin_only',  -- изъятие денег

  -- Скидки
  discount_allowed  boolean NOT NULL DEFAULT true,
  discount_max_pct  numeric(5,2) NOT NULL DEFAULT 100
                    CHECK (discount_max_pct >= 0 AND discount_max_pct <= 100),
  no_price_down     boolean NOT NULL DEFAULT false,   -- запрет снижения цены

  -- Чек: заголовок и подвал задаёт владелец (модель UMAG)
  receipt_header    text,
  receipt_footer    text DEFAULT 'Спасибо за покупку!',

  updated_at        timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE pos_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pos_settings_isolation ON pos_settings;
CREATE POLICY pos_settings_isolation ON pos_settings
  USING (account_id = current_setting('app.account_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON pos_settings TO shop_app;

/**
 * Журнал действий кассира (модель МоегоСклада «Отчёт действий кассира»).
 *
 * Пишем не всё подряд, а только то, что имеет цену: отмены, возвраты,
 * скидки, изменения цены, движение денег. Журнал каждого нажатия никто
 * читать не будет, а журнал шести видов действий — прочтут.
 *
 * approved_by заполняется, когда действие потребовало подтверждения
 * администратора: видно не только что сделали, но и кто разрешил.
 */
CREATE TABLE IF NOT EXISTS pos_action_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  shift_id      uuid REFERENCES shift(id) ON DELETE CASCADE,
  action        text NOT NULL,          -- refund, remove_item, discount, price_change…
  employee_id   uuid REFERENCES employee(id),
  approved_by   uuid REFERENCES employee(id),
  product_name  text,
  amount        numeric(14,2),
  comment       text,
  at            timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE pos_action_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pos_action_log_isolation ON pos_action_log;
CREATE POLICY pos_action_log_isolation ON pos_action_log
  USING (account_id = current_setting('app.account_id', true)::uuid);
GRANT SELECT, INSERT ON pos_action_log TO shop_app;
CREATE INDEX IF NOT EXISTS idx_pos_log_shift ON pos_action_log(shift_id, at DESC);

-- Скидка на весь чек: поле было только у позиции.
ALTER TABLE sale ADD COLUMN IF NOT EXISTS bonus_used numeric(14,2) NOT NULL DEFAULT 0;

COMMENT ON TABLE pos_settings IS
  'Права по действиям на кассе и настройки скидок. Модель UMAG: разрешение с подтверждением администратора вместо запрета';
COMMENT ON TABLE pos_action_log IS
  'Журнал значимых действий кассира: отмены, возвраты, скидки, движение денег';
