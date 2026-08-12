import 'package:drift/drift.dart';

/// ЛОКАЛЬНАЯ БАЗА КАССЫ.
///
/// Главное правило: касса читает и пишет только сюда. Сеть — фоновый обмен,
/// а не условие работы. Продажа не ждёт сервер никогда.
///
/// Здесь же лежит очередь непереданных событий. У Wipon в документации прямо
/// написано, что непереданные локальные продажи теряются при удалении папки
/// приложения — у нас очередь в той же базе, что и данные, и при удалении
/// приложения пользователь получает предупреждение с числом неотправленных.

/// Сотрудники с хэшами PIN — приезжают при привязке (bootstrap).
/// Именно это делает вход возможным без интернета.
class Staff extends Table {
  TextColumn get id => text()();
  TextColumn get firstName => text()();
  TextColumn get lastName => text().nullable()();
  TextColumn get pinHash => text()();               // bcrypt, тот же что на сервере
  TextColumn get badgeBarcode => text().nullable()();
  BoolColumn get isShiftAdmin => boolean().withDefault(const Constant(false))();
  BoolColumn get isOwner => boolean().withDefault(const Constant(false))();
  TextColumn get roleCode => text().nullable()();
  TextColumn get permissions => text().withDefault(const Constant('{}'))();  // JSON
  BoolColumn get canSeeRevenue => boolean().withDefault(const Constant(false))();
  BoolColumn get canSeePurchasePrice => boolean().withDefault(const Constant(false))();

  @override
  Set<Column> get primaryKey => {id};
}

/// Разрешения кассы (профиль точки из UMAG) — тоже локально,
/// чтобы правила работы кассы действовали офлайн.
class PosSettings extends Table {
  IntColumn get id => integer().withDefault(const Constant(1))();
  TextColumn get json => text()();                  // весь профиль целиком
  DateTimeColumn get syncedAt => dateTime()();

  @override
  Set<Column> get primaryKey => {id};
}

/// Кто сейчас за кассой. Мультиаккаунт (модель Wipon): одна смена,
/// переключение по PIN, каждая операция подписана исполнителем.
class LocalSessions extends Table {
  TextColumn get id => text()();
  TextColumn get staffId => text().references(Staff, #id)();
  DateTimeColumn get startedAt => dateTime()();
  DateTimeColumn get endedAt => dateTime().nullable()();
  TextColumn get endReason => text().nullable()();
  BoolColumn get offline => boolean().withDefault(const Constant(false))();

  @override
  Set<Column> get primaryKey => {id};
}

/// Очередь событий на отправку. Сплошная нумерация clientSeq —
/// сервер по ней видит, всё ли устройство отдало (иначе инвентаризация
/// считает неправду, как предупреждает UMAG).
class Outbox extends Table {
  TextColumn get id => text()();                    // UUID: повтор отправки не создаст дубль
  IntColumn get clientSeq => integer()();
  TextColumn get entity => text()();
  TextColumn get entityId => text()();
  TextColumn get op => text()();                    // insert / update / delete
  TextColumn get payload => text()();               // JSON
  IntColumn get baseSeq => integer().nullable()();  // версия строки, которую видели → детект конфликта
  DateTimeColumn get clientTs => dateTime()();
  DateTimeColumn get sentAt => dateTime().nullable()();
  IntColumn get attempts => integer().withDefault(const Constant(0))();
  TextColumn get lastError => text().nullable()();

  @override
  Set<Column> get primaryKey => {id};
}

/// Курсор: докуда вычитали серверные события.
class SyncState extends Table {
  IntColumn get id => integer().withDefault(const Constant(1))();
  IntColumn get pulledSeq => integer().withDefault(const Constant(0))();
  IntColumn get nextClientSeq => integer().withDefault(const Constant(1))();
  DateTimeColumn get lastPullAt => dateTime().nullable()();
  DateTimeColumn get lastPushAt => dateTime().nullable()();

