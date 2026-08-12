-- =====================================================================
-- 035_billing_online.sql — Часть 29: онлайн-оплата подписки.
--
-- Разбор рынка (веб-поиск, KZ 2026):
--  • Kaspi Merchant API v2: создать счёт → клиент платит в Kaspi →
--    webhook «оплачено» с подписью HMAC-SHA256 → срабатывает логика.
--    Есть тестовое окружение (эмуляция без реальных денег).
--  • Стандартный flow эквайринга: invoice → оплата → webhook → пополнение.
--  • >90% онлайн-платежей в KZ идут через Kaspi; карта — второй канал.
--
-- Что было (части 23, 27): tariff, subscription (баланс, price_locked,
-- статусы trial/active/grace/readonly/frozen), billing_move, ручной topup
-- и charge (списание за месяц). НО пополнение было «как будто оператор внёс» —
-- реального приёма денег не было.
--
-- НАШ ВЫВОД:
--  1) Делаем СЧЁТ (invoice): клиент выбирает сумму → создаём счёт у провайдера
--     → получаем ссылку/QR → клиент платит → webhook подтверждает → баланс
--     пополняется автоматически. Это ровно flow Kaspi Merchant API.
--  2) Провайдер абстрагирован (kaspi/card/manual) — как фискальные провайдеры
--     части 23. Боевые ключи по договору; механика и webhook готовы до границы.
--  3) АВТОПРОДЛЕНИЕ: если включено и есть сохранённый способ оплаты, при
--     истечении оплаченного периода сами выставляем счёт. Оператор не бегает
--     за деньгами. Идемпотентность по external_id — двойной webhook не задвоит
--     баланс (критично для платежей!).
-- =====================================================================

-- способ оплаты, сохранённый клиентом для автопродления
CREATE TABLE IF NOT EXISTS billing_payment_method (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  provider      text NOT NULL,                  -- 'kaspi' / 'card' / 'manual'
  token         text,                            -- токен карты/номера у провайдера (не сам номер!)
  masked        text,                            -- «•••• 1234» для показа
  is_default    boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
ALTER TABLE billing_payment_method ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bpm_isolation ON billing_payment_method;
CREATE POLICY bpm_isolation ON billing_payment_method
  USING (account_id = current_setting('app.account_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON billing_payment_method TO shop_app;

-- СЧЁТ на оплату подписки
CREATE TABLE IF NOT EXISTS billing_invoice (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  amount        numeric(12,2) NOT NULL,
  provider      text NOT NULL,                  -- kaspi / card / manual
  external_id   text,                            -- id счёта у провайдера (идемпотентность)
  pay_url       text,                            -- ссылка/QR для оплаты
  status        text NOT NULL DEFAULT 'pending', -- pending / paid / expired / failed
  purpose       text NOT NULL DEFAULT 'topup',   -- topup / renew
  paid_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz
);
ALTER TABLE billing_invoice ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS binv_isolation ON billing_invoice;
CREATE POLICY binv_isolation ON billing_invoice
  USING (account_id = current_setting('app.account_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON billing_invoice TO shop_app;
CREATE INDEX IF NOT EXISTS idx_binv_account ON billing_invoice(account_id, created_at DESC);
-- идемпотентность: один external_id провайдера → один счёт
CREATE UNIQUE INDEX IF NOT EXISTS idx_binv_external ON billing_invoice(provider, external_id)
  WHERE external_id IS NOT NULL;

-- автопродление на подписке
ALTER TABLE subscription ADD COLUMN IF NOT EXISTS auto_renew boolean NOT NULL DEFAULT false;
ALTER TABLE subscription ADD COLUMN IF NOT EXISTS renew_method_id uuid REFERENCES billing_payment_method(id);

-- проведение оплаты счёта: атомарно помечаем оплаченным и пополняем баланс.
-- Идемпотентно: если счёт уже paid — не пополняем повторно (двойной webhook).
CREATE OR REPLACE FUNCTION apply_invoice_payment(p_invoice uuid)
RETURNS TABLE (applied boolean, new_balance numeric) LANGUAGE plpgsql AS $$
DECLARE inv billing_invoice; new_bal numeric;
BEGIN
  SELECT * INTO inv FROM billing_invoice WHERE id = p_invoice FOR UPDATE;
  IF inv IS NULL THEN RAISE EXCEPTION 'Счёт не найден'; END IF;
  IF inv.status = 'paid' THEN
    -- уже оплачен: повторный webhook — возвращаем текущий баланс, не пополняем
    SELECT balance INTO new_bal FROM subscription WHERE account_id = inv.account_id;
    RETURN QUERY SELECT false, new_bal;
    RETURN;
  END IF;

  UPDATE billing_invoice SET status = 'paid', paid_at = now() WHERE id = p_invoice;
  UPDATE subscription SET balance = balance + inv.amount
    WHERE account_id = inv.account_id RETURNING balance INTO new_bal;
  INSERT INTO billing_move (account_id, amount, kind, comment, balance_after)
    VALUES (inv.account_id, inv.amount, 'topup',
            'Онлайн-оплата (' || inv.provider || ')', new_bal);

  -- если аккаунт был заморожен и включён авторазмороз — оживляем
  UPDATE subscription SET status = 'active', frozen_at = NULL
    WHERE account_id = inv.account_id AND status = 'frozen' AND auto_unfreeze;

  RETURN QUERY SELECT true, new_bal;
END;
$$;

-- поиск счёта по external_id БЕЗ tenant-контекста: webhook приходит извне,
-- app.account_id не установлен. SECURITY DEFINER обходит RLS для этого
-- единственного безопасного поиска (по паре провайдер+external_id).
CREATE OR REPLACE FUNCTION find_invoice_by_external(p_provider text, p_external text)
RETURNS TABLE (id uuid, account_id uuid, status text)
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT id, account_id, status FROM billing_invoice
   WHERE provider = p_provider AND external_id = p_external;
$$;
GRANT EXECUTE ON FUNCTION find_invoice_by_external(text,text) TO shop_app;
