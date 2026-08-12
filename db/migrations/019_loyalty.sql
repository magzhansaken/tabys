-- =====================================================================
-- 019_loyalty.sql — ЛОЯЛЬНОСТЬ И МАРКЕТИНГ
-- Решения: docs/10_Решения_лояльность.md
--
-- Эталон — Wipon Cashback. У UMAG модуля лояльности нет вообще: в карточке
-- покупателя есть поле «бонусы», но программы, которая их начисляет, нет.
-- Это наше видимое преимущество №2 после офлайна.
--
-- Бонусы — сумма движений (четвёртый раз тот же принцип: остатки 1.3,
-- долги Ч6, деньги Ч7). Касса офлайн присылает «+50», а не «баланс=300».
-- =====================================================================
CREATE TYPE loyalty_kind AS ENUM ('cashback','birthday','welcome');
CREATE TYPE bonus_reason AS ENUM (
  'earn',            -- начислено за покупку
  'spend',           -- списано в оплату
  'welcome',         -- приветственные
  'birthday',        -- ко дню рождения
  'expire',          -- сгорело
  'refund_return',   -- возврат покупки: бонусы вернулись назад
  'refund_revoke',   -- возврат покупки: начисленные бонусы отозваны
  'manual'           -- ручная правка с комментарием
);
CREATE TYPE promo_kind AS ENUM ('n_plus_one','happy_hours');

