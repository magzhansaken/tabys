-- =====================================================================
-- 026_leads.sql — Часть 19: заявки с лендинга.
--
-- Лид — операторские данные (владелец SaaS), а не данные магазина:
-- account_id нет и RLS не нужна. Доступ на чтение — только по секретному
-- ключу оператора (env OPERATOR_KEY), запись — публичная форма с защитой
-- от спама (лимит по IP + honeypot в приложении).
-- =====================================================================
CREATE TABLE IF NOT EXISTS lead (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  phone       text NOT NULL,
  city        text,
  comment     text,
  source      text NOT NULL DEFAULT 'landing',   -- landing / landing_kk / referral…
  locale      text,                              -- ru / kk — на каком языке говорить при звонке
  ip          text,
  status      text NOT NULL DEFAULT 'new',       -- new / called / converted / spam
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lead_created_idx ON lead (created_at DESC);
GRANT SELECT, INSERT, UPDATE ON lead TO shop_app;
