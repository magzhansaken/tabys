-- Накат всех миграций по порядку.
-- psql -U postgres -d shop_dev -f db\migrate.sql
\set ON_ERROR_STOP on
\echo '--- 001 каркас, аккаунты, изоляция ---'
\i db/migrations/001_core.sql
\echo '--- 002 авторизация ---'
\i db/migrations/002_auth.sql
\echo '--- 003 синхронизация (офлайн) ---'
\i db/migrations/003_sync.sql
\echo '--- 004-010 товары, импорт, этикетки ---'
\i db/migrations/004_goods.sql
\i db/migrations/005_goods_extra.sql
\i db/migrations/006_import.sql
\i db/migrations/007_price_types_fix.sql
\i db/migrations/008_price_uniq_fix.sql
\i db/migrations/009_labels.sql
\i db/migrations/010_archive_filters.sql
\echo '--- 011-012 склад ---'
\i db/migrations/011_stock.sql
\i db/migrations/012_notifications.sql
\echo '--- 013 касса ---'
\i db/migrations/013_pos.sql
\echo '--- 014 фискализация ---'
\i db/migrations/014_fiscal.sql
\echo '--- 015 контрагенты и долги ---'
\i db/migrations/015_contragents.sql
\echo '--- 016 финансы ---'
\i db/migrations/016_finance.sql
\echo '--- 017 отчёты ---'
\i db/migrations/017_reports.sql
\echo '--- 018 документы Казахстана ---'
\i db/migrations/018_documents.sql
\echo '--- 019 лояльность ---'
\i db/migrations/019_loyalty.sql
\echo '--- 020 оборудование ---'
\i db/migrations/020_equipment.sql
\echo '--- 021 онбординг и миграция ---'
\i db/migrations/021_onboarding.sql
\echo '--- 022 ИИ ---'
\i db/migrations/022_ai.sql
\echo '--- 023 биллинг ---'
\i db/migrations/023_billing.sql
\echo '--- 024 починка расчёта смены (часть 16) ---'
\i db/migrations/024_pos_fixes.sql
\echo '--- 025 консультанты: процент (часть 18) ---'
\i db/migrations/025_consultants.sql
\echo '--- 026 заявки с лендинга (часть 19) ---'
\i db/migrations/026_leads.sql
\echo '--- 027 операторская админка (часть 20) ---'
\i db/migrations/027_operator.sql

\echo '--- 028 брендирование: логотип, печать, подпись (часть 21) ---'
\i db/migrations/028_branding.sql

\echo '--- 029 налоговый блок КЗ: регистры, 910 (часть 22) ---'
\i db/migrations/029_taxes.sql

\echo '--- 030 боевая фискализация: режим, коррекция (часть 23) ---'
\i db/migrations/030_fiscal_prod.sql

\echo '--- 031 деньги и люди: зарплата, отделы, договоры (часть 24) ---'
\i db/migrations/031_money_people.sql

\echo '--- 032 касса++: авансы, сертификаты (часть 25) ---'
\i db/migrations/032_cash_plus.sql

\echo '--- 033 склад++: ячейки, лист отбора (часть 26) ---'
\i db/migrations/033_warehouse_plus.sql

\echo '--- 034 автоматизация: автоотчёты, вебхуки, сценарии, чат (часть 27) ---'
\i db/migrations/034_automation.sql

\echo '--- 035 онлайн-оплата подписки: счета, автопродление (часть 29) ---'
\i db/migrations/035_billing_online.sql

\echo '--- 036 маркировка ИС МПТ: вывод из оборота, журнал (часть 30) ---'
\i db/migrations/036_marking.sql

\echo '--- 037 CRM опт и юнит-экономика: воронка, клиенты (часть 31) ---'
\i db/migrations/037_wholesale_crm.sql

\echo '--- 038 маркетплейс Kaspi: каталог, заказы, остатки (часть 32) ---'
\i db/migrations/038_marketplace.sql

\echo '--- 039 AI-приёмка максимум: сверка с заказом, контроль цен (часть 33) ---'
\i db/migrations/039_ai_receiving.sql

