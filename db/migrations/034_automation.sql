-- =====================================================================
-- 034_automation.sql — Часть 27: автоматизация и связь.
--
-- Разбор конкурентов:
--  • МойСклад: автоформирование отчётов (время + email), вебхуки (POST во
--    внешнюю систему при событии с {id, type}), сценарии (условие → действие,
--    до 100 активных). Всё это — платные опции у него.
--  • Wipon: встроенный чат техподдержки прямо в приложении; уведомления.
--  • UMAG: рассылки по остаткам.
--
-- НАШ ВЫВОД для магазина у дома:
--  1) Автоотчёт = вечерняя сводка владельцу (выручка/прибыль за день) на
--     email или в Telegram. Не «настрой шаблон» как у МоегоСклада, а готовая
--     полезная сводка одной галочкой — владелец не хочет конструктор.
--  2) Вебхуки — как у МоегоСклада (POST при событии), для тех, кто хочет
--     связать с внешней системой. Простые, с журналом доставки.
--  3) Сценарии упрощаем до «условие → уведомление»: магазину не нужны
--     резервы и задачи сборщику. «Мало товара → написать владельцу»,
--     «большой возврат → уведомить». Правила, а не язык программирования.
--  4) Новости в кабинете — канал оператора к клиентам (о фичах, изменениях
--     в законах КЗ). У Wipon это часть чатов.
--  5) Чат поддержки — переписка клиент↔оператор внутри кабинета (модель Wipon).
-- =====================================================================

-- ----- РАСПИСАНИЕ АВТООТЧЁТОВ -----
CREATE TABLE IF NOT EXISTS report_schedule (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  report        text NOT NULL,                  -- 'daily_summary' (пока одна, задел на другие)
  channel       text NOT NULL DEFAULT 'email',  -- email / telegram
  target        text NOT NULL,                  -- адрес email или chat_id телеграма
  send_at_hour  smallint NOT NULL DEFAULT 21,   -- час отправки (местное время точки)
  enabled       boolean NOT NULL DEFAULT true,
  last_sent_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE report_schedule ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS report_schedule_isolation ON report_schedule;
CREATE POLICY report_schedule_isolation ON report_schedule
  USING (account_id = current_setting('app.account_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON report_schedule TO shop_app;

-- ----- ВЕБХУКИ -----
CREATE TABLE IF NOT EXISTS webhook (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  url           text NOT NULL,
  events        text[] NOT NULL DEFAULT ARRAY['sale.created'],  -- на какие события
  secret        text,                           -- подпись HMAC (проверка подлинности)
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE webhook ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS webhook_isolation ON webhook;
CREATE POLICY webhook_isolation ON webhook
  USING (account_id = current_setting('app.account_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON webhook TO shop_app;

-- журнал доставки вебхуков (МоегоСклада нет — а без него не понять, дошло ли)
CREATE TABLE IF NOT EXISTS webhook_delivery (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  webhook_id    uuid NOT NULL REFERENCES webhook(id) ON DELETE CASCADE,
  event         text NOT NULL,
  payload       jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'pending', -- pending / ok / failed
  response_code integer,
  error         text,
  attempts      integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  delivered_at  timestamptz
);
ALTER TABLE webhook_delivery ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS webhook_delivery_isolation ON webhook_delivery;
CREATE POLICY webhook_delivery_isolation ON webhook_delivery
  USING (account_id = current_setting('app.account_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_delivery TO shop_app;
CREATE INDEX IF NOT EXISTS idx_wh_delivery ON webhook_delivery(account_id, created_at DESC);

-- ----- СЦЕНАРИИ (условие → уведомление) -----
CREATE TABLE IF NOT EXISTS scenario (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  name          text NOT NULL,
  trigger       text NOT NULL,                  -- 'low_stock' / 'big_refund' / 'shift_long'
  threshold     numeric(14,2),                  -- порог (мало товара < N, возврат > N ₸)
  action        text NOT NULL DEFAULT 'notify_owner', -- notify_owner / webhook
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE scenario ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scenario_isolation ON scenario;
CREATE POLICY scenario_isolation ON scenario
  USING (account_id = current_setting('app.account_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON scenario TO shop_app;

-- ----- НОВОСТИ (оператор → клиенты) -----
-- Глобальные, не под RLS аккаунта: оператор пишет всем. Клиенты только читают.
CREATE TABLE IF NOT EXISTS news_post (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title         text NOT NULL,
  body          text NOT NULL,
  is_important  boolean NOT NULL DEFAULT false,  -- важное подсвечивается
  published_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON news_post TO shop_app;

-- прочтения новостей на аккаунт (чтобы показывать «новое»)
CREATE TABLE IF NOT EXISTS news_read (
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  news_id       uuid NOT NULL REFERENCES news_post(id) ON DELETE CASCADE,
  read_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, news_id)
);
ALTER TABLE news_read ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS news_read_isolation ON news_read;
CREATE POLICY news_read_isolation ON news_read
  USING (account_id = current_setting('app.account_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON news_read TO shop_app;

-- ----- ЧАТ ПОДДЕРЖКИ (клиент ↔ оператор) -----
CREATE TABLE IF NOT EXISTS support_message (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  from_side     text NOT NULL,                  -- 'client' / 'operator'
  body          text NOT NULL,
  read_by_other boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE support_message ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS support_message_isolation ON support_message;
CREATE POLICY support_message_isolation ON support_message
  USING (account_id = current_setting('app.account_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON support_message TO shop_app;
CREATE INDEX IF NOT EXISTS idx_support_msg ON support_message(account_id, created_at);
