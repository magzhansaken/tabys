import 'dart:convert';
import 'package:drift/drift.dart';
import 'package:flutter/foundation.dart';
import 'package:uuid/uuid.dart';
import '../data/local_db.dart';
import 'api_client.dart';
import 'offline_auth.dart';
import 'sync_engine.dart';
import '../domain/cart.dart';

/// СОСТОЯНИЕ КАССЫ: устройство → кассир → смена → чек.
/// Все операции пишут в локальную базу и в Outbox одной транзакцией —
/// сеть на исход операции не влияет никогда (критерий части 4).
class PosSession extends ChangeNotifier {
  PosSession(this.db, this.api, this.sync) {
    auth = OfflineAuth(db);
  }

  final LocalDb db;
  final ApiClient api;
  final SyncEngine sync;
  late final OfflineAuth auth;

  StaffData? currentStaff;
  Shift? currentShift;
  Map<String, dynamic> posProfile = {};
  final Cart cart = Cart();
  int _localNumber = 0;

  bool get paired => currentStaffLoaded;
  bool currentStaffLoaded = false;

  // ==================================================================
  // ПРИВЯЗКА: код из кабинета → токен устройства → bootstrap → каталог
  // ==================================================================
  Future<void> pair(String code, {required String platform, required String appVersion}) async {
    final r = await api.post('/pos/pair', {'code': code, 'platform': platform, 'appVersion': appVersion});
    await api.saveToken(r['deviceToken'] as String);

    final bs = await api.get('/pos/bootstrap');
    await _storeBootstrap(bs as Map<String, dynamic>);

    final cat = await api.get('/pos/goods/catalog') as Map<String, dynamic>;
    await _storeCatalog(cat);
    final cust = await api.get('/pos/customers/catalog') as Map<String, dynamic>;
    await _storeCustomers(cust);
    currentStaffLoaded = true;
    notifyListeners();
  }

  Future<void> _storeBootstrap(Map<String, dynamic> bs) async {
    await db.transaction(() async {
      await db.delete(db.staff).go();
      for (final s in (bs['staff'] as List).cast<Map<String, dynamic>>()) {
        if (s['pos_pin_hash'] == null) continue;      // без PIN на кассу не входят
        await db.into(db.staff).insertOnConflictUpdate(StaffCompanion.insert(
              id: s['id'] as String,
              firstName: s['first_name'] as String,
              lastName: Value(s['last_name'] as String?),
              pinHash: s['pos_pin_hash'] as String,
              badgeBarcode: Value(s['badge_barcode'] as String?),
              isShiftAdmin: Value(s['is_shift_admin'] as bool? ?? false),
              isOwner: Value(s['is_owner'] as bool? ?? false),
              roleCode: Value(s['role_code'] as String?),
              permissions: Value(jsonEncode(s['permissions'] ?? {})),
              canSeeRevenue: Value(s['can_see_revenue'] as bool? ?? false),
              canSeePurchasePrice: Value(s['can_see_purchase_price'] as bool? ?? false),
            ));
      }
      posProfile = (bs['posProfile'] as Map?)?.cast<String, dynamic>() ?? {};
      // правила бонусов приезжают отдельным полем — храним внутри профиля
      if (bs['loyaltyProgram'] != null) posProfile['_loyalty'] = bs['loyaltyProgram'];
      // консультанты точки: выбор «продавца в чеке» работает офлайн (UMAG)
      posProfile['_consultants'] = bs['consultants'] ?? [];
      // брендирование чека: логотип уже растеризован сервером (часть 21)
      if (bs['branding'] != null) posProfile['_branding'] = bs['branding'];
      await db.into(db.posSettings).insertOnConflictUpdate(PosSettingsCompanion(
            id: const Value(1), json: Value(jsonEncode(posProfile)), syncedAt: Value(DateTime.now())));
    });
    cart.roundTo = (posProfile['roundTo'] as num?)?.toInt() ?? 5;
    final lp = posProfile['_loyalty'] as Map?;
    if (lp != null) {
      cart.loyalty = LoyaltyRules(
        earnPercent: (lp['earnPercent'] as num?)?.toDouble() ?? 0,
        spendPercent: (lp['spendPercent'] as num?)?.toDouble() ?? 50,
        maxSpend: (lp['maxSpend'] as num?)?.toDouble() ?? 5000,
        minPurchase: (lp['minPurchase'] as num?)?.toDouble() ?? 0,
      );
    }
  }