\echo '--- 040 проверка контрагента КГД: НДС, режим, риск (часть 34) ---'
\i db/migrations/040_counterparty_check.sql

\echo '--- 041 техкарты: рецепты со списанием ингредиентов (часть 35) ---'
\i db/migrations/041_techcard.sql

\echo '--- 042 акцизные марки алкоголя УКМ: проверка, учёт (часть 36) ---'
\i db/migrations/042_excise_ukm.sql

\echo '--- 043 RFM-анализ клиентов: сегментация R/F/M (часть 37) ---'
\i db/migrations/043_rfm.sql

\echo '--- 044 регистрация с подтверждением оператором (часть 38) ---'
\i db/migrations/044_pending_registration.sql
\echo '--- 045 функции оператора для заявок (часть 38) ---'
\i db/migrations/045_operator_signup_functions.sql

\echo '--- 046 продажа из кабинета: отгрузка и оплата (этап 8) ---'
\i db/migrations/046_wholesale_sale.sql

\echo '--- 047 публичный API: ключи доступа (этап 11) ---'
\i db/migrations/047_api_keys.sql

\echo '--- 048 граница операционного дня (этап 12) ---'
\i db/migrations/048_day_start.sql

\echo '--- 049 единые статусы листа отбора ---'
\i db/migrations/049_picking_status.sql

\echo '--- 050 права на кассе и настройки скидок ---'
\i db/migrations/050_pos_permissions.sql

\echo '--- 051 режим печати бумажного чека ---'
\i db/migrations/051_receipt_print_mode.sql

\echo '--- 052 платформа: партнёры, строки счёта, оплаты ---'
\i db/migrations/052_platform.sql

\echo '--- 053 разделы кабинета платформы ---'
\i db/migrations/053_platform_sections.sql

\echo '--- 054 функции платформы ---'
\i db/migrations/054_platform_functions.sql

\echo '--- 055 последствие в ленте «Сегодня» ---'
\i db/migrations/055_today_preview.sql

\echo '--- 056 клиенты таблицей ---'
\i db/migrations/056_clients_table.sql

\echo '--- 056 клиенты таблицей ---'
\i db/migrations/056_clients_table.sql

\echo '--- 057 запрет повторов кода тарифа ---'
\i db/migrations/057_tariff_unique.sql

\echo '--- 058 общая роль владельца ---'
\i db/migrations/058_owner_role_fix.sql

\echo '--- 059 правка названия магазина ---'
\i db/migrations/059_rename_account.sql

\echo '--- 060 реквизиты оплаты пятью полями ---'
\i db/migrations/060_pay_fields.sql

\echo '--- 061 деньги клиента в заявке ---'
\i db/migrations/061_requests_money.sql

\echo '--- 062 касса новому клиенту ---'
\i db/migrations/062_tenant_register.sql

\echo '--- 063 кто подтвердил и что будет ---'
\i db/migrations/063_money_note.sql

\echo '--- 064 в партнёрах видны владельцы ---'
\i db/migrations/064_partners_all.sql

\echo '--- 065 порядок внутри очереди ---'
\i db/migrations/065_today_order.sql

\echo '--- 066 устойчивый порядок клиентов ---'
\i db/migrations/066_clients_order.sql

\echo '--- 067 цена при одобрении заявки ---'
\i db/migrations/067_request_price.sql

\echo '--- 068 счёт из тарифа и строк ---'
\i db/migrations/068_monthly_base.sql

\echo '--- 069 счёт в остальных трёх местах ---'
\i db/migrations/069_monthly_rest.sql

\echo '--- 070 названия действий в журнале ---'
\i db/migrations/070_journal_titles.sql

\echo '--- 071 починка поиска клиентов ---'
\i db/migrations/071_search_fix.sql

\echo '--- 072 владелец в карточке клиента ---'
\i db/migrations/072_card_owner.sql

\echo '--- 073 вернуть воронку к фактам ---'
\i db/migrations/073_funnel_auto.sql

