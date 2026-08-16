#!/usr/bin/env node
/**
 * СТОРОЖА («иглы») — дешёвая проверка, что важное не пропало молча.
 *
 * Идея взята у соседнего проекта: список «файл, что должно быть, зачем».
 * У них таких правил 178, и они ловили настоящие поломки.
 *
 * ПОЧЕМУ ЭТО НУЖНО ПОМИМО ТЕСТОВ. Тесты проверяют поведение, но их
 * прогон требует базы и занимает минуты. Сторожа проверяют, что решение
 * не выпало из кода при правке — за доли секунды и без базы.
 *
 * КАЖДОЕ ПРАВИЛО ЗДЕСЬ — ЭТО ПЕРЕЖИТАЯ ПОЛОМКА. Не выдуманные, а те,
 * что реально ломали работу за три дня запуска:
 *   · сервер уходил в базу ресторана по общему имени «db»;
 *   · пароль базы задавался строкой в настройках и подставлялся неверно;
 *   · миграция создавала значение и тут же им пользовалась;
 *   · проверка подключалась изнутри базы, где пароль не спрашивают.
 *
 * Запуск:  node scripts/check-invariants.js
 * Ответ:   0 — всё на месте, 1 — что-то пропало.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch { return null; } };

/**
 * Правило: { файл, что искать, зачем }
 *   must    — должно присутствовать
 *   mustNot — не должно присутствовать (это ещё важнее: так ловятся
 *             возвраты старых ошибок)
 */
