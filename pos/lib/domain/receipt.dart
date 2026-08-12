import 'dart:convert';
import 'cart.dart';

/// ПЕЧАТЬ ЧЕКА (ESC/POS).
///
/// Настройки — модель UMAG «Настройка чека»: заголовок, нижний колонтитул,
/// кодировка кириллицы на принтере, ширина бумаги, табличный вид, печать НДС.
/// Всё приезжает в pos_profile при bootstrap и работает офлайн.
class ReceiptSettings {
  ReceiptSettings({
    this.header = '',
    this.footer = 'Спасибо за покупку!',
    this.paperWidth = 32,             // знаков в строке: 32 (58мм) или 48 (80мм)
    this.codePage = 17,               // CP866 на большинстве принтеров
    this.tabular = false,
    this.printVat = false,
    this.storeName = '',
    this.address = '',
  });

  factory ReceiptSettings.fromProfile(Map<String, dynamic> p) => ReceiptSettings(
        header: p['receiptHeader'] as String? ?? '',
        footer: p['receiptFooter'] as String? ?? 'Спасибо за покупку!',
        paperWidth: p['paperWidth'] as int? ?? 32,
        codePage: p['codePage'] as int? ?? 17,
        tabular: p['receiptTabular'] as bool? ?? false,
        printVat: p['printVat'] as bool? ?? false,
        storeName: p['storeName'] as String? ?? '',
        address: p['storeAddress'] as String? ?? '',
      );

  final String header, footer, storeName, address;
  final int paperWidth, codePage;
  final bool tabular, printVat;
}

class ReceiptBuilder {
  ReceiptBuilder(this.s);
  final ReceiptSettings s;

  static const esc = 0x1B, gs = 0x1D;

  final List<int> _out = [];

  void _cmd(List<int> b) => _out.addAll(b);
  void _text(String t) {
    // Кириллица под кодовую страницу принтера. CP866 — самая частая;
    // если принтер печатает иероглифы, меняется codePage (симптом из
    // диагностики части 11: 'hieroglyphs').
    _out.addAll(_encode(t));
    _out.add(0x0A);
  }

  List<int> _encode(String t) {
    if (s.codePage == 17 || s.codePage == 866) return _cp866(t);
    return latin1.encode(t.replaceAll(RegExp(r'[^\x00-\xFF]'), '?'));
  }

  static List<int> _cp866(String t) {
    final out = <int>[];
    for (final r in t.runes) {
      if (r < 0x80) { out.add(r); continue; }
      if (r >= 0x410 && r <= 0x43F) { out.add(r - 0x410 + 0x80); continue; }  // А-п
      if (r >= 0x440 && r <= 0x44F) { out.add(r - 0x440 + 0xE0); continue; }  // р-я
      if (r == 0x401) { out.add(0xF0); continue; }                            // Ё
      if (r == 0x451) { out.add(0xF1); continue; }                            // ё
      if (r == 0x20B8) { out.addAll('тг'.codeUnits.map((c) => c)); continue; } // ₸ нет в CP866
      out.add(0x3F);
    }
    return out;
  }

  String _line([String ch = '-']) => ch * s.paperWidth;

  String _lr(String left, String right) {
    final space = s.paperWidth - left.length - right.length;
    if (space < 1) return '$left $right';
    return left + ' ' * space + right;
  }

  String _money(double v) => v.toStringAsFixed(v == v.roundToDouble() ? 0 : 2);

  /// Товарный (нефискальный) чек. Фискальный печатает провайдер ККМ (часть 5).
  /// Логотип магазина (модель Wipon «Брендирование чека»). Растр собран
  /// сервером в bootstrap — здесь только команда GS v 0 и готовые байты.
  Map<String, dynamic>? branding;

  void _logo() {
    final b = branding;
    final raster = b?['logoRaster'] as String?;
    if (raster == null) return;
    final w = (b!['logoWidth'] as num).toInt();
    final h = (b['logoHeight'] as num).toInt();
    final bytes = base64Decode(raster);
    final bytesPerRow = w ~/ 8;
    _cmd([esc, 0x61, 1]);                       // по центру
    // GS v 0: xL xH — байт в строке, yL yH — число строк
    _cmd([gs, 0x76, 0x30, 0,
          bytesPerRow & 0xff, (bytesPerRow >> 8) & 0xff,
          h & 0xff, (h >> 8) & 0xff]);
    _cmd(bytes);
    _cmd([0x0a]);
  }

  void _adText() {
    final t = branding?['adText'] as String?;
    if (t == null || t.isEmpty) return;
    _cmd([esc, 0x61, 1]);
    for (final line in _wrap(t, s.paperWidth)) _text(line);
    _cmd([esc, 0x61, 0]);
  }

