-- =====================================================================
-- 018_documents.sql — ДОКУМЕНТЫ КАЗАХСТАНА
-- Решения: docs/9_Решения_документы_КЗ.md
--
-- Единственный эталон здесь — Wipon: у UMAG документов КЗ нет вообще,
-- у МоегоСклада конструктор форм и российская маркировка.
--
-- ЭСФ выписывается ИЗ документа, а не набивается руками (у Wipon
-- «заполнить все необходимые поля»): контрагент, позиции, суммы и НДС уже
-- есть в системе — владелец проверяет, а не вводит второй раз.
-- =====================================================================
CREATE TYPE gov_doc_kind AS ENUM ('esf','snt','avr','poa','invoice');
CREATE TYPE gov_doc_status AS ENUM ('draft','signing','sending','sent','delivered','rejected','revoked','cancelled');
CREATE TYPE esf_direction AS ENUM ('issued','received');

-- =====================================================================
-- ЭЦП: ключ НУЦ РК.
-- Wipon: «Добавить и подписать ЭЦП ключ. Также вписать пароль от портала ЭСФ».
-- Пароль от самого ключа по умолчанию НЕ храним — владелец вводит при
-- отправке. Если просит запомнить, честно предупреждаем, что это его риск.
-- =====================================================================
CREATE TABLE gov_key (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organization(id) ON DELETE CASCADE,
  name            text NOT NULL,
  key_data        bytea,                       -- сам .p12, зашифрован
  key_password_enc bytea,                      -- только если владелец попросил запомнить
  store_password  boolean NOT NULL DEFAULT false,
  esf_login       text,                        -- логин портала ИС ЭСФ
  esf_password_enc bytea,                      -- пароль портала (Wipon хранит его же)
  subject_bin     text,                        -- БИН/ИИН владельца ключа
  subject_name    text,
  valid_from      timestamptz,
  valid_until     timestamptz,                 -- ключ живёт год: предупреждаем за 30 дней
  is_active       boolean NOT NULL DEFAULT true,
  last_used_at    timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  seq             bigint NOT NULL DEFAULT nextval('global_seq')
);
CREATE INDEX ON gov_key(account_id) WHERE deleted_at IS NULL;

-- =====================================================================
-- ГОСУДАРСТВЕННЫЙ ДОКУМЕНТ (ЭСФ / СНТ / АВР / доверенность).
-- Одна таблица с видом: у всех одна судьба — черновик, подпись, отправка
-- в ОГД, ответ, отзыв.
-- =====================================================================
CREATE TABLE gov_doc (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organization(id),
  kind            gov_doc_kind NOT NULL,
  direction       esf_direction NOT NULL DEFAULT 'issued',
  status          gov_doc_status NOT NULL DEFAULT 'draft',
  number          text NOT NULL,               -- наш номер
  gov_number      text,                        -- регистрационный номер в ИС ЭСФ
  gov_id          text,                        -- идентификатор документа на портале

  counterparty_id uuid REFERENCES counterparty(id),
  sale_id         uuid REFERENCES sale(id) ON DELETE SET NULL,
  doc_id          uuid REFERENCES stock_doc(id) ON DELETE SET NULL,   -- приёмка-основание
  parent_id       uuid REFERENCES gov_doc(id),  -- исправленный/дополнительный ЭСФ

  issue_date      date NOT NULL DEFAULT current_date,
  turnover_date   date,                        -- дата совершения оборота
  total_sum       numeric(14,2) NOT NULL DEFAULT 0,
  vat_sum         numeric(14,2) NOT NULL DEFAULT 0,
  currency        text NOT NULL DEFAULT 'KZT',

  payload         jsonb NOT NULL DEFAULT '{}', -- тело документа
  signed_xml      text,                        -- подписанное представление
  gov_response    jsonb,
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  next_try_at     timestamptz,
  sent_at         timestamptz,
  delivered_at    timestamptz,
  revoked_at      timestamptz,
  revoke_reason   text,

  employee_id     uuid REFERENCES employee(id),
  comment         text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  seq             bigint NOT NULL DEFAULT nextval('global_seq')
);
CREATE UNIQUE INDEX gov_doc_number_uniq ON gov_doc(account_id, kind, number) WHERE deleted_at IS NULL;
CREATE INDEX ON gov_doc(account_id, kind, status, issue_date DESC);
CREATE INDEX ON gov_doc(account_id, counterparty_id);
CREATE INDEX ON gov_doc(status, next_try_at) WHERE status IN ('sending','draft');
-- один документ на одну продажу/приёмку: повторная выписка не задваивает ЭСФ
CREATE UNIQUE INDEX gov_doc_sale_uniq ON gov_doc(sale_id, kind) WHERE sale_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX gov_doc_doc_uniq ON gov_doc(doc_id, kind) WHERE doc_id IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE gov_doc_item (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  gov_doc_id    uuid NOT NULL REFERENCES gov_doc(id) ON DELETE CASCADE,
  line_no       integer NOT NULL,
  product_id    uuid REFERENCES product(id),
  name          text NOT NULL,
  ntin          text,                          -- код НКТ: обязателен в ЭСФ РК
  unit_code     text,                          -- код единицы по классификатору
  qty           numeric(14,3) NOT NULL,
  price         numeric(14,2) NOT NULL,
  total_wo_vat  numeric(14,2) NOT NULL,
  vat_rate      numeric(5,2),
  vat_sum       numeric(14,2) NOT NULL DEFAULT 0,
  total_with_vat numeric(14,2) NOT NULL,
  tnved         text,                          -- код ТН ВЭД для СНТ
  origin_code   text,                          -- признак происхождения товара
  seq           bigint NOT NULL DEFAULT nextval('global_seq'),
  UNIQUE (gov_doc_id, line_no)
);
CREATE INDEX ON gov_doc_item(gov_doc_id);