  Future<void> _storeCustomers(Map<String, dynamic> cat) async {
    await db.transaction(() async {
      for (final c in (cat['customers'] as List).cast<Map<String, dynamic>>()) {
        await db.into(db.customers).insertOnConflictUpdate(CustomersCompanion.insert(
              id: c['id'] as String,
              name: c['name'] as String,
              phone: Value(c['phone'] as String?),
              iinBin: Value(c['iin_bin'] as String?),
              loyaltyCard: Value(c['loyalty_card'] as String?),
              debt: Value((c['debt'] as num?)?.toDouble() ?? 0),
              debtLimit: Value((c['debt_limit'] as num?)?.toDouble()),
              debtDays: Value((c['debt_days'] as num?)?.toInt()),
              bonuses: Value((c['bonuses'] as num?)?.toDouble() ?? 0),
            ));
      }
    });
  }

  // ==================================================================
  // ПОКУПАТЕЛЬ В ЧЕКЕ (часть 17)
  // ==================================================================

  /// Прикрепить покупателя. Если сеть есть — освежаем долг и бонусы с
  /// сервера (их могла изменить другая касса); без сети — локальный снимок.
  Future<void> attachCustomer(Customer c) async {
    var debt = c.debt, bonuses = c.bonuses;
    try {
      final fresh = await api.get('/pos/customers/${c.id}') as Map<String, dynamic>;
      debt = (fresh['debt'] as num).toDouble();
      bonuses = (fresh['bonuses'] as num).toDouble();
      await (db.update(db.customers)..where((t) => t.id.equals(c.id)))
          .write(CustomersCompanion(debt: Value(debt), bonuses: Value(bonuses)));
    } catch (_) {/* офлайн: работаем по снимку */}
    cart.customerId = c.id;
    cart.customerName = c.name;
    cart.customerDebt = debt;
    cart.customerDebtLimit = c.debtLimit;
    cart.customerBonuses = bonuses;
    notifyListeners();
  }

  List<Map<String, dynamic>> get consultants =>
      ((posProfile['_consultants'] as List?) ?? []).cast<Map<String, dynamic>>();

  /// Новый покупатель с кассы (реальность магазина у дома: должника заводят
  /// у кассы). Уезжает событием 'customer'; владелец дозаполнит в кабинете.
  Future<Customer> createCustomer(String name, {String? phone}) async {
    final id = const Uuid().v4();
    await db.into(db.customers).insert(CustomersCompanion.insert(
          id: id, name: name.trim(), phone: Value(phone)));
    await sync.enqueue(entity: 'customer', entityId: id, op: 'insert',
        payload: {'name': name.trim(), if (phone != null) 'phone': phone},
        employeeId: currentStaff!.id);
    final c = await (db.select(db.customers)..where((t) => t.id.equals(id))).getSingle();
    notifyListeners();
    return c;
  }

  void detachCustomer() {
    cart.customerId = null;
    cart.customerName = null;
    cart.customerDebt = 0;
    cart.customerDebtLimit = null;
    cart.customerBonuses = 0;
    cart.creditApprovedBy = null;
    notifyListeners();
  }