const RULES = [
  // ── Безопасность соседства: главный урок запуска ──────────────────
  { file: 'deploy/docker-compose.prod.yml', must: 'PGHOST: tabys-db',
    why: 'База по УНИКАЛЬНОМУ имени. По общему «db» сервер уходил в базу ресторана' },
  { file: 'deploy/docker-compose.prod.yml', mustNot: /PGHOST:\s*db\s*$/m,
    why: 'Общее имя «db» в общей сети означает чужую базу' },
  { file: 'deploy/docker-compose.prod.yml', mustNot: /^\s+ports:/m,
    why: 'Наружу порты не открываем — только через общий Caddy, иначе API в интернете без шифрования' },
  { file: 'deploy/docker-compose.prod.yml', must: 'external: true',
    why: 'Сервер и кабинет должны быть в общей сети, иначе Caddy их не найдёт' },
  { file: 'deploy/docker-compose.prod.yml', must: 'networks: [internal]',
    why: 'База обязана оставаться в закрытой сети и не быть видной ресторану' },

  // ── Подготовка базы ────────────────────────────────────────────────
  { file: 'deploy/migrate.sh', must: 'ALTER ROLE shop_app PASSWORD',
    why: 'Пароль роли синхронизируется с настройками при каждом запуске' },
  { file: 'deploy/migrate.sh', must: "PGHOST:-tabys-db",
    why: 'Проверка подключения по имени из настроек, а не по 127.0.0.1: изнутри базы пароль не спрашивают, и проверка врала' },
  { file: 'deploy/docker-compose.prod.yml', must: 'entrypoint: ["bash", "/migrate.sh"]',
    why: 'Команда в отдельном файле: строка в настройках однажды подставила не тот пароль' },

  // ── Проверки выкладки ──────────────────────────────────────────────
  { file: 'deploy/lib_check.sh', must: 'check_registration',
    why: 'Выкладка обязана заканчиваться настоящей регистрацией, а не словом «ГОТОВО»' },
  { file: 'deploy/lib_check.sh', must: 'NOT EXISTS (SELECT 1 FROM sale',
    why: 'Уборка служебных записей не должна трогать аккаунт с продажами' },
  { file: 'deploy/lib_check.sh', must: 'dastarhan.duckdns.org',
    why: 'Ресторан проверяется при каждой выкладке: наши работы не должны его задевать' },
  { file: 'deploy/05_update.sh', must: 'run_all_checks',
    why: 'Обновление вызывает проверки' },

  // ── Миграции ───────────────────────────────────────────────────────
  { file: 'db/migrations/044_pending_registration.sql', mustNot: 'CREATE OR REPLACE FUNCTION',
    why: 'В файле с новым значением перечисления нельзя создавать функции, которые им пользуются: одна транзакция — одна ошибка' },
  { file: 'db/migrations/045_operator_signup_functions.sql', must: 'SECURITY DEFINER',
    why: 'Оператор живёт вне магазинов, построчная защита пропускает его только так' },
  { file: 'db/apply.sh', must: '--single-transaction',
    why: 'Каждая миграция применяется целиком или не применяется вовсе' },

  // ── Права и доступ ─────────────────────────────────────────────────
  { file: 'server/src/auth/guards.ts', must: "accountStatus === 'pending'",
    why: 'Неактивированная заявка не должна работать с товарами и кассой' },
  { file: 'server/src/auth/auth.service.ts', must: "REQUIRE_OTP === '1'",
    why: 'Ветка регистрации по СМС сохранена и включается флагом' },
  { file: 'server/src/auth/auth.service.ts', must: 'MODERATE_SIGNUP',
    why: 'Модерация заявок включена по умолчанию везде, кроме тестов' },
  { file: 'server/src/leads/leads.module.ts', must: 'Операторский доступ не настроен',
    why: 'Без ключа операторская админка закрыта полностью, а не открыта всем' },

  // ── Ядро учёта ─────────────────────────────────────────────────────
  { file: 'server/src/pos/pos.service.ts', must: "bundle_mode === 'recipe'",
    why: 'Продажа блюда списывает ингредиенты, а не само блюдо' },
  { file: 'server/src/db/db.service.ts', must: 'app.account_id',
    why: 'Изоляция магазинов друг от друга держится на этом' },
  { file: 'db/setup_prod.sql', must: 'NOSUPERUSER',
    why: 'Приложение ходит без прав суперпользователя: суперпользователь обходит изоляцию магазинов' },

  // ── Касса ──────────────────────────────────────────────────────────
  { file: 'pos-desktop/electron/store.cjs', must: 'renameSync',
    why: 'Атомарная запись: отключение питания посреди чека не должно портить файл' },
  { file: 'pos-desktop/electron/printer.cjs', must: 'enqueue',
    why: 'Очередь печати: параллельные задания рвут ленту посреди чека' },
  { file: 'pos-desktop/electron/main.cjs', must: 'contextIsolation: true',
    why: 'Страница кассы не должна иметь доступа к файлам и запуску программ' },
  { file: 'pos-desktop/electron/main.cjs', must: 'nodeIntegration: false',
    why: 'То же: на кассе ходят деньги' },
  { file: 'pos-desktop/renderer/app.js', must: '/pos/goods/catalog',
    why: 'Правильный адрес каталога: с неверным экран товаров оставался пустым' },
  { file: 'pos-desktop/renderer/app.js', must: '/pos/login',
    why: 'Вход кассира по PIN идёт своим путём, а не паролем владельца' },
  { file: 'pos-desktop/renderer/app.js', must: 'K.receiptAdd(receipt)',
    why: 'Чек сохраняется на диск ДО печати и отправки: продажа не зависит от сети' },

  // ── Единообразие кабинета (этап 4) ─────────────────────────────────
  { file: 'admin/lib/ui.tsx', must: 'export function DataTable',
    why: 'Единая таблица: фильтр, столбцы, выгрузка одинаково во всех разделах — этим UMAG и ощущается зрелым' },
  { file: 'admin/lib/ui.tsx', must: 'useEffect(() => {',
    why: 'Сохранённый выбор столбцов читается ПОСЛЕ появления страницы: обращение к хранилищу во время сборки роняет кабинет' },
  { dir: 'admin/app', mustNotContainText: 'localStorage.getItem(\'cols:',
    why: 'Со страниц к хранилищу столбцов не обращаются: это делает единая таблица, где чтение отложено до появления страницы' },

  // ── Документы (этап 5) ─────────────────────────────────────────────
  { file: 'server/src/stock/stock.service.ts', must: 'async restoreDoc',
    why: 'Удаление документа обратимо: удалить по ошибке приёмку и потерять её насовсем недопустимо' },
  { file: 'server/src/admin/admin.module.ts', must: "@Post('docs/:id/restore')",
    why: 'Восстановление доступно из кабинета: без эндпоинта функция в сервере бесполезна' },
  { file: 'server/src/stock/stock.service.ts', must: "SET status='deleted', deleted_at=now()",
    why: 'Удаление мягкое: строка остаётся в базе' },
  { file: 'server/src/stock/stock.service.ts', must: 'Проведённый документ удалить нельзя',
    why: 'Проведённый документ защищён: его движения уже в остатках, нужно сторно' },
  { file: 'admin/lib/ui.tsx', must: 'export function Status',
    why: 'Статусы переводятся в одном месте: раньше склад проверял «processed», которого в базе нет' },
  { dir: 'admin/app', mustNotContainText: "status === 'processed'",
    why: 'Такого статуса не существует — опечатка прятала зелёный «Проведён» за серым служебным словом' },
  // Правило шире предыдущего: ловит ЛЮБОЙ второй перевод статусов на
  // странице, а не только известные опечатки. Дизайнер нашёл ещё один
  // такой перевод (статус «confirmed» жил тернаркой на странице AI) —
  // значит проверять надо не отдельные случаи, а сам приём.
  { dir: 'admin/app', mustNotContainText: "status === 'confirmed' ?",
    why: 'Перевод статусов только в компоненте Status: второй перевод на странице рано или поздно разъедется с первым' },
  { dir: 'admin/app', mustNotContainText: "status === 'done' ? <Badge",
    why: 'То же: статус рисуется общим компонентом, иначе один документ выглядит в разных разделах по-разному' },

  // ── Отчёты (этап 6) ────────────────────────────────────────────────
  { file: 'server/src/reports/report.service.ts', must: 'async discounts',
    why: 'Отчёт по скидкам отдельным разделом — у UMAG он есть, скидка «своим» уводит деньги из кассы' },
  { file: 'server/src/reports/report.service.ts', must: 'AS discounts_given',
    why: 'Сколько скидок отдано за смену — видно рядом с выручкой' },
  { file: 'server/src/reports/report.service.ts', must: 'AS profit',
    why: 'Прибыль за смену: наторговали — но заработали ли' },
  { file: 'server/src/reports/report.service.ts', must: "s.return_of_id IS NULL AND si.discount_sum > 0",
    why: 'Возвраты в отчёт по скидкам не попадают: вернули товар — скидки не было' },
  { file: 'admin/app/(cab)/reports/page.tsx', must: 'discountShare',
    why: 'Доля скидки от цены: 200 ₸ с кофе и с телевизора выглядят одинаково, но это разные вещи' },

  // ── Товары и склад (этап 7) ────────────────────────────────────────
  { file: 'server/src/automation/automation.module.ts', must: 'buildLowStockDigest',
    why: 'Утренняя сводка о заканчивающемся товаре: заказ поставщику делают утром, а не вечером' },
  { file: 'server/src/automation/automation.module.ts', must: "report === 'low_stock' ? 9 : 21",
    why: 'Час по умолчанию зависит от отчёта: список «что заканчивается» в девять вечера бесполезен' },
  { file: 'server/src/goods/goods.service.ts', must: 'async bulkSetArticle',
    why: 'Массовое присвоение артикулов: вручную при сотне позиций это никто не делает' },
  { file: 'server/src/goods/goods.service.ts', must: 'if (cur.article && !dto.overwrite)',
    why: 'Заполненный артикул не затирается: он часто приходит от поставщика, и связь с его прайсом потеряется' },
  { file: 'server/src/export/export.module.ts', must: 'async salesFor1C',
    why: 'Выгрузка продаж для 1С в её колонках загрузки — бухгалтеры просят' },
  { file: 'server/src/export/export.module.ts', must: "'Штрих-код', 'Код', 'Артикул'",
    why: 'Колонки названы дословно как у 1С: бухгалтер копирует лист без переименований' },

  // ── Продажа из кабинета (этап 8) ───────────────────────────────────
  { file: 'server/src/wholesale/wholesale.module.ts', must: 'async ship',
    why: 'Отгрузка списывает товар: раньше «отгружено» был ярлык, а товар оставался на складе' },
  { file: 'server/src/wholesale/wholesale.module.ts', must: 'if (short.length)',
    why: 'Проверяем ВСЕ позиции до списания: частично отгруженная сделка хуже неотгруженной' },
  { file: 'server/src/wholesale/wholesale.module.ts', must: 'Больше остатка долга',
    why: 'Переплату не принимаем: чаще это опечатка в сумме, а не подарок' },
  { file: 'server/src/wholesale/wholesale.module.ts', must: "payStatus",
    why: 'Цвет суммы показывает долг с одного взгляда — приём UMAG' },

  // ── Продажа из кабинета (этап 8) ───────────────────────────────────
  { file: 'server/src/wholesale/wholesale.module.ts', must: 'apply_bonus_move',
    why: 'Кэшбэк через готовую функцию: она ведёт срок сгорания, прямая запись сломала бы списание по очереди' },
  { file: 'server/src/wholesale/wholesale.module.ts', must: 'cashback = Math.floor(d.amount',
    why: 'Кэшбэк от ЗАПЛАЧЕННЫХ денег, а не от суммы сделки: иначе бонусы даются за неоплаченный долг' },
  { file: 'server/src/wholesale/wholesale.module.ts', must: 'Больше остатка долга',
    why: 'Переплата не принимается: чаще это опечатка в сумме, а не подарок' },
  { file: 'server/src/wholesale/wholesale.module.ts', must: 'Сначала проверяем ВСЁ, потом списываем',
    why: 'Частично отгруженная сделка хуже неотгруженной: товар ушёл, а документ не сходится' },

  // ── Тесты не должны быть привязаны к одной базе ────────────────────
  { dir: 'server/test', mustNotContainText: "PGDATABASE: 'shop_dev'",
    why: 'Тест с жёсткой базой создаёт данные в одной базе, а проверяет в другой — и врёт, что проверил' },
  { dir: 'server/test', mustNotContainText: "database: 'shop_dev'",
    why: 'То же для прямых подключений внутри теста' },

  // ── Касса: экраны и ввод (этап 9) ──────────────────────────────────
  { file: 'pos-desktop/renderer/app.js', must: 'document.body.appendChild(pad)',
    why: 'Клавиатура отрисовывается: у соседей её подключили и забыли показать — кассир не смог закрыть смену' },
  { file: 'pos-desktop/renderer/app.js', must: "document.addEventListener('focusin'",
    why: 'Клавиатура появляется сама на числовых полях — подключить её к новому экрану невозможно забыть' },
  { file: 'pos-desktop/renderer/app.js', must: 'K.saveState({ parked })',
    why: 'Отложенные чеки на диске: касса может закрыться, а покупатель вернётся' },
  { file: 'pos-desktop/electron/store.cjs', must: 'process.env.TABYS_DATA_DIR',
    why: 'Папку данных можно задать — без этого хранилище кассы невозможно проверить тестами' },

  // ── Обновление кассы и печать (этап 10) ────────────────────────────
  { file: 'pos-desktop/electron/updater.cjs', must: 'if (state.shift) return { skip',
    why: 'Обновление посреди смены — остановка торговли. При открытой смене даже не предлагаем' },
  { file: 'pos-desktop/electron/updater.cjs', must: 'sum !== meta.sha256',
    why: 'Битый установщик ломает работающую кассу — хуже, чем не обновиться' },
  { file: 'pos-desktop/electron/printer.cjs', must: 'function buildDiagnostic',
    why: 'Диагностический лист: по рамке и линейке сразу видно ширину ленты и кодировку' },
  { file: 'pos-desktop/renderer/app.js', must: 'K.printDiagnostic()',
    why: 'Кнопка печатает диагностику, а не «пробную строку»: строка печатается и при неверных настройках' },

  // ── Публичный API (этап 11) ────────────────────────────────────────
  { file: 'server/src/api/public-api.module.ts', must: 'sha256(key)',
    why: 'Ключ хранится отпечатком, как пароль: утечка базы не должна стать утечкой всех ключей' },
  { file: 'server/src/api/public-api.module.ts', must: '@UseGuards(ApiKeyGuard)',
    why: 'Проверка ключа только на разделе v1: общая сломала бы вход кабинета и кассы' },
  { file: 'server/src/api/public-api.module.ts', must: 'needScope(req',
    why: 'Права ключа ограничивают разделы: программе для выгрузки продаж не нужно менять цены' },
  { file: 'server/src/api/public-api.module.ts', must: 'this.db.withTenant(this.tenant(req)',
    why: 'Каждый запрос идёт в контексте своего магазина — иначе ключ увидел бы чужие данные' },
  { file: 'server/src/verification/verification.provider.ts', must: 'СНЯТА С УЧЁТА',
    why: 'Снятая с учёта касса: чеки не доходят в налоговую, штраф выпишут задним числом' },

  // ── Настройки вместо переделок (этап 12) ───────────────────────────
  { file: 'db/migrations/048_day_start.sql', must: 'day_start_hour smallint NOT NULL DEFAULT 0',
    why: 'Граница дня — настройка со значением по умолчанию: у соседей она зашита числом, и любое исключение требует правки кода' },
  { file: 'server/src/admin/company-settings.module.ts', must: 'ReportService.forgetDayStart',
    why: 'Кэш сбрасывается при смене: иначе владелец меняет границу, видит старые цифры и решает, что настройка не работает' },
  { file: 'server/src/auth/sms.provider.ts', must: 'return new MockSmsProvider()',
    why: 'Без ключа шлюза работает заглушка: неоплаченный счёт у оператора связи не должен останавливать регистрацию' },
  { file: 'server/src/auth/auth.service.ts', must: 'if (!res.ok) console.warn',
    why: 'Ошибка отправки СМС не ломает запрос кода — код уже создан и живёт в базе' },

  // ── Дизайн (редизайн 2026) ─────────────────────────────────────────
  { file: 'admin/app/layout.tsx', must: 'next/font/local',
    why: 'Шрифт лежит у нас: у клиентов в областях медленный интернет, и внешний запрос задерживает показ' },
  { file: 'admin/app/layout.tsx', mustNot: 'next/font/google',
    why: 'Сборка не должна зависеть от доступности чужого сервиса — она уже падала на этом' },
  { file: 'admin/lib/ui.tsx', must: 'data-label',
    why: 'Подписи полей в карточках на телефоне: без них столбик голых чисел нечитаем' },
  { file: 'admin/lib/ui.tsx', must: 'min-height:44px',
    why: 'Тап-цели на телефоне: промах по кнопке «Оплата» стоит дороже шести пикселей' },
  { file: 'admin/lib/ui.tsx', must: "confirmed:",
    why: 'Статус задачи AI: его перевод жил тернаркой в ai/page.tsx — второй перевод статусов' },
  { file: 'admin/lib/ui.tsx', must: 'export function BaseStyles',
    why: 'Печать, сброс страницы и карточки на телефоне живут в одном месте, а не копируются по страницам' },

  // ── Право billing отдельно от settings ─────────────────────────────
  { file: 'shared/permissions.json', must: '"billing"',
    why: 'Подписка — деньги, настройки — фискализация. Бухгалтеру можно дать оплату счетов, не открывая настройку касс' },
  { file: 'server/src/admin/admin.module.ts', must: "RequirePermission('billing'",
    why: 'Эндпоинты подписки под своим правом: иначе раздел «Подписка» виден только тем, у кого доступ к настройкам' },
  { file: 'server/src/reports/report.service.ts', must: 'async openShifts',
    why: 'Открытые смены одной выборкой на два ответа: две копии разъезжаются, и одна начинает показывать не то' },

  { file: 'deploy/05_update.sh', must: '"$SRC"/scripts "$DST"',
    why: 'Папка scripts должна доезжать на сервер: без неё нечем наполнить магазин данными и проверить правила' },
  { file: 'deploy/docker-compose.prod.yml', must: '../scripts:/app/scripts:ro',
    why: 'Скрипты подключены к контейнеру: Node.js стоит только внутри, на самой машине его нет' },

  // ── Адреса страниц сайта (этап сайта) ──────────────────────────────
  { dir: 'admin/app', mustNotContainFile: 'цены',
    why: 'Кириллица в адресе страницы: Next.js 14 её собирает, но при запросе отдаёт 404 — проверено на живом сервере' },

  // ── Сигналы в шапке кабинета ───────────────────────────────────────
  { file: 'server/src/admin/alerts.module.ts', must: "kind: 'shift_diff'",
    why: 'Расхождение по смене первым: прямой признак недостачи, и чем раньше спросить, тем больше шансов вспомнить' },
  { file: 'server/src/admin/alerts.module.ts', must: "interval '18 hours'",
    why: 'Открытая смена сегодня — не сигнал, магазин работает. Сигнал только если висит со вчера' },

  // ── Маркировка в продаже ───────────────────────────────────────────
  { file: 'server/src/pos/pos.service.ts', must: "SET status='sold', sale_id=$2, sold_at=now()",
    why: 'Коды марок выводятся В ТОЙ ЖЕ транзакции, что и чек: своя транзакция не видит незавершённую продажу, и ссылка упирается во внешний ключ' },
  { file: 'server/src/pos/pos.service.ts', must: 'код не выведен из оборота',
    why: 'Ошибка кода не отменяет продажу: деньги приняты, чек пробит — иначе касса встанет посреди очереди из-за нечитаемой марки' },

  // ── Маркировка в продаже с кассы ───────────────────────────────────
  { file: 'server/src/pos/pos.service.ts', must: "SET status='sold', sale_id=$2",
    why: 'Коды марок выводятся из оборота продажей: нет кода в чеке — административка, и её выпишут без жалобы покупателя' },
  { file: 'server/src/pos/pos.service.ts', must: 'for (const mark of (it.marks',
    why: 'Коды считаются поштучно: две бутылки — два кода, каждый выводится отдельно' },

  // ── Платформа: партнёры и деньги ───────────────────────────────────
  { file: 'server/src/platform/platform.module.ts', must: "Подтверждает только владелец платформы",
    why: 'Главное правило донора: партнёр доводит клиента до работы, деньги включает владелец — одна точка на всю систему' },
  { file: 'db/migrations/052_platform.sql', must: "p_role = 'super' OR tc.partner_id = p_user",
    why: 'Партнёр видит только своих. Правило живёт в функции базы, а не в коде: забыть добавить условие в новый запрос невозможно' },
  { file: 'db/migrations/052_platform.sql', must: 'greatest(coalesce(v_from, now()), now())',
    why: 'Досрочная оплата не сжигает остаток: иначе заплативший заранее теряет дни и больше никогда не платит вперёд' },
  { file: 'db/migrations/052_platform.sql', must: "coalesce(tc.is_demo, false) = false",
    why: 'Демо исключены из сводки: иначе она врёт, а по ней принимают решения' },
  { file: 'server/src/platform/platform.module.ts', must: 'Напишите причину',
    why: 'Отклонение требует причины: партнёр должен понять, что не так, а не гадать' },

  { file: 'server/src/billing/billing.service.ts', must: 'canCloseShift: true',
    why: 'Закрытие смены работает даже при закрытых продажах: в ящике чужие деньги, они обязаны сойтись' },
  { file: 'server/src/automation/scheduler.module.ts', must: 'last_sent_at < current_date',
    why: 'Рассылка не повторяется при перезапуске сервера: проход повторится, а письмо владельцу — нет' },

  { file: 'server/src/billing/billing.service.ts', must: 'const period = view.periods.find',
    why: 'Сумма берётся из своего расчёта, а не из запроса кабинета: иначе её подменят и заявят оплату на тенге' },
  { file: 'server/src/billing/billing.service.ts', must: 'отправлять вторую не нужно',
    why: 'Вторая отправка отбита: иначе клиент отправит дважды и будет ждать подтверждения вдвое дольше' },

  { dir: 'admin/app', mustNotContainText: 'window.confirm(',
    why: 'Системное окно нельзя оформить: последствие выглядит продолжением вопроса, и человек жмёт «ОК», не дочитав' },
  { file: 'admin/lib/ui.tsx', must: 'cancel.focus()',
    why: 'В опасном окне наведено на «Отмена»: случайный Enter не должен запускать необратимое' },

  { file: 'server/src/platform/platform.module.ts', must: 'async previewPayment',
    why: 'Предпросмотр считает сервер той же функцией, что и подтверждение: иначе правило о деньгах живёт в двух местах и разъедется' },
  { file: 'db/migrations/052_platform.sql', must: 'tc.deal_note, tc.touched_at',
    why: 'Заметка и дата касания в воронке: без них партнёр видит этап, но не помнит, о чём говорили' },

  { file: 'server/src/platform/platform.module.ts', must: 'if (days >= 10) proRata',
    why: 'Правило десяти дней: спорить из-за трёхсот тенге в конце месяца дороже самих трёхсот, а обиду клиент запомнит' },
  { file: 'db/migrations/052_platform.sql', must: "coalesce(tc.is_demo, false) = false\n  LOOP",
    why: 'Учебные отсекаются внутри функции массового действия: новое действие иначе однажды заденет демо партнёра' },
  { file: 'server/src/platform/platform.module.ts', must: 'async bulkPreview',
    why: 'Массовое действие всегда сначала показывает, кого затронет: «применилось к 47 клиентам» постфактум узнавать нельзя' },

  { file: 'deploy/14_platform_user.sh', must: 'PU_PASS',
    why: 'Пароль передаётся переменной окружения, а не в строке команды: иначе PowerShell и оболочка съедают $ и !, и войти нечем' },

  // ── Перенесённый кабинет платформы ─────────────────────────────────
  { file: 'admin/app/platform/src/main.tsx', must: 'const ROUTE:',
    why: 'Все пути перенесённого кабинета переводятся в одной таблице: изменится сервер — править надо в одном месте' },
  { file: 'admin/app/platform/page.tsx', must: 'ssr: false',
    why: 'Кабинет читает ключ входа из хранилища браузера при запуске: на сервере такого хранилища нет, сборка падает' },
  { file: 'server/src/platform/platform.module.ts', must: 'слово в слово',
    why: 'Удаление требует набрать название: оно необратимо, а «случайно нажал» с чужими деньгами не шутка' },
  { file: 'db/migrations/052_platform.sql', must: "status = 'deleted'",
    why: 'Удаление мягкое: магазин отключается, данные остаются — их могут спросить и через год при разбирательстве' },

  { file: 'deploy/05_update.sh', must: '--delete',
    why: 'Обновление удаляет файлы, которых больше нет: иначе убранная страница остаётся на сервере навсегда и продолжает работать' },

  // ── Уборка на сервере: опасные команды под запретом ────────────────
  { file: 'deploy/11_server_hygiene.sh', mustNot: /^\s*docker system prune/m,
    why: 'system prune с томами снесёт базы, включая чеки живого клиента ресторана' },
  { file: 'deploy/11_server_hygiene.sh', mustNot: /^\s*docker image prune -a/m,
    why: 'image prune -a снесёт рабочие образы, и ресторан не поднимется после перезапуска' },
  { file: 'deploy/11_server_hygiene.sh', must: 'until=168h',
    why: 'Чистим только кэш старше недели: свежий нужен для быстрых сборок' },

  // ── Кабинет: решение по зависимостям ───────────────────────────────
  { file: 'admin/next.config.js', mustNot: 'rewrites',
    why: 'Переадресаций нет — на этом основано решение остаться на 14-й версии' },
  { dir: 'admin/app', mustNotContainFile: 'middleware.ts',
    why: 'Посредника нет — часть обоснования решения по зависимостям' },
  { dir: 'admin/app', mustNotContainText: "'use server'",
    why: 'Серверных действий нет. Появятся — переход на новую версию становится обязательным' },
];

