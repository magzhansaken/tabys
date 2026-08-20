-- =====================================================================
-- 095_journal_device.sql — журнал называет подключённое устройство.
--
-- Запись «Подключено устройство» без имени и цены ничего не говорит.
-- Через полгода по ней не понять, ЗА ЧТО клиенту начали брать три
-- тысячи в месяц — а именно это и спросят при разборе счёта.
--
-- Теперь: «Подключено устройство — Касса 2 · 3 000 ₸ · Мини-маркет».
-- =====================================================================

CREATE OR REPLACE FUNCTION platform_journal(
  p_role text, p_user uuid,
  p_before bigint DEFAULT NULL,
  p_account uuid DEFAULT NULL,
  p_actor uuid DEFAULT NULL,
  p_weight text DEFAULT NULL,
  p_limit integer DEFAULT 50)
RETURNS TABLE (
  id bigint, seq bigint, at timestamptz, actor text, actor_id uuid,
  action text, title text, detail text, weight text,
  account_id uuid, client text, amount bigint)
SECURITY DEFINER SET search_path = public LANGUAGE sql STABLE AS $$
  SELECT pa.id, pa.seq, pa.at, pa.actor_name, pa.actor_id, pa.action,

    -- Описание словами. Новое действие без перевода покажется своим
    -- кодом — но хотя бы один раз и в одном месте, а не в каждом
    -- кабинете по-разному.
    CASE pa.action
      WHEN 'login_failed'        THEN 'Неудачная попытка входа'
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
      -- Этап СЛОВАМИ. Стояло «этап: paid» — человек видит в воронке
      -- столбец «Оплатил», а в журнале код, и связать их не может.
      CASE WHEN pa.details ? 'stage' THEN 'этап: ' || CASE pa.details->>'stage'
        WHEN 'new'       THEN 'Новый'
        WHEN 'contacted' THEN 'Связались'
        WHEN 'trial'     THEN 'Пробный'
        WHEN 'paid'      THEN 'Оплатил'
        WHEN 'lost'      THEN 'Отказ'
        WHEN 'auto'      THEN 'снова по фактам'
        ELSE pa.details->>'stage' END END,
      CASE WHEN pa.details ? 'count' THEN 'затронуто: ' || (pa.details->>'count') END,

      -- ЧТО ИМЕННО ПОДКЛЮЧИЛИ. Запись «Подключено устройство» без
      -- имени и цены ничего не говорит: через полгода не понять, за
      -- что клиенту начали брать три тысячи.
      CASE WHEN pa.action = 'device_added' THEN
        nullif(concat_ws(' · ',
          pa.details->>'name',
          CASE WHEN pa.details ? 'price' THEN pa.details->>'price' END), '')
      END,

      -- ЧТО ИМЕННО ПОПРАВИЛИ в карточке. Раньше стояло просто «Правка
      -- карточки» — самая частая запись, и по ней ничего не
      -- восстановить: телефон поменяли? название? город?
      -- ЧТО поправили И НА ЧТО. Одного «город» мало: через полгода
      -- спросят «кто сменил город на Алматы», и по записи «город»
      -- ответа не будет — какой был и какой стал, неизвестно.
      CASE WHEN pa.action = 'card_updated' THEN
        nullif(concat_ws(', ',
          CASE WHEN pa.details ? 'name'
               THEN 'название → ' || (pa.details->>'name') END,
          CASE WHEN pa.details ? 'city'
               THEN 'город → ' || (pa.details->>'city') END,
          CASE WHEN pa.details ? 'ownerName'
               THEN 'владелец → ' || (pa.details->>'ownerName') END,
          CASE WHEN pa.details ? 'ownerPhone'
               THEN 'телефон → ' || (pa.details->>'ownerPhone') END,
          CASE WHEN pa.details ? 'dealNote'    THEN 'заметка' END), '')
      END,

      -- ЦЕНЫ ПЛАТФОРМЫ: что именно поменяли. Раньше подробности не
      -- было вовсе: «Изменены цены платформы» — и всё. Через полгода
      -- спросят «когда подняли Старт», а ответа нет.
      CASE WHEN pa.action = 'price_book_changed' THEN
        nullif(concat_ws(', ',
          CASE WHEN pa.details ? 'base'
               THEN 'Старт → ' || (pa.details->>'base') || ' ₸' END,
          CASE WHEN pa.details ? 'pro'
               THEN 'Стандарт → ' || (pa.details->>'pro') || ' ₸' END,
          CASE WHEN pa.details ? 'extraPos'
               THEN 'касса → ' || (pa.details->>'extraPos') || ' ₸' END,
          CASE WHEN pa.details ? 'extraStore'
               THEN 'точка → ' || (pa.details->>'extraStore') || ' ₸' END,
          CASE WHEN pa.details ? 'discount6m'
               THEN 'скидка полгода → ' || (pa.details->>'discount6m') || '%' END,
          CASE WHEN pa.details ? 'discount12m'
               THEN 'скидка год → ' || (pa.details->>'discount12m') || '%' END), '')
      END,

      -- Название магазина из details — ТОЛЬКО там, где его нет рядом
      -- в своём столбце. Иначе выходило «Береке · Береке».
      CASE WHEN pa.details ? 'name' AND pa.account_id IS NULL
           THEN pa.details->>'name' END
    ), ''),

    -- Вес записи. Деньги весомее прочего: цена ошибки в них другая.
    -- Считаем здесь, чтобы кабинет не решал сам, что важнее.
    CASE
      WHEN pa.action LIKE 'payment%' OR pa.action LIKE 'plan_line%'
        OR pa.action IN ('tier_changed','price_book_changed','device_added',
                         'pay_settings_changed','bulk_grace')
        THEN 'money'
      WHEN pa.action IN ('tenant_deleted','tenant_suspended','owner_password_reset',
                         'partner_disabled','bulk_disable','signup_rejected',
                         -- Подбор пароля — это про доступ: владелец
                         -- отбирает журнал по «доступу», когда
                         -- разбирается, кто куда попал.
                         'login_failed')
        THEN 'access'
      ELSE 'other'
    END,

    pa.account_id, a.name,
    CASE WHEN pa.details ? 'amount'
         THEN ((pa.details->>'amount')::numeric * 100)::bigint END

    FROM platform_audit pa
    LEFT JOIN account a ON a.id = pa.account_id
    LEFT JOIN tenant_card tc ON tc.account_id = pa.account_id
   WHERE (p_before IS NULL OR pa.seq < p_before)
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
                               'partner_disabled','bulk_disable','signup_rejected',
                              'login_failed') THEN 'access'
            ELSE 'other' END)
   ORDER BY pa.seq DESC
   LIMIT least(greatest(p_limit, 1), 200);
$$;
GRANT EXECUTE ON FUNCTION platform_journal(text, uuid, bigint, uuid, uuid, text, integer) TO shop_app;