  List<String> _wrap(String s, int w) {
    final words = s.split(' ');
    final out = <String>[]; var cur = '';
    for (final word in words) {
      if ((cur + (cur.isEmpty ? '' : ' ') + word).length > w) { if (cur.isNotEmpty) out.add(cur); cur = word; }
      else { cur = cur.isEmpty ? word : '$cur $word'; }
    }
    if (cur.isNotEmpty) out.add(cur);
    return out;
  }

  List<int> saleReceipt({
    required Cart cart,
    required Payment pay,
    required int number,
    required String cashierName,
    required DateTime at,
    bool preReceipt = false,
    double bonusEarned = 0,
    double? bonusBalanceAfter,
    double? debtAfter,
    String? consultantName,
  }) {
    _out.clear();
    _cmd([esc, 0x40]);                          // init
    _logo();                                    // логотип магазина (часть 21)
    _cmd([esc, 0x74, s.codePage]);              // кодовая страница

    _cmd([esc, 0x61, 1]);                       // center
    if (s.storeName.isNotEmpty) _text(s.storeName);
    if (s.address.isNotEmpty) _text(s.address);
    if (s.header.isNotEmpty) _text(s.header);
    if (preReceipt) {
      _cmd([esc, 0x45, 1]);
      _text('ПРЕДВАРИТЕЛЬНЫЙ ЧЕК');
      _cmd([esc, 0x45, 0]);
      _text('НЕ ЯВЛЯЕТСЯ ФИСКАЛЬНЫМ');
    }
    _cmd([esc, 0x61, 0]);                       // left
    _text(_line());
    _text(_lr('Чек №$number', _dt(at)));
    _text('Кассир: $cashierName');
    _text(_line());

    for (final l in cart.lines) {
      if (s.tabular) {
        _text(l.name);
        _text(_lr('  ${_money(l.qty)} x ${_money(l.price)}', _money(l.total)));
      } else {
        _text(_lr(_fit(l.name), _money(l.total)));
        if (l.qty != 1) _text('  ${_money(l.qty)} x ${_money(l.price)}');
      }
      if (l.discountSum > 0) _text(_lr('  скидка', '-${_money(l.discountSum)}'));
    }

    _text(_line());
    if (cart.discountSum > 0) _text(_lr('Скидка', '-${_money(cart.discountSum)}'));
    if (cart.rounding != 0) _text(_lr('Округление', _money(cart.rounding)));
    _cmd([esc, 0x45, 1]);
    _text(_lr('ИТОГО', '${_money(cart.total)} тг'));
    _cmd([esc, 0x45, 0]);

    if (s.printVat) {
      final vat = cart.lines.fold(0.0, (sum, l) =>
          sum + (l.vatRate == null ? 0 : l.total * l.vatRate! / (100 + l.vatRate!)));
      _text(_lr('в т.ч. НДС', _money((vat * 100).roundToDouble() / 100)));
    }

    if (!preReceipt) {
      if (pay.cash > 0) _text(_lr('Наличными', _money(pay.cash)));
      if (pay.card > 0) _text(_lr('Картой', _money(pay.card)));
      if (pay.qr > 0) _text(_lr('QR', _money(pay.qr)));
      if (pay.bonus > 0) _text(_lr('Бонусами', _money(pay.bonus)));
      if (pay.credit > 0) _text(_lr('В долг', _money(pay.credit)));
      if (pay.change > 0) _text(_lr('Сдача', _money(pay.change)));

      // Бонусы и долг на чеке: Wipon Cashback печатает начисление; строка
      // долга — наша: «тетрадь» должна быть прозрачна и для покупателя.
      if (bonusEarned > 0 || bonusBalanceAfter != null || debtAfter != null) _text(_line());
      if (bonusEarned > 0) _text(_lr('Начислено бонусов', '+${_money(bonusEarned)}'));
      if (bonusBalanceAfter != null) _text(_lr('Бонусный баланс', _money(bonusBalanceAfter)));
      if (debtAfter != null) {
        _cmd([esc, 0x45, 1]);
        _text(_lr('ВАШ ДОЛГ', '${_money(debtAfter)} тг'));
        _cmd([esc, 0x45, 0]);
      }
      if (consultantName != null) _text('Вас обслуживал(а): $consultantName');
    }

    _cmd([esc, 0x61, 1]);
    _text(_line());
    if (s.footer.isNotEmpty) _text(s.footer);
    _cmd([esc, 0x64, 4]);                       // feed
    _adText();                                  // рекламный текст (модель Wipon)

    _cmd([gs, 0x56, 0]);                        // cut
    return List.of(_out);
  }

  String _fit(String name) =>
      name.length > s.paperWidth - 9 ? '${name.substring(0, s.paperWidth - 10)}…' : name;

  String _dt(DateTime d) =>
      '${d.day.toString().padLeft(2, '0')}.${d.month.toString().padLeft(2, '0')} '
      '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
}
