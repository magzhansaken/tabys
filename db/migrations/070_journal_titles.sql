-- =====================================================================
-- 070_journal_titles.sql — три действия показывались кодом.
--
-- НАЙДЕНО СВЕРКОЙ: сравнил, какие действия ПИШУТСЯ в журнал, с тем,
-- какие в нём НАЗВАНЫ. Расхождение в трёх:
--
--   card_updated  — правка карточки клиента;
--   demo_created  — заведён учебный магазин;
--   bulk_*        — массовые действия.
--
-- Все три показывались кодом на латинице. Человек, ищущий «кто
-- поменял телефон клиента», проходил мимо строки card_updated, не
-- поняв, что это она.
--
-- Заодно: правка карточки ДО СИХ ПОР НЕ ПИСАЛАСЬ ВОВСЕ. Менялись
-- название, город, владелец, телефон — и следа не оставалось. Журнал
-- нужен ровно для вопроса «кто это поменял», а самая частая правка шла
-- мимо него. Исправлено на сервере.
-- =====================================================================

CREATE OR REPLACE FUNCTION platform_journal(
  p_role text, p_user uuid,
  p_before timestamptz DEFAULT NULL,
  p_account uuid DEFAULT NULL,
  p_actor uuid DEFAULT NULL,
  p_weight text DEFAULT NULL,
  p_limit integer DEFAULT 50)