  @override
  Set<Column> get primaryKey => {id};
}

/// Попытки входа: блокировка перебора PIN работает и без сети.
class LoginAttempts extends Table {
  IntColumn get id => integer().autoIncrement()();
  BoolColumn get success => boolean()();
  DateTimeColumn get ts => dateTime()();
}

/// Подтверждения старшего (модель UMAG, расширенная): бейдж или PIN,
/// работает офлайн, в журнале две подписи — кто сделал и кто разрешил.
class Approvals extends Table {
  TextColumn get id => text()();
  TextColumn get requestedBy => text()();
  TextColumn get approvedBy => text()();
  TextColumn get action => text()();
  TextColumn get method => text()();                // badge / pin
  DateTimeColumn get approvedAt => dateTime()();
  BoolColumn get offline => boolean().withDefault(const Constant(true))();

  @override
  Set<Column> get primaryKey => {id};
}

// =====================================================================
// ТОРГОВЫЕ ТАБЛИЦЫ (часть 16). Каталог приезжает снимком /pos/goods/catalog
// при привязке, дальше — дельтами sync/pull. Чеки и смены рождаются здесь
// и уезжают на сервер событиями через Outbox.
// =====================================================================

/// Товары. Цена и себестоимость лежат локально: чек считается на кассе
/// целиком (решение части 4), сервер принимает факт и не пересчитывает.
class Products extends Table {
  TextColumn get id => text()();
  IntColumn get code => integer().nullable()();          // короткий код: весовой ШК, быстрый ввод
  TextColumn get name => text()();
  TextColumn get nameKk => text().nullable()();
  TextColumn get kind => text().withDefault(const Constant('simple'))(); // simple/weight/service/bundle
  TextColumn get categoryId => text().nullable()();
  TextColumn get unit => text().nullable()();
  RealColumn get price => real().withDefault(const Constant(0))();
  RealColumn get cost => real().withDefault(const Constant(0))();       // средневзвешенная на момент снимка
  RealColumn get minPrice => real().nullable()();        // ниже — только с подтверждением старшего (МС)
  RealColumn get vatRate => real().nullable()();
  TextColumn get ntin => text().nullable()();
  IntColumn get pluCode => integer().nullable()();
  BoolColumn get trackStock => boolean().withDefault(const Constant(true))();
  BoolColumn get isQuick => boolean().withDefault(const Constant(false))(); // плитка быстрых товаров (UMAG)
  TextColumn get quickGroup => text().nullable()();
  BoolColumn get archived => boolean().withDefault(const Constant(false))();

  @override
  Set<Column> get primaryKey => {id};
}

/// Штрихкоды отдельно: у товара их несколько (пачка и блок — модель МС).
class Barcodes extends Table {
  TextColumn get code => text()();
  TextColumn get productId => text().references(Products, #id)();
  BoolColumn get isPrimary => boolean().withDefault(const Constant(false))();

  @override
  Set<Column> get primaryKey => {code};
}

class Categories extends Table {
  TextColumn get id => text()();
  TextColumn get name => text()();
  TextColumn get parentId => text().nullable()();

  @override
  Set<Column> get primaryKey => {id};
}

/// Смены кассы. offlineOpened — открыта без сети (флаг честности, часть 4).
class Shifts extends Table {
  TextColumn get id => text()();
  IntColumn get number => integer()();
  TextColumn get openedBy => text()();
  DateTimeColumn get openedAt => dateTime()();
  RealColumn get openingFloat => real().withDefault(const Constant(0))();
  DateTimeColumn get closedAt => dateTime().nullable()();
  TextColumn get closedBy => text().nullable()();
  RealColumn get actualCash => real().nullable()();
  RealColumn get discrepancy => real().nullable()();
  TextColumn get discrepancyComment => text().nullable()();
  TextColumn get status => text().withDefault(const Constant('open'))(); // open/closed
  BoolColumn get offlineOpened => boolean().withDefault(const Constant(false))();