  /// Погашение долга у кассы (долговая книга Wipon: сумма, тип, дата,
  /// остаток). Наличные попадают в ящик — локальный X-отчёт это видит.
  Future<double> payCustomerDebt(Customer c, double amount, {String method = 'cash'}) async {
    final pay = amount > c.debt ? c.debt : amount;   // переплату в минус не пишем
    if (pay <= 0) throw StateError('Долга нет');
    final id = const Uuid().v4();
    await db.transaction(() async {
      await (db.update(db.customers)..where((t) => t.id.equals(c.id)))
          .write(CustomersCompanion(debt: Value(c.debt - pay)));
      if (method == 'cash' && currentShift != null) {
        await db.into(db.cashOps).insert(CashOpsCompanion.insert(
              id: id, shiftId: currentShift!.id, kind: 'deposit', amount: pay,
              comment: Value('Погашение долга: ${c.name}'),
              employeeId: currentStaff!.id, ts: DateTime.now()));
      }
    });
    await sync.enqueue(entity: 'debt_payment', entityId: id, op: 'insert',
        payload: {'counterpartyId': c.id, 'amount': pay, 'method': method,
          if (currentShift != null) 'shiftId': currentShift!.id},
        employeeId: currentStaff!.id);
    notifyListeners();
    return pay;
  }

  Future<void> _storeCatalog(Map<String, dynamic> cat) async {
    await db.transaction(() async {
      for (final p in (cat['products'] as List).cast<Map<String, dynamic>>()) {
        await db.into(db.products).insertOnConflictUpdate(ProductsCompanion.insert(
              id: p['id'] as String,
              name: p['name'] as String,
              code: Value((p['code'] as num?)?.toInt()),
              nameKk: Value(p['name_kk'] as String?),
              kind: Value(p['kind'] as String? ?? 'simple'),
              categoryId: Value(p['category_id'] as String?),
              unit: Value(p['unit'] as String?),
              price: Value((p['price'] as num?)?.toDouble() ?? 0),
              cost: Value((p['cost'] as num?)?.toDouble() ?? 0),
              minPrice: Value((p['min_price'] as num?)?.toDouble()),
              vatRate: Value((p['vat_rate'] as num?)?.toDouble()),
              ntin: Value(p['ntin'] as String?),
              pluCode: Value((p['plu_code'] as num?)?.toInt()),
              trackStock: Value(p['track_stock'] as bool? ?? true),
              isQuick: Value(p['is_quick'] as bool? ?? false),
              quickGroup: Value(p['quick_group'] as String?),
            ));
        for (final b in (p['barcodes'] as List? ?? []).cast<Map<String, dynamic>>()) {
          await db.into(db.barcodes).insertOnConflictUpdate(BarcodesCompanion.insert(
                code: b['code'] as String,
                productId: p['id'] as String,
                isPrimary: Value(b['primary'] as bool? ?? false),
              ));
        }
      }
      for (final c in (cat['categories'] as List).cast<Map<String, dynamic>>()) {
        await db.into(db.categories).insertOnConflictUpdate(CategoriesCompanion.insert(
              id: c['id'] as String, name: c['name'] as String, parentId: Value(c['parent_id'] as String?)));
      }
      // курсор дельт = seq снимка: ни потерь, ни дублей
      await db.into(db.syncState).insertOnConflictUpdate(SyncStateCompanion(
            id: const Value(1), pulledSeq: Value(cat['serverSeq'] as int)));
    });
  }

  // ==================================================================
  // ВХОД: PIN офлайн (часть 1.2), онлайн — сервер логирует
  // ==================================================================
  Future<bool> login(String pin) async {
    final s = await auth.loginByPin(pin);
    if (s == null) return false;
    currentStaff = s;
    // сервер узнаёт о входе, когда сеть есть — но входу это не мешает
    try { await api.post('/pos/login', {'pin': pin, 'offline': false}); } catch (_) {}
    await _restoreShift();
    notifyListeners();
    return true;
  }

  Future<void> _restoreShift() async {
    currentShift = await (db.select(db.shifts)..where((t) => t.status.equals('open'))..limit(1))
        .getSingleOrNull();
    if (currentShift != null) {
      final n = await db.customSelect(
        'SELECT coalesce(max(local_number),0) AS n FROM sales WHERE shift_id = ?',
        variables: [Variable.withString(currentShift!.id)],
      ).getSingle();
      _localNumber = n.read<int>('n');
    }
  }