let fails = 0, checked = 0;
const bad = [];

for (const r of RULES) {
  checked++;
  if (r.dir) {
    // правила по папке: обход всех файлов
    const walk = (d) => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })
      .flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    let files = [];
    try { files = walk(r.dir); } catch { bad.push([`папка ${r.dir}`, 'не найдена', r.why]); fails++; continue; }
    if (r.mustNotContainFile) {
      const hit = files.find((f) => path.basename(f) === r.mustNotContainFile);
      if (hit) { bad.push([hit, `появился ${r.mustNotContainFile}`, r.why]); fails++; }
    }
    if (r.mustNotContainText) {
      const hit = files.find((f) => (read(f) || '').includes(r.mustNotContainText));
      if (hit) { bad.push([hit, `появилось «${r.mustNotContainText}»`, r.why]); fails++; }
    }
    continue;
  }

  const src = read(r.file);
  if (src === null) { bad.push([r.file, 'файл не найден', r.why]); fails++; continue; }

  if (r.must && !src.includes(r.must)) {
    bad.push([r.file, `пропало «${r.must}»`, r.why]); fails++;
  }
  if (r.mustNot) {
    const found = r.mustNot instanceof RegExp ? r.mustNot.test(src) : src.includes(r.mustNot);
    if (found) { bad.push([r.file, `появилось запрещённое «${r.mustNot}»`, r.why]); fails++; }
  }
}

if (fails === 0) {
  console.log(`✔ Сторожа: ${checked} правил, всё на месте`);
  process.exit(0);
}
console.log(`✘ Сторожа: нарушено ${fails} из ${checked}\n`);
for (const [file, what, why] of bad) {
  console.log(`  ${file}`);
  console.log(`    ${what}`);
  console.log(`    зачем: ${why}\n`);
}
process.exit(1);
