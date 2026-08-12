-- =====================================================================
-- 003_sync.sql — ПРОТОКОЛ СИНХРОНИЗАЦИИ
-- Решения и обоснования: docs/1.3_Решения_синхронизация.md
-- Принцип: синхронизируем СОБЫТИЯ, а не состояние. Порядок задаёт сервер
-- (часы устройств врут). Ничего не теряем: неприменимое → в карантин.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Доработка oplog из 001: нужна сплошная нумерация событий устройства
-- (чтобы видеть пропуски) и признак применения.
-- ---------------------------------------------------------------------
ALTER TABLE oplog ADD COLUMN client_seq bigint;          -- порядковый номер события НА УСТРОЙСТВЕ
ALTER TABLE oplog ADD COLUMN applied_at timestamptz;     -- когда событие применено к данным
ALTER TABLE oplog ADD COLUMN clock_skew_sec integer;     -- расхождение часов устройства с сервером
COMMENT ON COLUMN oplog.client_seq IS 'Сплошная нумерация на устройстве: дырка = касса отдала не всё';
COMMENT ON COLUMN oplog.clock_skew_sec IS 'Расхождение часов; порядок берём по seq, время клиента — только для людей';

-- Одно устройство не может дважды использовать один номер
CREATE UNIQUE INDEX oplog_device_seq_uniq ON oplog(device_id, client_seq)
  WHERE device_id IS NOT NULL AND client_seq IS NOT NULL;