  // ==================================================================
  // СМЕНА: открыть / внесение-изъятие / закрыть — всё офлайн-способно
  // ==================================================================
  Future<Shift> openShift(double openingFloat) async {
    if (currentShift != null) throw StateError('Смена №${currentShift!.number} уже открыта');
    final id = const Uuid().v4();
    final last = await db.customSelect('SELECT coalesce(max(number),0) AS n FROM shifts').getSingle();
    final number = last.read<int>('n') + 1;
    final now = DateTime.now();

    await db.transaction(() async {
      await db.into(db.shifts).insert(ShiftsCompanion.insert(
            id: id, number: number, openedBy: currentStaff!.id, openedAt: now,
            openingFloat: Value(openingFloat), offlineOpened: const Value(true)));
    });
    await sync.enqueue(entity: 'shift', entityId: id, op: 'insert',
        payload: {'number': number, 'openedAt': now.toUtc().toIso8601String(), 'openingFloat': openingFloat},
        employeeId: currentStaff!.id);

    currentShift = await (db.select(db.shifts)..where((t) => t.id.equals(id))).getSingle();
    _localNumber = 0;
    notifyListeners();
    return currentShift!;
  }

  Future<void> cashOperation(String kind, double amount, {String? comment, String? approvedBy}) async {
    final id = const Uuid().v4();
    await db.into(db.cashOps).insert(CashOpsCompanion.insert(
          id: id, shiftId: currentShift!.id, kind: kind, amount: amount,
          comment: Value(comment), employeeId: currentStaff!.id,
          approvedBy: Value(approvedBy), ts: DateTime.now()));
    await sync.enqueue(entity: 'cash_operation', entityId: id, op: 'insert',
        payload: {'shiftId': currentShift!.id, 'kind': kind, 'amount': amount,
          if (comment != null) 'comment': comment, if (approvedBy != null) 'approvedBy': approvedBy},
        employeeId: currentStaff!.id);
    notifyListeners();
  }

  /// X-отчёт: считается локально — работает офлайн (в отличие от Wipon,
  /// где отчёты живут в Консоли).
  Future<Map<String, double>> xReport() async {
    final sh = currentShift!;
    final r = await db.customSelect('''
      SELECT
        coalesce(sum(CASE WHEN status='completed' AND refund_of_id IS NULL THEN total END),0) AS revenue,
        coalesce(sum(CASE WHEN status='completed' AND refund_of_id IS NOT NULL THEN -total END),0) AS returns,
        coalesce(count(CASE WHEN status='completed' AND refund_of_id IS NULL THEN 1 END),0) AS receipts
      FROM sales WHERE shift_id = ?
    ''', variables: [Variable.withString(sh.id)]).getSingle();

    double payOf(String m) => 0; // ниже пересчитаем из JSON
    final sales = await (db.select(db.sales)
          ..where((t) => t.shiftId.equals(sh.id) & t.status.equals('completed')))
        .get();
    double cash = 0, card = 0, qr = 0, credit = 0;
    for (final s in sales) {
      final p = jsonDecode(s.paymentJson) as Map<String, dynamic>;
      final sign = s.refundOfId == null ? 1 : -1;
      cash += sign * (((p['cash'] as num?) ?? 0) - ((p['change'] as num?) ?? 0));
      card += sign * ((p['card'] as num?) ?? 0);
      qr += sign * ((p['qr'] as num?) ?? 0);
      credit += sign * ((p['credit'] as num?) ?? 0);
    }
    final ops = await (db.select(db.cashOps)..where((t) => t.shiftId.equals(sh.id))).get();
    double deposits = 0, withdrawals = 0;
    for (final o in ops) {
      if (o.kind == 'deposit') deposits += o.amount;
      if (o.kind == 'withdrawal' || o.kind == 'collection') withdrawals += o.amount;
    }
    final expectedCash = sh.openingFloat + cash + deposits - withdrawals;
    return {
      'receipts': r.read<int>('receipts').toDouble(),
      'revenue': r.read<double>('revenue'),
      'returns': r.read<double>('returns'),
      'cash': cash, 'card': card, 'qr': qr, 'credit': credit,
      'deposits': deposits, 'withdrawals': withdrawals,
      'openingFloat': sh.openingFloat, 'expectedCash': expectedCash,
    };
  }