\echo '--- 074 платят и пробные не пересекаются ---'
\i db/migrations/074_snapshot_split.sql

\echo '--- 075 листание журнала по номеру ---'
\i db/migrations/075_journal_cursor.sql

\echo '--- 076 клиент не за призраком ---'
\i db/migrations/076_ghost_partner.sql

\echo '--- 077 один список этапов воронки ---'
\i db/migrations/077_stage_list.sql

\echo '--- 078 разрывы в графике ---'
\i db/migrations/078_series_gaps.sql

\echo '--- 079 кто отметил оплату ---'
\i db/migrations/079_who_declared.sql

\echo '--- 080 счёт объясняет сам себя ---'
\i db/migrations/080_base_line_shown.sql

\echo '--- 081 журнал читается через полгода ---'
\i db/migrations/081_journal_readable.sql

\echo '--- 082 значения в журнале ---'
\i db/migrations/082_journal_values.sql

\echo '--- 082 одна цена тарифа ---'
\i db/migrations/082_one_price.sql

\echo '--- 083 карточка записавшемуся с сайта ---'
\i db/migrations/083_signup_card.sql

\echo '--- 084 процент доли на момент оплаты ---'
\i db/migrations/084_payment_percent.sql

\echo '--- 085 кто решил заявку ---'
\i db/migrations/085_request_decider.sql

\echo '--- 085 заметка о клиенте ---'
\i db/migrations/085_client_note.sql

\echo '--- 086 неудачный вход в журнал ---'
\i db/migrations/086_login_failed.sql

\echo '--- 087 рейтинг партнёров ---'
\i db/migrations/087_partner_ranking.sql

\echo '--- 088 стереть магазины для проверки ---'
\i db/migrations/088_wipe_accounts.sql

\echo '--- 089 стирание по ссылкам ---'
\i db/migrations/089_wipe_all.sql

\echo '--- 090 рейтинг: при равенстве решают деньги ---'
\i db/migrations/090_ranking_tie.sql

\echo '--- 091 помощники для данных проверки ---'
\i db/migrations/091_seed_helpers.sql

\echo '--- 092 подсчёт перед очисткой ---'
\i db/migrations/092_wipe_preview.sql

\echo '--- 093 оплата сильнее ручного этапа ---'
\i db/migrations/093_paid_beats_manual.sql

\echo '--- 094 добавить устройство целиком ---'
\i db/migrations/094_device_add.sql

\echo '--- 095 журнал называет устройство ---'
\i db/migrations/095_journal_device.sql

\echo '--- 096 одобрение заводит устройство ---'
\i db/migrations/096_request_device.sql

\echo '--- 097 журнал называет итог заявки ---'
\i db/migrations/097_journal_request.sql

\echo '--- 098 три пути к устройству ---'
\i db/migrations/098_device_request.sql

\echo '--- 099 партнёр видит заявки своих клиентов ---'
\i db/migrations/099_partner_sees_requests.sql

\echo '--- 100 список устройств с кодами ---'
\i db/migrations/100_device_list.sql

\echo '--- 101 код для нужной кассы ---'
\i db/migrations/101_code_for_register.sql

\echo '--- 102 доплаты копятся и платятся разом ---'
\i db/migrations/102_charges.sql

\echo '--- 103 первое устройство вида входит в тариф ---'
\i db/migrations/103_first_free.sql

\echo '--- 104 код живёт до привязки ---'
\i db/migrations/104_code_lives.sql

\echo '--- 105 своя строка счёта у устройства ---'
\i db/migrations/105_own_line.sql

\echo '--- 106 предел скидки кассира ---'
\i db/migrations/106_discount_limit.sql

\echo '--- 107 пометка «без проверки» в журнале ---'
\i db/migrations/107_offline_note.sql

\echo '--- 107 падение кассы в журнале ---'
\i db/migrations/107_pos_crash.sql

\echo '=== ГОТОВО ==='
SELECT count(*) AS "таблиц создано" FROM information_schema.tables WHERE table_schema='public';
