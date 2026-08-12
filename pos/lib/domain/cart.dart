import 'dart:math';

/// МАТЕМАТИКА ЧЕКА. Вся — здесь и только здесь: экран рисует, база хранит,
/// считает — этот файл. Формулы зеркалятся тестом part16 на сервере,
/// чтобы касса и кабинет никогда не разошлись в копейках.
///
/// Решения части 4:
/// - скидка строкой: процент ИЛИ сумма (модель Wipon);
/// - ниже min_price строка не опускается без подтверждения старшего (МС);
/// - округление: только итог, до 5 ₸ (настройка), ВСЕГДА вниз —
///   в пользу покупателя. Спор у кассы стоит дороже трёх тенге.

double _r2(double v) => (v * 100).roundToDouble() / 100;

class CartLine {
  CartLine({
    required this.productId,
    required this.name,
    required this.price,
    required this.qty,
    this.cost = 0,
    this.minPrice,
    this.vatRate,
    this.ntin,
    this.discountPercent = 0,
    this.discountAmount = 0,
    this.minPriceApprovedBy,
  });

  final String productId;
  final String name;
  double price;
  double qty;
  final double cost;
  final double? minPrice;
  final double? vatRate;
  final String? ntin;
  double discountPercent;                 // 0..100
  double discountAmount;                 // в тенге на строку
  String? minPriceApprovedBy;            // старший разрешил уйти ниже минимальной

  double get gross => _r2(price * qty);

  double get discountSum {
    final byPercent = _r2(gross * discountPercent / 100);
    return _r2(min(gross, byPercent + discountAmount));
  }

  double get total => _r2(gross - discountSum);

  double get costSum => _r2(cost * qty);

  /// Ушла ли строка ниже минимальной цены (за единицу, после скидки).
  bool get belowMinPrice =>
      minPrice != null && qty > 0 && _r2(total / qty) < minPrice! && minPriceApprovedBy == null;
}

/// Способы оплаты чека. change — сдача с наличных.
class Payment {
  Payment({this.cash = 0, this.card = 0, this.qr = 0, this.credit = 0, this.bonus = 0, this.change = 0});
  double cash, card, qr, credit, bonus, change;

  double get paidTotal => _r2(cash + card + qr + credit + bonus - change);

  Map<String, double> toJson() => {
        if (cash > 0) 'cash': _r2(cash),
        if (card > 0) 'card': _r2(card),
        if (qr > 0) 'qr': _r2(qr),
        if (credit > 0) 'credit': _r2(credit),
        if (bonus > 0) 'bonus': _r2(bonus),
        if (change > 0) 'change': _r2(change),
      };
}

/// Правила бонусной программы: задаются в кабинете, касса исполняет
/// (модель МоегоСклада: «настройка — в вебе, оплата баллами — в кассе»).
class LoyaltyRules {
  const LoyaltyRules({this.earnPercent = 0, this.spendPercent = 50, this.maxSpend = 5000, this.minPurchase = 0});
  final double earnPercent, spendPercent, maxSpend, minPurchase;
}

class Cart {
  Cart({this.roundTo = 5});

  final List<CartLine> lines = [];

  /// Скидка на весь чек (поверх строковых).
  double receiptDiscountPercent = 0;
  double receiptDiscountAmount = 0;

  /// Округление итога: 0 — выключено, 1 или 5 ₸ (профиль кассы, модель Wipon).
  int roundTo;

  String? customerId;                    // обязателен для оплаты в долг
  String? customerName;
  double customerDebt = 0;               // локальный снимок долга
  double? customerDebtLimit;             // NULL = без лимита
  double customerBonuses = 0;
  String? creditApprovedBy;              // старший разрешил долг сверх лимита
  LoyaltyRules loyalty = const LoyaltyRules();
  String? consultantId;                  // продавец в чеке (UMAG)

  double get subtotal => _r2(lines.fold(0.0, (s, l) => s + l.gross));

  double get lineDiscounts => _r2(lines.fold(0.0, (s, l) => s + l.discountSum));

  double get receiptDiscount {
    final base = _r2(subtotal - lineDiscounts);
    final byPercent = _r2(base * receiptDiscountPercent / 100);
    return _r2(min(base, byPercent + receiptDiscountAmount));
  }

  double get discountSum => _r2(lineDiscounts + receiptDiscount);

  double get totalBeforeRounding => _r2(subtotal - discountSum);

  /// Округление ТОЛЬКО вниз: 1002 ₸ при шаге 5 → 1000 ₸, rounding = −2.
  double get rounding {
    if (roundTo <= 0) return 0;
    final t = totalBeforeRounding;
    final floored = (t / roundTo).floorToDouble() * roundTo;
    return _r2(floored - t);
  }

  double get total => _r2(totalBeforeRounding + rounding);

  double get costTotal => _r2(lines.fold(0.0, (s, l) => s + l.costSum));

  bool get hasBelowMinPrice => lines.any((l) => l.belowMinPrice);