  /// Закрытие: расхождение требует комментария (решение части 4) —
  /// и это правило работает офлайн.
  Future<Map<String, double>> closeShift(double actualCash, {String? comment}) async {
    final parked = await (db.select(db.sales)
          ..where((t) => t.shiftId.equals(currentShift!.id) & t.status.equals('parked')))
        .get();
    if (parked.isNotEmpty) {
      throw StateError('Есть ${parked.length} отложенных чеков — оформите или удалите (лимит МС: до конца смены)');
    }
    final t = await xReport();
    final discrepancy = ((actualCash - t['expectedCash']!) * 100).roundToDouble() / 100;
    if (discrepancy.abs() >= 1 && (comment == null || comment.trim().isEmpty)) {
      throw StateError('Расхождение ${discrepancy > 0 ? "излишек" : "недостача"} ${discrepancy.abs()} ₸ — нужен комментарий');
    }
    final now = DateTime.now();
    await (db.update(db.shifts)..where((s) => s.id.equals(currentShift!.id))).write(ShiftsCompanion(
          status: const Value('closed'), closedAt: Value(now), closedBy: Value(currentStaff!.id),
          actualCash: Value(actualCash), discrepancy: Value(discrepancy),
          discrepancyComment: Value(comment)));
    await sync.enqueue(entity: 'shift', entityId: currentShift!.id, op: 'update',
        payload: {'closedAt': now.toUtc().toIso8601String(), 'actualCash': actualCash,
          if (comment != null) 'comment': comment},
        employeeId: currentStaff!.id);
    currentShift = null;
    notifyListeners();
    return {...t, 'actualCash': actualCash, 'discrepancy': discrepancy};
  }

  // ==================================================================
  // ПРОДАЖА: чек рождается локально и уезжает событием
  // ==================================================================
  Future<Map<String, dynamic>> completeSale(Payment pay) async {
    final err = cart.validateForPayment(pay);
    if (err != null) throw StateError(err);
    final id = const Uuid().v4();
    final now = DateTime.now();
    _localNumber += 1;
    final payload = cart.toSalePayload(shiftId: currentShift!.id, localNumber: _localNumber, payment: pay);

    await db.transaction(() async {
      await db.into(db.sales).insert(SalesCompanion.insert(
            id: id, shiftId: currentShift!.id, localNumber: _localNumber,
            status: const Value('completed'), employeeId: currentStaff!.id,
            consultantId: Value(cart.consultantId), customerId: Value(cart.customerId),
            subtotal: Value(cart.subtotal), discountSum: Value(cart.discountSum),
            rounding: Value(cart.rounding), total: Value(cart.total), costTotal: Value(cart.costTotal),
            paymentJson: Value(jsonEncode(pay.toJson())),
            createdAt: now, completedAt: Value(now)));
      for (final l in cart.lines) {
        await db.into(db.saleItems).insert(SaleItemsCompanion.insert(
              id: const Uuid().v4(), saleId: id, productId: l.productId, name: l.name,
              qty: l.qty, price: l.price, discountSum: Value(l.discountSum),
              total: l.total, cost: Value(l.cost), vatRate: Value(l.vatRate), ntin: Value(l.ntin)));
      }
    });
    await sync.enqueue(entity: 'sale', entityId: id, op: 'insert',
        payload: payload, employeeId: currentStaff!.id);

    // локальная книга: долг вырос на credit, бонусы: −spend +earn (превью той
    // же формулой, что сервер; сервер — истина, при онлайне баланс освежится)
    if (cart.customerId != null) {
      final earned = cart.bonusEarnPreview(pay.bonus);
      final cId = cart.customerId!;
      final cust = await (db.select(db.customers)..where((t) => t.id.equals(cId))).getSingleOrNull();
      if (cust != null) {
        await (db.update(db.customers)..where((t) => t.id.equals(cId))).write(CustomersCompanion(
              debt: Value(cust.debt + pay.credit),
              bonuses: Value(cust.bonuses - pay.bonus + earned)));
      }
    }
    final earned = cart.customerId != null ? cart.bonusEarnPreview(pay.bonus) : 0.0;
    final consultantName = consultants
        .firstWhere((x) => x['id'] == cart.consultantId, orElse: () => {})['name'] as String?;
    final result = {
      'id': id, 'number': _localNumber, 'total': cart.total, 'payment': pay,
      // контекст для печати: клиент видит бонусы и долг на чеке (Wipon Cashback
      // печатает начисление; долг — наша строка, чтобы «тетрадь» была прозрачна)
      'bonusEarned': earned,
      'bonusBalanceAfter': cart.customerId != null ? cart.customerBonuses - pay.bonus + earned : null,
      'debtAfter': cart.customerId != null && pay.credit > 0 ? cart.customerDebt + pay.credit : null,
      'customerName': cart.customerName,
      'consultantName': consultantName,
    };
    cart.clear();
    notifyListeners();
    return result;
  }