-- =====================================================================
-- ПРОГРАММА ЛОЯЛЬНОСТИ. Параметры и границы — из документации Wipon.
-- В отличие от них, всё входит в тариф: для магазина у дома лояльность —
-- единственный способ конкурировать с сетью через дорогу.
-- =====================================================================
CREATE TABLE loyalty_program (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  kind            loyalty_kind NOT NULL DEFAULT 'cashback',
  name            text NOT NULL,
  is_active       boolean NOT NULL DEFAULT true,

  -- накопительные бонусы (границы Wipon)
  earn_percent    numeric(5,2) NOT NULL DEFAULT 3,      -- 1–10%
  spend_percent   numeric(5,2) NOT NULL DEFAULT 50,     -- 5–90% от суммы чека
  max_spend       numeric(12,2) NOT NULL DEFAULT 5000,  -- 500–20 000 ₸
  min_purchase    numeric(12,2) NOT NULL DEFAULT 1000,  -- 1 000–100 000 ₸
  expire_days     integer NOT NULL DEFAULT 180,         -- 10–360 дней

  -- приветственные и день рождения (Wipon)
  bonus_amount    numeric(12,2),                        -- 10–5 000 ₸
  bonus_valid_days integer,                             -- ДР: 1–10, приветственные: 1–30

  -- отложенное начисление (у МоегоСклада платная опция)
  earn_delay_days integer NOT NULL DEFAULT 0,

  store_id        uuid REFERENCES store(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  seq             bigint NOT NULL DEFAULT nextval('global_seq'),

  -- границы из документации Wipon: не даём выставить бессмысленное
  CONSTRAINT earn_range CHECK (earn_percent >= 0 AND earn_percent <= 10),
  CONSTRAINT spend_range CHECK (spend_percent >= 0 AND spend_percent <= 90),
  CONSTRAINT expire_range CHECK (expire_days >= 10 AND expire_days <= 360)
);
CREATE INDEX ON loyalty_program(account_id, kind) WHERE deleted_at IS NULL AND is_active;

-- =====================================================================
-- ДВИЖЕНИЕ БОНУСОВ — ИСТОЧНИК ПРАВДЫ.
-- Каждое начисление живёт своей жизнью и сгорает в свой срок: списываем
-- всегда самые старые, иначе у клиента сгорит то, что он только что заработал.
-- =====================================================================
CREATE TABLE bonus_move (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  counterparty_id uuid NOT NULL REFERENCES counterparty(id) ON DELETE CASCADE,
  amount          numeric(12,2) NOT NULL,
  reason          bonus_reason NOT NULL,
  program_id      uuid REFERENCES loyalty_program(id),
  sale_id         uuid REFERENCES sale(id) ON DELETE SET NULL,
  employee_id     uuid REFERENCES employee(id),
  comment         text,
  -- срок жизни этого начисления
  expires_at      timestamptz,
  -- сколько от этого начисления уже израсходовано (списано или сгорело)
  used_amount     numeric(12,2) NOT NULL DEFAULT 0,
  ts              timestamptz NOT NULL DEFAULT now(),
  seq             bigint NOT NULL DEFAULT nextval('global_seq'),
  CONSTRAINT bonus_not_zero CHECK (amount <> 0)
);
CREATE INDEX ON bonus_move(account_id, counterparty_id, ts);
CREATE INDEX ON bonus_move(counterparty_id, expires_at) WHERE amount > 0;
CREATE INDEX ON bonus_move(sale_id);

CREATE TABLE bonus_balance (
  counterparty_id uuid PRIMARY KEY REFERENCES counterparty(id) ON DELETE CASCADE,
  account_id      uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  balance         numeric(12,2) NOT NULL DEFAULT 0,
  earned_total    numeric(12,2) NOT NULL DEFAULT 0,
  spent_total     numeric(12,2) NOT NULL DEFAULT 0,
  expired_total   numeric(12,2) NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON bonus_balance(account_id) WHERE balance > 0;

-- поля клиента для лояльности
ALTER TABLE counterparty ADD COLUMN IF NOT EXISTS birthday date;
ALTER TABLE counterparty ADD COLUMN IF NOT EXISTS loyalty_card text;   -- номер карты / QR
ALTER TABLE counterparty ADD COLUMN IF NOT EXISTS joined_loyalty_at timestamptz;
CREATE UNIQUE INDEX cp_loyalty_card_uniq ON counterparty(account_id, loyalty_card)
  WHERE loyalty_card IS NOT NULL AND deleted_at IS NULL;

-- =====================================================================
-- АКЦИИ: N+1 и счастливые часы.
-- Нет ни у Wipon, ни у UMAG, ни у МоегоСклада. При этом «третий кофе
-- бесплатно» и «с 14 до 16 выпечка −30%» — то, чем магазин у дома живёт.
-- =====================================================================
CREATE TABLE promo (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  kind          promo_kind NOT NULL,
  name          text NOT NULL,
  is_active     boolean NOT NULL DEFAULT true,

  -- на что действует
  product_id    uuid REFERENCES product(id),
  category_id   uuid REFERENCES category(id),
  store_id      uuid REFERENCES store(id),

  -- N+1: купи buy_qty — получи free_qty бесплатно
  buy_qty       integer,
  free_qty      integer DEFAULT 1,

  -- счастливые часы: скидка в заданное время
  percent       numeric(5,2),
  hour_from     smallint,                      -- 0–23
  hour_to       smallint,
  weekdays      smallint[],                    -- 1=пн … 7=вс; пусто = все дни

  starts_at     timestamptz,
  ends_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  seq           bigint NOT NULL DEFAULT nextval('global_seq'),
  CONSTRAINT promo_target CHECK (product_id IS NOT NULL OR category_id IS NOT NULL),
  CONSTRAINT promo_hours CHECK (hour_from IS NULL OR (hour_from BETWEEN 0 AND 23 AND hour_to BETWEEN 0 AND 24))
);
CREATE INDEX ON promo(account_id, kind) WHERE deleted_at IS NULL AND is_active;

-- =====================================================================
-- СЕГМЕНТЫ (Wipon: название и цвет). Плюс автоматические по поведению —
-- ручные работают, пока клиентов сорок.
-- =====================================================================
CREATE TABLE segment (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  name          text NOT NULL,
  color         text NOT NULL DEFAULT '#7C3AED',
  auto_rule     text,                          -- 'lapsed' / 'regular' / 'big_check' / 'new'
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  seq           bigint NOT NULL DEFAULT nextval('global_seq'),
  UNIQUE (account_id, name)
);

CREATE TABLE segment_member (
  segment_id      uuid NOT NULL REFERENCES segment(id) ON DELETE CASCADE,
  counterparty_id uuid NOT NULL REFERENCES counterparty(id) ON DELETE CASCADE,
  account_id      uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  added_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (segment_id, counterparty_id)
);

-- =====================================================================
-- РАССЫЛКИ. Стоимость считается ДО отправки: у Wipon «на основе количества
-- клиентов и длины и языка текста». Язык важен: латиница — 160 символов в
-- сегменте, кириллица — 67. Русский текст стоит вдвое дороже.
-- =====================================================================
CREATE TABLE campaign (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  name          text NOT NULL,
  channel       text NOT NULL DEFAULT 'sms',   -- sms / whatsapp
  text          text NOT NULL,
  segment_id    uuid REFERENCES segment(id),
  status        text NOT NULL DEFAULT 'draft', -- draft / sending / sent / failed
  recipients    integer NOT NULL DEFAULT 0,
  segments_per_sms integer,                    -- на сколько SMS разобьётся текст
  cost_estimate numeric(12,2),
  cost_actual   numeric(12,2),
  sent_count    integer NOT NULL DEFAULT 0,
  failed_count  integer NOT NULL DEFAULT 0,
  employee_id   uuid REFERENCES employee(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz,
  seq           bigint NOT NULL DEFAULT nextval('global_seq')
);
CREATE INDEX ON campaign(account_id, created_at DESC);

CREATE TABLE campaign_recipient (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  campaign_id   uuid NOT NULL REFERENCES campaign(id) ON DELETE CASCADE,
  counterparty_id uuid REFERENCES counterparty(id),
  phone         text NOT NULL,
  status        text NOT NULL DEFAULT 'pending',
  error         text,
  sent_at       timestamptz,
  UNIQUE (campaign_id, phone)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['loyalty_program','bonus_move','bonus_balance','promo','segment',
                           'segment_member','campaign','campaign_recipient']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY tenant_isolation ON %I USING
      (account_id = nullif(current_setting('app.account_id', true), '')::uuid)$f$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO shop_app', t);
  END LOOP;
END $$;
CREATE TRIGGER loyalty_touch BEFORE UPDATE ON loyalty_program FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER promo_touch BEFORE UPDATE ON promo FOR EACH ROW EXECUTE FUNCTION touch_row();
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO shop_app;

-- =====================================================================
-- НАЧИСЛЕНИЕ БОНУСОВ
-- =====================================================================
CREATE OR REPLACE FUNCTION apply_bonus_move(
  p_account uuid, p_cp uuid, p_amount numeric, p_reason bonus_reason,
  p_program uuid DEFAULT NULL, p_sale uuid DEFAULT NULL, p_employee uuid DEFAULT NULL,
  p_comment text DEFAULT NULL, p_expires timestamptz DEFAULT NULL)
RETURNS TABLE (move_id uuid, new_balance numeric)
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE v_move uuid; v_bal numeric;
BEGIN
  INSERT INTO bonus_move (account_id, counterparty_id, amount, reason, program_id, sale_id,
                          employee_id, comment, expires_at)
  VALUES (p_account, p_cp, p_amount, p_reason, p_program, p_sale, p_employee, p_comment, p_expires)
  RETURNING id INTO v_move;

  INSERT INTO bonus_balance (counterparty_id, account_id, balance, earned_total, spent_total, expired_total)
  VALUES (p_cp, p_account, p_amount,
          CASE WHEN p_amount > 0 AND p_reason <> 'refund_return' THEN p_amount ELSE 0 END,
          CASE WHEN p_amount < 0 AND p_reason = 'spend' THEN -p_amount ELSE 0 END,
          CASE WHEN p_amount < 0 AND p_reason = 'expire' THEN -p_amount ELSE 0 END)
  ON CONFLICT (counterparty_id) DO UPDATE SET
    balance = bonus_balance.balance + p_amount,
    earned_total = bonus_balance.earned_total + CASE WHEN p_amount > 0 AND p_reason <> 'refund_return' THEN p_amount ELSE 0 END,
    spent_total = bonus_balance.spent_total + CASE WHEN p_amount < 0 AND p_reason = 'spend' THEN -p_amount ELSE 0 END,
    expired_total = bonus_balance.expired_total + CASE WHEN p_amount < 0 AND p_reason = 'expire' THEN -p_amount ELSE 0 END,
    updated_at = now()
  RETURNING balance INTO v_bal;

  RETURN QUERY SELECT v_move, v_bal;
END $$;
GRANT EXECUTE ON FUNCTION apply_bonus_move(uuid,uuid,numeric,bonus_reason,uuid,uuid,uuid,text,timestamptz) TO shop_app;

CREATE OR REPLACE FUNCTION recalc_bonus_balance(p_account uuid, p_cp uuid DEFAULT NULL)
RETURNS integer SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  WITH sums AS (
    SELECT counterparty_id, sum(amount) AS s FROM bonus_move
     WHERE account_id = p_account AND (p_cp IS NULL OR counterparty_id = p_cp)
     GROUP BY counterparty_id
  )
  UPDATE bonus_balance b SET balance = sums.s, updated_at = now()
    FROM sums WHERE b.counterparty_id = sums.counterparty_id AND b.balance IS DISTINCT FROM sums.s;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
GRANT EXECUTE ON FUNCTION recalc_bonus_balance(uuid,uuid) TO shop_app;

-- =====================================================================
-- СПИСАНИЕ БОНУСОВ ПО FIFO: тратим самые старые начисления.
-- Иначе у клиента сгорит то, что он только что заработал, а потратится
-- то, что могло бы полежать.
-- =====================================================================
CREATE OR REPLACE FUNCTION spend_bonuses(p_account uuid, p_cp uuid, p_amount numeric,
                                         p_sale uuid DEFAULT NULL, p_employee uuid DEFAULT NULL)
RETURNS TABLE (spent numeric, new_balance numeric)
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE r record; left_to_spend numeric := p_amount; take numeric; v_bal numeric;
BEGIN
  -- Тратим начисления по очереди: сначала те, что сгорят раньше. Иначе у
  -- клиента сгорит только что заработанное, а потратится то, что могло полежать.
  FOR r IN
    SELECT id, amount - used_amount AS available FROM bonus_move
     WHERE account_id = p_account AND counterparty_id = p_cp AND amount > 0
       AND amount > used_amount
       AND (expires_at IS NULL OR expires_at > now())
     ORDER BY expires_at NULLS LAST, ts
  LOOP
    EXIT WHEN left_to_spend <= 0;
    take := least(r.available, left_to_spend);
    UPDATE bonus_move SET used_amount = used_amount + take WHERE id = r.id;
    left_to_spend := left_to_spend - take;
  END LOOP;

  IF left_to_spend > 0 THEN
    RAISE EXCEPTION 'Недостаточно бонусов: не хватает %', left_to_spend;
  END IF;

  PERFORM apply_bonus_move(p_account, p_cp, -p_amount, 'spend', NULL, p_sale, p_employee);
  SELECT balance INTO v_bal FROM bonus_balance WHERE counterparty_id = p_cp;
  RETURN QUERY SELECT p_amount, v_bal;
END $$;
GRANT EXECUTE ON FUNCTION spend_bonuses(uuid,uuid,numeric,uuid,uuid) TO shop_app;


-- =====================================================================
-- СГОРАНИЕ БОНУСОВ. Запускается по расписанию.
-- =====================================================================
CREATE OR REPLACE FUNCTION expire_bonuses(p_account uuid)
RETURNS TABLE (cp_id uuid, expired numeric)
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT bm.counterparty_id AS cp, sum(bm.amount - bm.used_amount) AS burn
      FROM bonus_move bm
     WHERE bm.account_id = p_account AND bm.amount > 0 AND bm.amount > bm.used_amount
       AND bm.expires_at IS NOT NULL AND bm.expires_at <= now()
     GROUP BY bm.counterparty_id
  LOOP
    UPDATE bonus_move SET used_amount = amount
     WHERE account_id = p_account AND counterparty_id = r.cp
       AND amount > used_amount AND expires_at IS NOT NULL AND expires_at <= now();
    PERFORM apply_bonus_move(p_account, r.cp, -r.burn, 'expire', NULL, NULL, NULL, 'Срок действия истёк');
    cp_id := r.cp; expired := r.burn;
    RETURN NEXT;
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION expire_bonuses(uuid) TO shop_app;

-- Сколько сгорит в ближайшие дни: клиенту это важно знать заранее
CREATE OR REPLACE FUNCTION bonuses_expiring(p_account uuid, p_days integer DEFAULT 14)
RETURNS TABLE (counterparty_id uuid, name text, phone text, amount numeric, expires_at timestamptz)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT c.id, c.name, c.phone, sum(bm.amount - bm.used_amount), min(bm.expires_at)
    FROM bonus_move bm JOIN counterparty c ON c.id = bm.counterparty_id
   WHERE bm.account_id = p_account AND bm.amount > bm.used_amount AND bm.amount > 0
     AND bm.expires_at IS NOT NULL
     AND bm.expires_at > now() AND bm.expires_at <= now() + (p_days || ' days')::interval
   GROUP BY c.id, c.name, c.phone
  HAVING sum(bm.amount - bm.used_amount) > 0
   ORDER BY 5;
$$;
GRANT EXECUTE ON FUNCTION bonuses_expiring(uuid,integer) TO shop_app;

-- Именинники: бонусы начисляются автоматически в день рождения (Wipon)
CREATE OR REPLACE FUNCTION birthday_clients(p_account uuid)
RETURNS TABLE (counterparty_id uuid, name text, phone text, birthday date)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT c.id, c.name, c.phone, c.birthday
    FROM counterparty c
   WHERE c.account_id = p_account AND c.deleted_at IS NULL AND c.birthday IS NOT NULL
     AND extract(month FROM c.birthday) = extract(month FROM current_date)
     AND extract(day FROM c.birthday) = extract(day FROM current_date)
     -- второй раз в тот же день не начисляем
     AND NOT EXISTS (SELECT 1 FROM bonus_move bm WHERE bm.counterparty_id = c.id
                      AND bm.reason = 'birthday' AND bm.ts::date = current_date);
$$;
GRANT EXECUTE ON FUNCTION birthday_clients(uuid) TO shop_app;

-- =====================================================================
-- АНАЛИТИКА ЛОЯЛЬНОСТИ (показатели Wipon, кроме пола и возраста —
-- их пришлось бы спрашивать у покупателя)
-- =====================================================================
CREATE OR REPLACE FUNCTION loyalty_analytics(p_account uuid, p_from timestamptz, p_to timestamptz)
RETURNS TABLE (earned numeric, spent numeric, expired numeric,
               clients_total integer, clients_active integer, clients_with_bonuses integer,
               sales_with_card integer, sales_total integer,
               avg_check_card numeric, avg_check_anon numeric, bonus_share numeric)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  WITH b AS (
    SELECT coalesce(sum(amount) FILTER (WHERE amount > 0 AND reason IN ('earn','welcome','birthday')), 0) AS e,
           coalesce(sum(-amount) FILTER (WHERE reason = 'spend'), 0) AS s,
           coalesce(sum(-amount) FILTER (WHERE reason = 'expire'), 0) AS x
      FROM bonus_move WHERE account_id = p_account AND ts >= p_from AND ts <= p_to
  ),
  sc AS (
    SELECT count(*) FILTER (WHERE customer_id IS NOT NULL)::integer AS with_card,
           count(*)::integer AS total,
           coalesce(avg(total) FILTER (WHERE customer_id IS NOT NULL), 0) AS avg_card,
           coalesce(avg(total) FILTER (WHERE customer_id IS NULL), 0) AS avg_anon
      FROM sale WHERE account_id = p_account AND status = 'completed' AND return_of_id IS NULL
        AND completed_at >= p_from AND completed_at <= p_to
  )
  SELECT (SELECT e FROM b), (SELECT s FROM b), (SELECT x FROM b),
         (SELECT count(*)::integer FROM counterparty WHERE account_id = p_account
            AND is_customer AND deleted_at IS NULL),
         (SELECT count(DISTINCT customer_id)::integer FROM sale WHERE account_id = p_account
            AND customer_id IS NOT NULL AND completed_at >= p_from AND completed_at <= p_to),
         (SELECT count(*)::integer FROM bonus_balance WHERE account_id = p_account AND balance > 0),
         (SELECT with_card FROM sc), (SELECT total FROM sc),
         round((SELECT avg_card FROM sc)::numeric, 2), round((SELECT avg_anon FROM sc)::numeric, 2),
         CASE WHEN (SELECT total FROM sc) > 0
           THEN round(((SELECT with_card FROM sc)::numeric / (SELECT total FROM sc) * 100), 1) ELSE 0 END;
$$;
GRANT EXECUTE ON FUNCTION loyalty_analytics(uuid,timestamptz,timestamptz) TO shop_app;

-- =====================================================================
-- ОПЛАТА БОНУСАМИ В ЧЕКЕ.
-- Нашла проверка: в Части 4 способ оплаты 'bonus' заложен в перечислении,
-- но в чеке не было поля под эту сумму — оплата бонусами нигде не оседала.
-- Без него нельзя ни начислить правильно (бонусы на бонусы — вечный
-- двигатель), ни свести отчёты.
-- =====================================================================
ALTER TABLE sale ADD COLUMN IF NOT EXISTS paid_bonus numeric(14,2) NOT NULL DEFAULT 0;
COMMENT ON COLUMN sale.paid_bonus IS 'Оплачено бонусами: на эту часть чека бонусы не начисляются';