-- =====================================================================
-- МАРКИРОВКА: код Data Matrix.
-- У Wipon Ismet «в разработке», у МоегоСклада — российский Честный знак.
-- В Казахстане маркировка обязательна для табака, алкоголя, обуви.
-- =====================================================================
CREATE TABLE marking_code (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  code          text NOT NULL,                 -- полный код Data Matrix
  gtin          text,                          -- товарный код внутри кода
  serial        text,                          -- серийный номер экземпляра
  product_id    uuid REFERENCES product(id),
  status        text NOT NULL DEFAULT 'in_stock',  -- in_stock / sold / returned / written_off
  doc_id        uuid REFERENCES stock_doc(id),     -- каким документом приняли
  sale_id       uuid REFERENCES sale(id),          -- каким чеком продали
  sold_at       timestamptz,
  reported_at   timestamptz,                   -- когда сообщили о выводе из оборота
  created_at    timestamptz NOT NULL DEFAULT now(),
  seq           bigint NOT NULL DEFAULT nextval('global_seq')
);
CREATE UNIQUE INDEX marking_code_uniq ON marking_code(account_id, code);
CREATE INDEX ON marking_code(account_id, status);
CREATE INDEX ON marking_code(product_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['gov_key','gov_doc','gov_doc_item','marking_code']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY tenant_isolation ON %I USING
      (account_id = nullif(current_setting('app.account_id', true), '')::uuid)$f$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO shop_app', t);
  END LOOP;
END $$;
CREATE TRIGGER gov_key_touch BEFORE UPDATE ON gov_key FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER gov_doc_touch BEFORE UPDATE ON gov_doc FOR EACH ROW EXECUTE FUNCTION touch_row();
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO shop_app;

-- =====================================================================
-- НОМЕР ДОКУМЕНТА: у ЭСФ своя нумерация, у СНТ своя
-- =====================================================================
CREATE OR REPLACE FUNCTION next_gov_number(p_account uuid, p_kind gov_doc_kind)
RETURNS text SECURITY DEFINER SET search_path = public LANGUAGE sql AS $$
  SELECT coalesce(max(nullif(regexp_replace(number, '\D', '', 'g'), '')::bigint), 0) + 1
    FROM gov_doc WHERE account_id = p_account AND kind = p_kind AND deleted_at IS NULL;
$$;
GRANT EXECUTE ON FUNCTION next_gov_number(uuid,gov_doc_kind) TO shop_app;

-- =====================================================================
-- СРОК ДЕЙСТВИЯ ЭЦП. Ключ живёт год; просроченный — это не «ошибка входа»,
-- а невыписанный ЭСФ, а срок выписки по НК РК ограничен.
-- =====================================================================
CREATE OR REPLACE FUNCTION gov_key_health(p_account uuid)
RETURNS TABLE (key_id uuid, name text, subject_bin text, valid_until timestamptz,
               days_left integer, status text, message text)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT k.id, k.name, k.subject_bin, k.valid_until,
         CASE WHEN k.valid_until IS NULL THEN NULL
           ELSE (extract(epoch FROM (k.valid_until - now())) / 86400)::integer END,
         CASE
           WHEN k.valid_until IS NULL THEN 'unknown'
           WHEN k.valid_until < now() THEN 'expired'
           WHEN k.valid_until < now() + interval '30 days' THEN 'expiring'
           ELSE 'ok'
         END,
         CASE
           WHEN k.valid_until IS NULL THEN 'Срок действия ключа неизвестен'
           WHEN k.valid_until < now() THEN 'Ключ ЭЦП просрочен — документы не уйдут в налоговую'
           WHEN k.valid_until < now() + interval '30 days' THEN
             'Ключ ЭЦП истекает через ' || (extract(epoch FROM (k.valid_until - now())) / 86400)::integer
             || ' дн. — обновите заранее'
           ELSE 'Ключ действует'
         END
    FROM gov_key k
   WHERE k.account_id = p_account AND k.deleted_at IS NULL AND k.is_active;
$$;
GRANT EXECUTE ON FUNCTION gov_key_health(uuid) TO shop_app;

-- =====================================================================
-- НАЛОГОВЫЕ РЕГИСТРЫ (список Wipon).
-- Три из четырёх строим из своих данных; регистр по ИПН требует модуля
-- зарплаты — вопрос открыт.
-- =====================================================================

-- «Налоговый регистр по учёту доходов, в том числе полученных путём
-- безналичных расчётов» — для ИП на упрощёнке это основа формы 910.00
CREATE OR REPLACE FUNCTION tax_register_income(p_account uuid, p_from date, p_to date)
RETURNS TABLE (day date, receipts integer, total numeric, cash numeric, cashless numeric, credit numeric)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT s.completed_at::date,
         count(*) FILTER (WHERE s.return_of_id IS NULL)::integer,
         coalesce(sum(s.total) FILTER (WHERE s.return_of_id IS NULL), 0)
           - coalesce(sum(s.total) FILTER (WHERE s.return_of_id IS NOT NULL), 0),
         coalesce(sum(s.paid_cash) FILTER (WHERE s.return_of_id IS NULL), 0)
           - coalesce(sum(s.paid_cash) FILTER (WHERE s.return_of_id IS NOT NULL), 0),
         -- безнал отдельно: именно его в РК спрашивают в первую очередь
         coalesce(sum(s.paid_card + s.paid_qr) FILTER (WHERE s.return_of_id IS NULL), 0)
           - coalesce(sum(s.paid_card + s.paid_qr) FILTER (WHERE s.return_of_id IS NOT NULL), 0),
         coalesce(sum(s.paid_credit) FILTER (WHERE s.return_of_id IS NULL), 0)
    FROM sale s
   WHERE s.account_id = p_account AND s.status IN ('completed','returned')
     AND s.completed_at::date >= p_from AND s.completed_at::date <= p_to
   GROUP BY s.completed_at::date ORDER BY 1;
$$;
GRANT EXECUTE ON FUNCTION tax_register_income(uuid,date,date) TO shop_app;

-- «Налоговый регистр по учёту приобретённых товаров, работ и услуг»
CREATE OR REPLACE FUNCTION tax_register_purchases(p_account uuid, p_from date, p_to date)
RETURNS TABLE (doc_date date, doc_number integer, supplier text, supplier_bin text,
               total numeric, esf_number text)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT d.processed_at::date, d.number, c.name, c.iin_bin, d.total_sum,
         (SELECT gd.gov_number FROM gov_doc gd
           WHERE gd.doc_id = d.id AND gd.kind = 'esf' AND gd.deleted_at IS NULL LIMIT 1)
    FROM stock_doc d
    LEFT JOIN counterparty c ON c.id = d.supplier_id
   WHERE d.account_id = p_account AND d.kind = 'supply' AND d.status = 'done'
     AND d.processed_at::date >= p_from AND d.processed_at::date <= p_to
   ORDER BY d.processed_at;
$$;
GRANT EXECUTE ON FUNCTION tax_register_purchases(uuid,date,date) TO shop_app;

-- =====================================================================
-- РЕКВИЗИТЫ СОТРУДНИКА ДЛЯ ДОВЕРЕННОСТИ.
-- Нашла проверка: доверенность формы М-2 требует ИИН и удостоверение
-- личности поверенного — без них поставщик товар не отдаст. В схеме
-- сотрудника этих полей не было.
-- =====================================================================
ALTER TABLE employee ADD COLUMN IF NOT EXISTS iin text;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS id_doc_number text;      -- удостоверение личности
ALTER TABLE employee ADD COLUMN IF NOT EXISTS id_doc_issued_by text;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS id_doc_issued_at date;
COMMENT ON COLUMN employee.iin IS 'ИИН: обязателен в доверенности М-2, без него поставщик товар не отдаст';