  /// Отмена позиции: журнал «100→98» (UMAG) пишется всегда;
  /// после пречека — только с подтверждением старшего.
  Future<void> cancelLine(CartLine line, {double? qty, String? approvedBy}) async {
    final cancelQty = qty ?? line.qty;
    final id = const Uuid().v4();
    await db.into(db.cancelledItems).insert(CancelledItemsCompanion.insert(
          id: id, shiftId: currentShift!.id, productId: line.productId,
          qtyAdded: line.qty, qtyCancelled: cancelQty, price: Value(line.price),
          employeeId: currentStaff!.id, approvedBy: Value(approvedBy), ts: DateTime.now()));
    await sync.enqueue(entity: 'cancelled_item', entityId: id, op: 'insert',
        payload: {'shiftId': currentShift!.id, 'productId': line.productId,
          'qtyAdded': line.qty, 'qtyCancelled': cancelQty, 'price': line.price,
          if (approvedBy != null) 'approvedBy': approvedBy},
        employeeId: currentStaff!.id);
    if (cancelQty >= line.qty) {
      cart.lines.remove(line);
    } else {
      line.qty -= cancelQty;
    }
    notifyListeners();
  }

  // ==================================================================
  // ОТЛОЖЕННЫЕ ЧЕКИ (модель МС: лимит 100, живут до конца смены)
  // ==================================================================
  static const parkedLimit = 100;

  Future<void> park() async {
    if (cart.lines.isEmpty) return;
    final parked = await (db.select(db.sales)
          ..where((t) => t.shiftId.equals(currentShift!.id) & t.status.equals('parked')))
        .get();
    if (parked.length >= parkedLimit) throw StateError('Лимит отложенных чеков: $parkedLimit');
    final id = const Uuid().v4();
    await db.transaction(() async {
      await db.into(db.sales).insert(SalesCompanion.insert(
            id: id, shiftId: currentShift!.id, localNumber: 0,
            status: const Value('parked'), employeeId: currentStaff!.id,
            customerId: Value(cart.customerId),
            subtotal: Value(cart.subtotal), total: Value(cart.total),
            createdAt: DateTime.now()));
      for (final l in cart.lines) {
        await db.into(db.saleItems).insert(SaleItemsCompanion.insert(
              id: const Uuid().v4(), saleId: id, productId: l.productId, name: l.name,
              qty: l.qty, price: l.price, total: l.total, cost: Value(l.cost)));
      }
    });
    cart.clear();
    notifyListeners();
  }