-- ---------------------------------------------------------------------
-- КУРСОРЫ: докуда каждое устройство вычитало (pull) и что отдало (push).
-- ---------------------------------------------------------------------
CREATE TABLE sync_cursor (
  device_id        uuid PRIMARY KEY REFERENCES device(id) ON DELETE CASCADE,
  account_id       uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  pulled_seq       bigint NOT NULL DEFAULT 0,            -- докуда клиент забрал серверные события
  pushed_client_seq bigint NOT NULL DEFAULT 0,           -- последний принятый номер события устройства
  last_pull_at     timestamptz,
  last_push_at     timestamptz,
  snapshot_at      timestamptz,                          -- когда делали полную синхронизацию
  pending_hint     integer NOT NULL DEFAULT 0,           -- сколько событий клиент сам считает неотправленными
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON sync_cursor(account_id);

-- ---------------------------------------------------------------------
-- КАРАНТИН: событие, которое не удалось применить. Терять продажу молча
-- нельзя — у Wipon непереданные продажи просто пропадают вместе с папкой.
-- ---------------------------------------------------------------------
CREATE TABLE oplog_dead_letter (
  id            uuid PRIMARY KEY,                        -- тот же UUID, что у события
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  device_id     uuid REFERENCES device(id),
  entity        text NOT NULL,
  entity_id     uuid,
  op            oplog_op NOT NULL,
  payload       jsonb NOT NULL,
  error         text NOT NULL,
  attempts      integer NOT NULL DEFAULT 1,
  client_ts     timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_try_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  resolved_by   uuid REFERENCES employee(id)
);
CREATE INDEX ON oplog_dead_letter(account_id, resolved_at, first_seen_at DESC);

-- ---------------------------------------------------------------------
-- ЖУРНАЛ КОНФЛИКТОВ: справочники решаются правилом «последний победил»,
-- но владелец должен ВИДЕТЬ, что его правку цены перебила правка с кассы.
-- ---------------------------------------------------------------------
CREATE TABLE sync_conflict (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  entity        text NOT NULL,
  entity_id     uuid NOT NULL,
  winner_oplog  uuid,
  loser_oplog   uuid,
  winner_source text,                                    -- 'device:Касса 1' / 'admin:Айгуль'
  loser_source  text,
  fields        jsonb,                                   -- какие поля разошлись
  resolved_rule text NOT NULL DEFAULT 'last_write_wins',
  seen_at       timestamptz,                             -- владелец посмотрел
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON sync_conflict(account_id, created_at DESC);

-- ---------------------------------------------------------------------
-- RLS + права
-- ---------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sync_cursor','oplog_dead_letter','sync_conflict']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY tenant_isolation ON %I USING
      (account_id = nullif(current_setting('app.account_id', true), '')::uuid)$f$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO shop_app', t);
  END LOOP;
END $$;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO shop_app;

-- =====================================================================
-- ПРИЁМ СОБЫТИЯ (push). Идемпотентно: повтор того же UUID — не дубль.
-- Возвращает: accepted | duplicate.
-- =====================================================================
CREATE OR REPLACE FUNCTION sync_push_event(
  p_id uuid, p_account uuid, p_device uuid, p_employee uuid, p_store uuid,
  p_entity text, p_entity_id uuid, p_op oplog_op, p_payload jsonb,
  p_client_seq bigint, p_client_ts timestamptz)
RETURNS TABLE (result text, server_seq bigint)
SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE v_seq bigint; v_skew integer;
BEGIN
  -- повтор отправки (сеть моргнула, клиент не получил ответ) — не ошибка
  SELECT o.seq INTO v_seq FROM oplog o WHERE o.id = p_id;
  IF FOUND THEN
    RETURN QUERY SELECT 'duplicate'::text, v_seq; RETURN;
  END IF;

  v_skew := abs(extract(epoch FROM (now() - p_client_ts)))::integer;

  INSERT INTO oplog (id, account_id, device_id, employee_id, store_id,
                     entity, entity_id, op, payload, client_seq, client_ts, clock_skew_sec)
  VALUES (p_id, p_account, p_device, p_employee, p_store,
          p_entity, p_entity_id, p_op, p_payload, p_client_seq, p_client_ts, v_skew)
  RETURNING seq INTO v_seq;

  -- курсор устройства двигаем только вперёд
  INSERT INTO sync_cursor (device_id, account_id, pushed_client_seq, last_push_at)
  VALUES (p_device, p_account, coalesce(p_client_seq, 0), now())
  ON CONFLICT (device_id) DO UPDATE
    SET pushed_client_seq = greatest(sync_cursor.pushed_client_seq, coalesce(p_client_seq, 0)),
        last_push_at = now(), updated_at = now();

  RETURN QUERY SELECT 'accepted'::text, v_seq;
END $$;
REVOKE ALL ON FUNCTION sync_push_event(uuid,uuid,uuid,uuid,uuid,text,uuid,oplog_op,jsonb,bigint,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sync_push_event(uuid,uuid,uuid,uuid,uuid,text,uuid,oplog_op,jsonb,bigint,timestamptz) TO shop_app;

-- =====================================================================
-- ПРОВЕРКА ПОЛНОТЫ: отдало ли устройство все свои события.
-- Прямой ответ на предупреждение UMAG «остатки могут быть неточными»:
-- мы не гадаем, а точно знаем, есть ли дырка в нумерации.
-- =====================================================================
CREATE OR REPLACE FUNCTION sync_device_gaps(p_account uuid, p_device uuid)
RETURNS TABLE (missing_from bigint, missing_to bigint)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  WITH s AS (
    SELECT client_seq, lead(client_seq) OVER (ORDER BY client_seq) AS next_seq
    FROM oplog WHERE account_id = p_account AND device_id = p_device AND client_seq IS NOT NULL
  )
  SELECT client_seq + 1, next_seq - 1 FROM s WHERE next_seq > client_seq + 1;
$$;
REVOKE ALL ON FUNCTION sync_device_gaps(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sync_device_gaps(uuid,uuid) TO shop_app;

-- =====================================================================
-- ГОТОВНОСТЬ К ИНВЕНТАРИЗАЦИИ: все ли кассы точки отдали данные.
-- =====================================================================
CREATE OR REPLACE FUNCTION sync_readiness(p_account uuid, p_store uuid DEFAULT NULL)
RETURNS TABLE (device_id uuid, cash_register text, last_push_at timestamptz,
               pending_hint integer, has_gaps boolean, online_recently boolean)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT d.id, cr.name, sc.last_push_at, coalesce(sc.pending_hint, 0),
         EXISTS (SELECT 1 FROM sync_device_gaps(p_account, d.id)),
         d.last_seen_at > now() - interval '2 minutes'
  FROM device d
  LEFT JOIN cash_register cr ON cr.id = d.cash_register_id
  LEFT JOIN sync_cursor sc ON sc.device_id = d.id
  WHERE d.account_id = p_account AND d.deleted_at IS NULL AND d.token_hash IS NOT NULL
    AND (p_store IS NULL OR cr.store_id = p_store);
$$;
REVOKE ALL ON FUNCTION sync_readiness(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sync_readiness(uuid,uuid) TO shop_app;

-- =====================================================================
-- ЧИСТКА: журнал не должен расти вечно. Отставшая касса берёт снимок.
-- Вызывается по расписанию (Часть 14).
-- =====================================================================
CREATE OR REPLACE FUNCTION sync_prune_oplog(p_keep_days integer DEFAULT 90)
RETURNS integer SECURITY DEFINER SET search_path = public LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  -- не трогаем события, которые ещё не забрало хотя бы одно живое устройство
  WITH safe_point AS (
    SELECT account_id, min(pulled_seq) AS min_pulled FROM sync_cursor GROUP BY account_id
  )
  DELETE FROM oplog o USING safe_point sp
   WHERE o.account_id = sp.account_id
     AND o.seq <= sp.min_pulled
     AND o.server_ts < now() - (p_keep_days || ' days')::interval;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION sync_prune_oplog(integer) FROM PUBLIC;

-- =====================================================================
-- ИСПРАВЛЕНИЕ (найдено тестом): событие, ушедшее в карантин, не попадает
-- в oplog — и его номер навсегда остаётся «дыркой». Готовность к
-- инвентаризации тогда не наступит НИКОГДА: одно битое событие в марте
-- заблокировало бы проверку остатков до конца времён.
-- Карантин — это не потеря: событие доехало, лежит и видно владельцу.
-- Значит в подсчёте пропусков его номер обязан учитываться.
-- =====================================================================
ALTER TABLE oplog_dead_letter ADD COLUMN client_seq bigint;
COMMENT ON COLUMN oplog_dead_letter.client_seq IS 'Номер события на устройстве: чтобы карантин не выглядел пропуском';

CREATE OR REPLACE FUNCTION sync_device_gaps(p_account uuid, p_device uuid)
RETURNS TABLE (missing_from bigint, missing_to bigint)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  WITH all_seqs AS (
    SELECT client_seq FROM oplog
     WHERE account_id = p_account AND device_id = p_device AND client_seq IS NOT NULL
    UNION
    SELECT client_seq FROM oplog_dead_letter          -- доехало, но не применилось — это НЕ пропуск
     WHERE account_id = p_account AND device_id = p_device AND client_seq IS NOT NULL
  ), s AS (
    SELECT client_seq, lead(client_seq) OVER (ORDER BY client_seq) AS next_seq FROM all_seqs
  )
  SELECT client_seq + 1, next_seq - 1 FROM s WHERE next_seq > client_seq + 1;
$$;
REVOKE ALL ON FUNCTION sync_device_gaps(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sync_device_gaps(uuid,uuid) TO shop_app;
