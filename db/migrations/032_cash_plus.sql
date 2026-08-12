-- =====================================================================
-- 032_cash_plus.sql — Часть 25: касса++ (авансы и сертификаты).
--
-- Разбор конкурентов:
--  • МойСклад: авансы только в кассе на Android, в облачных недоступны;
--    аванс = деньги без указания товара, на нём строят кредиты и сертификаты.
--    Сертификаты «в РАЗРАБОТКЕ»: реализована только оплата, продажа
--    недоступна, и работают ТОЛЬКО с внешними системами лояльности
--    (Бонус Плюс, Teyca), не работают с QR/авансом.
--  • Wipon: авансов и сертификатов НЕТ вообще (только прайс-чекер).
--  • UMAG: нет.
--
-- НАШ ВЫВОД — это окно для обгона:
--  1) Сертификаты делаем СВОИ и полностью (продажа + оплата + баланс + срок),
--     без внешних систем. У нас уже своя лояльность с FIFO-сгоранием (часть 19)
--     — переиспользуем механику. Обгоняем МойСклад в его же незакрытой функции.
--  2) Авансы делаем и в облаке, и офлайн на кассе (у МоегоСклада только Android).
--     Аванс — предоплата на счёт покупателя, зачитывается в будущую продажу.
--  3) Оба работают офлайн: касса пишет событие, зачёт считается на сервере.
-- =====================================================================

-- ----- АВАНСЫ -----
-- Аванс — деньги, внесённые покупателем вперёд. Лежат на его счёте авансов,
-- зачитываются при продаже. Отдельно от долга (долг — мы ждём денег, аванс —
-- деньги уже у нас). Модель МоегоСклада «аванс ≠ предоплата»: в чеке за аванс
-- товар не указывается.
CREATE TABLE IF NOT EXISTS advance_move (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  counterparty_id uuid NOT NULL REFERENCES counterparty(id),
  amount         numeric(14,2) NOT NULL,        -- + внесение, − зачёт в продажу
  sale_id        uuid REFERENCES sale(id) ON DELETE SET NULL,
  kind           text NOT NULL,                 -- 'deposit' / 'redeem' / 'refund'
  comment        text,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT advance_not_zero CHECK (amount <> 0)
);
ALTER TABLE advance_move ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS advance_move_isolation ON advance_move;
CREATE POLICY advance_move_isolation ON advance_move
  USING (account_id = current_setting('app.account_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON advance_move TO shop_app;
CREATE INDEX IF NOT EXISTS idx_advance_cp ON advance_move(account_id, counterparty_id);

-- баланс авансов покупателя (сумма всех движений)
CREATE TABLE IF NOT EXISTS advance_balance (
  counterparty_id uuid PRIMARY KEY REFERENCES counterparty(id) ON DELETE CASCADE,
  account_id     uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  balance        numeric(14,2) NOT NULL DEFAULT 0
);
ALTER TABLE advance_balance ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS advance_balance_isolation ON advance_balance;
CREATE POLICY advance_balance_isolation ON advance_balance
  USING (account_id = current_setting('app.account_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON advance_balance TO shop_app;

-- движение аванса + пересчёт баланса одной операцией (атомарно)
CREATE OR REPLACE FUNCTION apply_advance(
  p_account uuid, p_cp uuid, p_amount numeric, p_kind text, p_sale uuid, p_by uuid, p_comment text
) RETURNS numeric LANGUAGE plpgsql AS $$
DECLARE new_balance numeric;
BEGIN
  INSERT INTO advance_move (account_id, counterparty_id, amount, sale_id, kind, created_by, comment)
    VALUES (p_account, p_cp, p_amount, p_sale, p_kind, p_by, p_comment);
  INSERT INTO advance_balance (counterparty_id, account_id, balance)
    VALUES (p_cp, p_account, p_amount)
    ON CONFLICT (counterparty_id) DO UPDATE SET balance = advance_balance.balance + p_amount
    RETURNING balance INTO new_balance;
  IF new_balance < 0 THEN
    RAISE EXCEPTION 'Недостаточно аванса: на счёте % ₸', new_balance + abs(p_amount);
  END IF;
  RETURN new_balance;
END;
$$;

-- ----- ПОДАРОЧНЫЕ СЕРТИФИКАТЫ -----
-- Свои, без внешних систем. Продаётся с номиналом, гасится при покупке.
-- Может быть на предъявителя (по коду) или на покупателя. Срок действия —
-- как у МоегоСклада «сгорание», но у нас своё (часть 19).
CREATE TABLE IF NOT EXISTS gift_certificate (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  code           text NOT NULL,                 -- код на карте/чеке (по нему гасят)
  nominal        numeric(14,2) NOT NULL,        -- номинал при продаже
  balance        numeric(14,2) NOT NULL,        -- остаток (сертификат можно тратить частями)
  status         text NOT NULL DEFAULT 'active', -- active / used / expired / void
  sold_sale_id   uuid REFERENCES sale(id),      -- чек продажи сертификата
  customer_id    uuid REFERENCES counterparty(id), -- если именной
  valid_until    date,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  UNIQUE (account_id, code)
);
ALTER TABLE gift_certificate ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gift_certificate_isolation ON gift_certificate;
CREATE POLICY gift_certificate_isolation ON gift_certificate
  USING (account_id = current_setting('app.account_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON gift_certificate TO shop_app;
CREATE INDEX IF NOT EXISTS idx_gift_code ON gift_certificate(account_id, code);

-- журнал использования сертификатов (продажа/гашение/возврат)
CREATE TABLE IF NOT EXISTS gift_certificate_move (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  certificate_id uuid NOT NULL REFERENCES gift_certificate(id) ON DELETE CASCADE,
  amount         numeric(14,2) NOT NULL,        -- − гашение, + возврат
  sale_id        uuid REFERENCES sale(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE gift_certificate_move ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gift_cert_move_isolation ON gift_certificate_move;
CREATE POLICY gift_cert_move_isolation ON gift_certificate_move
  USING (account_id = current_setting('app.account_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON gift_certificate_move TO shop_app;

-- новые методы оплаты: аванс и сертификат. Каспи-эквайринг идёт как 'card'
-- (для налоговой это безнал), поэтому отдельный enum-метод ему не нужен.
DO $$ BEGIN
  ALTER TYPE pay_method ADD VALUE IF NOT EXISTS 'advance';
EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN
  ALTER TYPE pay_method ADD VALUE IF NOT EXISTS 'certificate';
EXCEPTION WHEN others THEN NULL; END $$;

-- price-checker и Kaspi POS настраиваются на точке — флаги в store
ALTER TABLE store ADD COLUMN IF NOT EXISTS price_checker_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE store ADD COLUMN IF NOT EXISTS kaspi_pos_enabled boolean NOT NULL DEFAULT false;