  /// Возврат к отложенному: сверяем цены с каталогом — если цена поменялась,
  /// строка помечается (деталь МС: «кассир не сможет оформить чек, если
  /// изменилась цена» — мы мягче: показываем и пересчитываем).
  Future<List<String>> unpark(String saleId) async {
    final items = await (db.select(db.saleItems)..where((t) => t.saleId.equals(saleId))).get();
    final changed = <String>[];
    cart.clear();
    for (final it in items) {
      final p = await (db.select(db.products)..where((t) => t.id.equals(it.productId))).getSingleOrNull();
      final actualPrice = p?.price ?? it.price;
      if (p != null && (p.price - it.price).abs() >= 0.01) changed.add('${it.name}: ${it.price} → ${p.price}');
      cart.add(productId: it.productId, name: it.name, price: actualPrice, qty: it.qty,
          cost: p?.cost ?? it.cost, minPrice: p?.minPrice, vatRate: p?.vatRate, ntin: p?.ntin);
    }
    await (db.delete(db.sales)..where((t) => t.id.equals(saleId))).go();
    await (db.delete(db.saleItems)..where((t) => t.saleId.equals(saleId))).go();
    notifyListeners();
    return changed;
  }

  // ==================================================================
  // ВОЗВРАТ: по чеку, «единожды» (правило UMAG), чужая смена — со старшим
  // ==================================================================
  Future<Map<String, dynamic>> refund(String saleId, {List<String>? itemIds, String? approvedBy}) async {
    final orig = await (db.select(db.sales)..where((t) => t.id.equals(saleId))).getSingleOrNull();
    if (orig == null) throw StateError('Чек не найден');
    final already = await (db.select(db.sales)..where((t) => t.refundOfId.equals(saleId))).get();
    if (already.isNotEmpty) throw StateError('Возврат по этому чеку уже оформлен (правило: единожды)');
    final foreignShift = orig.shiftId != currentShift!.id;
    if (foreignShift && approvedBy == null) {
      throw StateError('Возврат по чеку другой смены — нужно подтверждение старшего');
    }

    final items = await (db.select(db.saleItems)..where((t) => t.saleId.equals(saleId))).get();
    final chosen = itemIds == null ? items : items.where((i) => itemIds.contains(i.id)).toList();
    if (chosen.isEmpty) throw StateError('Не выбраны позиции возврата');

    final id = const Uuid().v4();
    final now = DateTime.now();
    _localNumber += 1;
    final total = chosen.fold(0.0, (s, i) => s + i.total);
    final cost = chosen.fold(0.0, (s, i) => s + i.cost * i.qty);
    final origPay = jsonDecode(orig.paymentJson) as Map<String, dynamic>;
    // возврат тем же способом, что платили (наличные — если было смешанно)
    final method = (origPay['cash'] ?? 0) as num > 0 ? 'cash'
        : (origPay['card'] ?? 0) as num > 0 ? 'card'
        : (origPay['qr'] ?? 0) as num > 0 ? 'qr' : 'credit';

    final payload = {
      'shiftId': currentShift!.id, 'localNumber': _localNumber,
      'refundOf': saleId,
      'subtotal': -total, 'discountSum': 0, 'rounding': 0,
      'total': -total, 'costTotal': -cost,
      if (approvedBy != null) 'approvedBy': approvedBy,
      'items': [
        for (final i in chosen)
          {'productId': i.productId, 'qty': -i.qty, 'price': i.price,
           'total': -i.total, 'cost': i.cost}
      ],
      'payment': {method: -total},
    };

    await db.transaction(() async {
      await db.into(db.sales).insert(SalesCompanion.insert(
            id: id, shiftId: currentShift!.id, localNumber: _localNumber,
            status: const Value('completed'), employeeId: currentStaff!.id,
            refundOfId: Value(saleId),
            subtotal: Value(total), total: Value(total), costTotal: Value(cost),
            paymentJson: Value(jsonEncode({method: total})),
            createdAt: now, completedAt: Value(now)));
    });
    await sync.enqueue(entity: 'sale', entityId: id, op: 'insert',
        payload: payload, employeeId: currentStaff!.id);
    notifyListeners();
    return {'id': id, 'total': total, 'method': method};
  }
}