  @override
  Set<Column> get primaryKey => {id};
}

/// Чеки. status: draft (в корзине) / parked (отложен, лимит 100 — МС) /
/// completed / refunded. Оплаты — JSON: методов максимум четыре, отдельная
/// таблица не окупается на кассе.
class Sales extends Table {
  TextColumn get id => text()();
  TextColumn get shiftId => text().references(Shifts, #id)();
  IntColumn get localNumber => integer()();
  TextColumn get status => text().withDefault(const Constant('draft'))();
  TextColumn get employeeId => text()();
  TextColumn get consultantId => text().nullable()();     // продавец в чеке (UMAG)
  TextColumn get customerId => text().nullable()();       // обязателен для продажи в долг (Wipon)
  RealColumn get subtotal => real().withDefault(const Constant(0))();
  RealColumn get discountSum => real().withDefault(const Constant(0))();
  RealColumn get rounding => real().withDefault(const Constant(0))();   // ≤0: всегда в пользу покупателя
  RealColumn get total => real().withDefault(const Constant(0))();
  RealColumn get costTotal => real().withDefault(const Constant(0))();
  TextColumn get paymentJson => text().withDefault(const Constant('{}'))(); // {cash,card,qr,credit,change}
  TextColumn get refundOfId => text().nullable()();       // возврат ссылается на исходный чек
  DateTimeColumn get createdAt => dateTime()();
  DateTimeColumn get completedAt => dateTime().nullable()();

  @override
  Set<Column> get primaryKey => {id};
}

class SaleItems extends Table {
  TextColumn get id => text()();
  TextColumn get saleId => text().references(Sales, #id)();
  TextColumn get productId => text()();
  TextColumn get name => text()();                        // имя на момент продажи: карточку могут переименовать
  RealColumn get qty => real()();
  RealColumn get price => real()();
  RealColumn get discountSum => real().withDefault(const Constant(0))();
  RealColumn get total => real()();
  RealColumn get cost => real().withDefault(const Constant(0))();
  RealColumn get vatRate => real().nullable()();
  TextColumn get ntin => text().nullable()();

  @override
  Set<Column> get primaryKey => {id};
}

/// Внесения и изъятия: размен утром, выемка вечером.
class CashOps extends Table {
  TextColumn get id => text()();
  TextColumn get shiftId => text().references(Shifts, #id)();
  TextColumn get kind => text()();                        // deposit / withdrawal / collection
  RealColumn get amount => real()();
  TextColumn get comment => text().nullable()();
  TextColumn get employeeId => text()();
  TextColumn get approvedBy => text().nullable()();
  DateTimeColumn get ts => dateTime()();

  @override
  Set<Column> get primaryKey => {id};
}

/// Журнал отмен позиций (антифрод UMAG): «100→98» видно даже офлайн.
class CancelledItems extends Table {
  TextColumn get id => text()();
  TextColumn get saleId => text().nullable()();
  TextColumn get shiftId => text()();
  TextColumn get productId => text()();
  RealColumn get qtyAdded => real()();
  RealColumn get qtyCancelled => real()();
  RealColumn get price => real().nullable()();
  TextColumn get employeeId => text()();
  TextColumn get approvedBy => text().nullable()();       // отмена после пречека — только со старшим
  DateTimeColumn get ts => dateTime()();

  @override
  Set<Column> get primaryKey => {id};
}

/// Покупатели (часть 17). Снимок при привязке + дельты 'customer' из pull.
/// Долг и лимит лежат локально: «в долг» работает офлайн, лимит проверяется
/// без сервера (модель Wipon: долг только при выбранном клиенте; лимит — наш).
/// Балансы после своих операций касса правит сама; чужие изменения долга
/// освежаются онлайн-запросом перед оплатой, когда сеть есть.
class Customers extends Table {
  TextColumn get id => text()();
  TextColumn get name => text()();
  TextColumn get phone => text().nullable()();
  TextColumn get iinBin => text().nullable()();
  TextColumn get loyaltyCard => text().nullable()();      // карта/QR — скан сканером
  RealColumn get debt => real().withDefault(const Constant(0))();
  RealColumn get debtLimit => real().nullable()();        // NULL = без лимита
  IntColumn get debtDays => integer().nullable()();
  RealColumn get bonuses => real().withDefault(const Constant(0))();

  @override
  Set<Column> get primaryKey => {id};
}
