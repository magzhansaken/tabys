-- ЗАЯВКА НА НОВЫЙ МАГАЗИН ОТ ПАРТНЁРА.
--
-- Партнёр заводил магазины СРАЗУ, без спроса: никто не видел, сколько
-- их и настоящие ли они. Можно было завести десять пустых и показывать
-- как свою работу, или подключить клиента, который уже есть у другого
-- партнёра.
--
-- И наоборот: партнёр не мог ПОКАЗАТЬ работу — он завёл клиента, а
-- сказать об этом некому.
--
-- Теперь заявка ложится в тот же ящик, что и остальные. Но у неё нет
-- магазина: он появится ТОЛЬКО после одобрения. Значит ссылка на
-- магазин должна пускать пустоту.

ALTER TABLE tenant_request ALTER COLUMN account_id DROP NOT NULL;

-- ВИД ЗАЯВКИ. Список видов не знал нового, и заявка не ложилась вовсе:
-- сервер отвечал «Internal server error», а понять было нечем.
--
-- Собираем список заново, добавив new_tenant. Старые виды берём из
-- нынешней проверки, чтобы ничего не потерять.
ALTER TABLE tenant_request DROP CONSTRAINT IF EXISTS tenant_request_kind_check;
ALTER TABLE tenant_request ADD CONSTRAINT tenant_request_kind_check
  CHECK (kind IN ('device', 'tariff', 'grace', 'other', 'new_tenant'));

-- И проверка: пустой магазин бывает только у заявки на нового клиента.
-- У остальных видов он обязателен — иначе непонятно, кого правим.
ALTER TABLE tenant_request DROP CONSTRAINT IF EXISTS tenant_request_account_needed;
ALTER TABLE tenant_request ADD CONSTRAINT tenant_request_account_needed
  CHECK (account_id IS NOT NULL OR kind = 'new_tenant');

COMMENT ON COLUMN tenant_request.account_id IS
  'Магазин заявки. Пусто только у new_tenant: магазина ещё нет, он появится при одобрении';


-- ОТОЗВАННАЯ ЗАЯВКА. Партнёр передумал: клиент отказался, телефон
-- записан неверно. Без такого состояния заявка висит вечно, и владелец
-- платформы разбирает мусор.
ALTER TABLE tenant_request DROP CONSTRAINT IF EXISTS tenant_request_status_check;
ALTER TABLE tenant_request ADD CONSTRAINT tenant_request_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn'));

-- СПИСОК ЗАЯВОК ПОКАЗЫВАЕТ И ЗАЯВКУ БЕЗ МАГАЗИНА.
--
-- Свёртка сцепляла заявку с магазином через JOIN — и заявка на НОВОГО
-- клиента пропадала: магазина у неё ещё нет, он появится при одобрении.
--
-- Партнёр отправлял заявку, получал «отправлено», а владелец платформы
-- не видел её НИКОГДА. Найдено живьём.
--
-- Меняем на LEFT JOIN и подставляем название из самой заявки: владелец
-- должен видеть, какой магазин просят завести.
-- ПОРЯДОК ДОВОДОВ КАК У ПРЕЖНЕЙ: сперва статус, потом роль и ключ.
-- Завёл вторую свёртку с другим порядком — база не смогла выбрать
-- между ними и падала: «function is not unique».
CREATE OR REPLACE FUNCTION platform_requests(p_status text, p_role text, p_user uuid)
RETURNS TABLE (
  decided_by_name text, id uuid, kind text, payload jsonb, comment text,
  status text, decision_note text, created_at timestamptz, decided_at timestamptz,
  client text, account_id uuid, author text, monthly bigint,
  paid_until timestamptz, days_left int, pending_amount bigint
)
SECURITY DEFINER SET search_path = public LANGUAGE sql AS $$
  SELECT pu2.full_name, tr.id, tr.kind, tr.payload, tr.comment, tr.status,
         tr.decision_note, tr.created_at, tr.decided_at,
         -- Названия магазина ещё нет — берём из заявки.
         coalesce(a.name, tr.payload->>'name'),
         a.id, pu.full_name,
         coalesce(platform_monthly(a.id), 0)::bigint,
         s.paid_until,
         CASE WHEN s.paid_until IS NULL THEN NULL
              ELSE ceil(extract(epoch FROM s.paid_until - now()) / 86400)::int END,
         coalesce((SELECT sum(tp.amount) FROM tenant_payment tp
            WHERE tp.account_id = a.id AND tp.status = 'pending'), 0)::bigint
    FROM tenant_request tr
    LEFT JOIN account a ON a.id = tr.account_id
    LEFT JOIN platform_user pu2 ON pu2.id = tr.decided_by
    LEFT JOIN platform_user pu ON pu.id = tr.created_by
    LEFT JOIN subscription s ON s.account_id = a.id
   WHERE (p_status IS NULL OR tr.status = p_status)
     AND (p_role = 'super' OR EXISTS (
           SELECT 1 FROM tenant_card tc
            WHERE tc.account_id = tr.account_id AND tc.partner_id = p_user)
          OR tr.created_by = p_user)
   ORDER BY tr.created_at DESC
$$;