RETURNS TABLE (
  id bigint, at timestamptz, actor text, actor_id uuid,
  action text, title text, detail text, weight text,
  account_id uuid, client text, amount bigint)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT pa.id, pa.at, pa.actor_name, pa.actor_id, pa.action,

    -- Описание словами. Новое действие без перевода покажется своим
    -- кодом — но хотя бы один раз и в одном месте, а не в каждом
    -- кабинете по-разному.
    CASE pa.action
      WHEN 'payment_recorded'    THEN 'Отмечена оплата'
      WHEN 'payment_approved'    THEN 'Оплата подтверждена'
      WHEN 'payment_rejected'    THEN 'Оплата отклонена'
      WHEN 'payment_declared'    THEN 'Клиент сообщил об оплате'
      WHEN 'partner_created'     THEN 'Заведён партнёр'
      WHEN 'partner_updated'     THEN 'Изменён партнёр'
      WHEN 'partner_enabled'     THEN 'Партнёру открыт вход'
      WHEN 'partner_disabled'    THEN 'Партнёру закрыт вход'
      WHEN 'partner_assigned'    THEN 'Назначен партнёр'
      WHEN 'tenant_created'      THEN 'Заведён магазин'
      -- Три действия показывались КОДОМ: их писали, но не называли.
      -- «card_updated» в журнале выглядело именно так, и человек,
      -- ищущий «кто поменял телефон», проходил мимо.
      WHEN 'card_updated'        THEN 'Правка карточки'
      WHEN 'demo_created'        THEN 'Заведён учебный магазин'
      WHEN 'bulk_grace'          THEN 'Массово продлён срок'
      WHEN 'bulk_disable'        THEN 'Массово отключены'
      WHEN 'bulk_enable'         THEN 'Массово включены'
      WHEN 'tenant_deleted'      THEN 'Магазин отключён'
      WHEN 'tenant_suspended'    THEN 'Магазин заморожен'
      WHEN 'tenant_enabled'      THEN 'Магазин разморожен'
      WHEN 'tier_changed'        THEN 'Сменён тариф'
      WHEN 'plan_line_added'     THEN 'Добавлена строка счёта'
      WHEN 'plan_line_edited'    THEN 'Изменена строка счёта'
      WHEN 'plan_line_closed'    THEN 'Закрыта строка счёта'
      WHEN 'price_book_changed'  THEN 'Изменены цены платформы'
      WHEN 'pay_settings_changed' THEN 'Изменены реквизиты оплаты'
      WHEN 'device_added'        THEN 'Подключено устройство'
      WHEN 'request_created'     THEN 'Подана заявка'
      WHEN 'request_approved'    THEN 'Заявка одобрена'
      WHEN 'request_rejected'    THEN 'Заявка отклонена'
      WHEN 'signup_approved'     THEN 'Одобрена самозапись'
      WHEN 'signup_rejected'     THEN 'Отклонена самозапись'
      WHEN 'owner_password_reset' THEN 'Сброшен пароль владельцу'
      WHEN 'activation_code_taken' THEN 'Взят код активации кассы'
      WHEN 'funnel_moved'        THEN 'Сдвинута карточка в воронке'
      WHEN 'marked_demo'         THEN 'Помечен учебным'
      WHEN 'unmarked_demo'       THEN 'Снята пометка учебного'
      WHEN 'lead_updated'        THEN 'Обновлена заявка с сайта'
      WHEN 'billing_reminder'    THEN 'Напоминание о подписке'
      WHEN 'bulk_grace'          THEN 'Массовая отсрочка'
      WHEN 'bulk_disable'        THEN 'Массовая заморозка'
      WHEN 'bulk_enable'         THEN 'Массовая разморозка'
      ELSE pa.action
    END,

    -- Подробности одной строкой: что именно поменялось.
    nullif(concat_ws(' · ',
      CASE WHEN pa.details ? 'amount'
           THEN (pa.details->>'amount') || ' ₸' END,
      CASE WHEN pa.details ? 'months'
           THEN (pa.details->>'months') || ' мес.' END,
      CASE WHEN pa.details ? 'partnerShare'
           THEN 'партнёру ' || (pa.details->>'partnerShare') || ' ₸' END,
      CASE WHEN pa.details ? 'reason' THEN 'причина: ' || (pa.details->>'reason') END,
      CASE WHEN pa.details ? 'note' AND pa.details->>'note' <> ''
           THEN pa.details->>'note' END,
      CASE WHEN pa.details ? 'title' THEN pa.details->>'title' END,
      CASE WHEN pa.details ? 'stage' THEN 'этап: ' || (pa.details->>'stage') END,
      CASE WHEN pa.details ? 'count' THEN 'затронуто: ' || (pa.details->>'count') END,
      CASE WHEN pa.details ? 'name' THEN pa.details->>'name' END
    ), ''),

    -- Вес записи. Деньги весомее прочего: цена ошибки в них другая.
    -- Считаем здесь, чтобы кабинет не решал сам, что важнее.
    CASE
      WHEN pa.action LIKE 'payment%' OR pa.action LIKE 'plan_line%'
        OR pa.action IN ('tier_changed','price_book_changed','device_added',
                         'pay_settings_changed','bulk_grace')
        THEN 'money'
      WHEN pa.action IN ('tenant_deleted','tenant_suspended','owner_password_reset',
                         'partner_disabled','bulk_disable','signup_rejected')
        THEN 'access'
      ELSE 'other'
    END,

    pa.account_id, a.name,
    CASE WHEN pa.details ? 'amount'
         THEN ((pa.details->>'amount')::numeric * 100)::bigint END

    FROM platform_audit pa
    LEFT JOIN account a ON a.id = pa.account_id
    LEFT JOIN tenant_card tc ON tc.account_id = pa.account_id
   WHERE (p_before IS NULL OR pa.at < p_before)
     AND (p_account IS NULL OR pa.account_id = p_account)
     AND (p_actor IS NULL OR pa.actor_id = p_actor)
     -- Партнёру записи по чужим клиентам не приходят ВОВСЕ, а не
     -- прячутся при отрисовке.
     AND (p_role = 'super'
          OR pa.actor_id = p_user
          OR tc.partner_id = p_user)
     AND (p_weight IS NULL OR p_weight = 'all' OR
          p_weight = CASE
            WHEN pa.action LIKE 'payment%' OR pa.action LIKE 'plan_line%'
              OR pa.action IN ('tier_changed','price_book_changed','device_added',
                               'pay_settings_changed','bulk_grace') THEN 'money'
            WHEN pa.action IN ('tenant_deleted','tenant_suspended','owner_password_reset',
                               'partner_disabled','bulk_disable','signup_rejected') THEN 'access'
            ELSE 'other' END)
   ORDER BY pa.at DESC
   LIMIT least(greatest(p_limit, 1), 200);
$$;
GRANT EXECUTE ON FUNCTION platform_journal(text, uuid, timestamptz, uuid, uuid, text, integer) TO shop_app;