  /// Добавить товар: та же позиция с той же ценой — плюс количество,
  /// а не новая строка (как ждёт кассир).
  CartLine add({
    required String productId,
    required String name,
    required double price,
    double qty = 1,
    double cost = 0,
    double? minPrice,
    double? vatRate,
    String? ntin,
  }) {
    for (final l in lines) {
      if (l.productId == productId && l.price == price && l.discountPercent == 0 && l.discountAmount == 0) {
        l.qty = _r2(l.qty + qty);
        return l;
      }
    }
    final line = CartLine(
      productId: productId, name: name, price: price, qty: qty,
      cost: cost, minPrice: minPrice, vatRate: vatRate, ntin: ntin);
    lines.add(line);
    return line;
  }

  void clear() {
    lines.clear();
    receiptDiscountPercent = 0;
    receiptDiscountAmount = 0;
    customerId = null;
    customerName = null;
    customerDebt = 0;
    customerDebtLimit = null;
    customerBonuses = 0;
    creditApprovedBy = null;
    consultantId = null;
  }

  /// Сколько ещё можно дать в долг (NULL-лимит = сколько угодно).
  double? get creditAvailable =>
      customerDebtLimit == null ? null : _r2(max(0, customerDebtLimit! - customerDebt));

  /// Потолок оплаты бонусами: баланс, % от чека и абсолютный максимум программы.
  double get maxBonusSpend {
    final byPercent = _r2(total * loyalty.spendPercent / 100);
    return _r2([customerBonuses, byPercent, loyalty.maxSpend].reduce(min));
  }

  /// Сколько бонусов начислится (для строки на чеке до оплаты).
  double bonusEarnPreview(double bonusSpent) {
    final base = _r2(total - bonusSpent);
    if (base < loyalty.minPurchase || loyalty.earnPercent <= 0) return 0;
    return (base * loyalty.earnPercent / 100).floorToDouble();
  }

  /// Проверки перед оплатой. Возвращает текст ошибки или null.
  String? validateForPayment(Payment p) {
    if (lines.isEmpty) return 'Чек пуст';
    if (hasBelowMinPrice) return 'Есть цена ниже минимальной — нужно подтверждение старшего';
    if (p.credit > 0 && customerId == null) {
      return 'Продажа в долг — только с выбранным покупателем';   // правило Wipon
    }
    // лимит долга проверяется ОФЛАЙН по локальному снимку; сверх — старший
    if (p.credit > 0 && creditAvailable != null && p.credit > creditAvailable! && creditApprovedBy == null) {
      return 'Лимит долга: доступно ${creditAvailable!.toStringAsFixed(0)} ₸ из ${customerDebtLimit!.toStringAsFixed(0)} ₸ — нужен старший';
    }
    if (p.bonus > 0 && customerId == null) return 'Оплата бонусами — только с выбранным покупателем';
    if (p.bonus > maxBonusSpend + 0.001) {
      return 'Бонусами можно не больше ${maxBonusSpend.toStringAsFixed(0)} ₸ (баланс ${customerBonuses.toStringAsFixed(0)}, до ${loyalty.spendPercent.toStringAsFixed(0)}% чека)';
    }
    final diff = _r2(p.paidTotal - total);
    if (diff.abs() >= 0.01) return 'Оплачено ${p.paidTotal.toStringAsFixed(2)} ₸, а надо ${total.toStringAsFixed(2)} ₸';
    return null;
  }

  /// Полезность Wipon: в смешанной оплате вводишь одну сумму —
  /// вторая подставляется сама.
  double remainderAfter(double entered) => _r2(max(0, total - entered));

  /// Сдача с наличных: наличными дали cashGiven, безнал уже введён.
  double changeFor(double cashGiven, {double nonCash = 0}) =>
      _r2(max(0, cashGiven + nonCash - total));

  /// Полезная нагрузка события 'sale' — байт в байт то, что ждёт
  /// applyOfflineSale на сервере.
  Map<String, dynamic> toSalePayload({
    required String shiftId,
    required int localNumber,
    required Payment payment,
  }) =>
      {
        'shiftId': shiftId,
        'localNumber': localNumber,
        'subtotal': subtotal,
        'discountSum': discountSum,
        'rounding': rounding,
        'total': total,
        'costTotal': costTotal,
        if (customerId != null) 'customerId': customerId,
        if (creditApprovedBy != null) 'approvedBy': creditApprovedBy,
        if (consultantId != null) 'consultantId': consultantId,
        'items': [
          for (final l in lines)
            {
              'productId': l.productId,
              'qty': l.qty,
              'price': l.price,
              'discountSum': l.discountSum,
              'total': l.total,
              'cost': l.cost,
              if (l.vatRate != null) 'vatRate': l.vatRate,
              if (l.ntin != null) 'ntin': l.ntin,
            }
        ],
        'payment': payment.toJson(),
      };
}

/// Номиналы банкнот Казахстана — кнопки на экране оплаты (находка Wipon:
/// кассир не считает в уме, покупатель дал 5000 — нажал «5000»).
const kztDenominations = [500, 1000, 2000, 5000, 10000, 20000];
