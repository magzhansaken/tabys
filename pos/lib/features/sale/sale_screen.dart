import 'package:drift/drift.dart' hide Column;
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../core/session.dart';
import '../../data/local_db.dart';
import '../../domain/cart.dart';
import '../shift/shift_screen.dart';
import 'payment_sheet.dart';
import 'customer_sheet.dart';
import 'refund_screen.dart';

/// ГЛАВНЫЙ ЭКРАН ПРОДАЖИ.
/// Слева каталог: строка поиска (она же приёмник сканера — сканер печатает
/// код и Enter) и плитка быстрых товаров (UMAG/Wipon). Справа чек.
/// Всё локально: поиск и добавление не ждут сеть никогда.
class SaleScreen extends StatefulWidget {
  const SaleScreen({super.key});
  @override
  State<SaleScreen> createState() => _SaleScreenState();
}

class _SaleScreenState extends State<SaleScreen> {
  final _search = TextEditingController();
  final _searchFocus = FocusNode();
  List<Product> _found = [];
  List<Product> _quick = [];
  int _pending = 0;

  @override
  void initState() {
    super.initState();
    _loadQuick();
    final sync = context.read<PosSession>().sync;
    sync.pendingStream.listen((n) { if (mounted) setState(() => _pending = n); });
  }

  Future<void> _loadQuick() async {
    final db = context.read<LocalDb>();
    _quick = await (db.select(db.products)
          ..where((t) => t.isQuick.equals(true) & t.archived.equals(false))
          ..limit(24))
        .get();
    if (mounted) setState(() {});
  }

  /// Поиск: имя, короткий код или штрихкод. Весовой штрихкод (префикс 22–29,
  /// код товара + вес внутри) разбирается здесь же — кассир не вбивает вес.
  Future<void> _query(String q) async {
    final db = context.read<LocalDb>();
    if (q.trim().isEmpty) { setState(() => _found = []); return; }
    final byBarcode = await (db.select(db.barcodes)..where((t) => t.code.equals(q.trim()))).getSingleOrNull();
    if (byBarcode != null) {
      final p = await (db.select(db.products)..where((t) => t.id.equals(byBarcode.productId))).getSingle();
      _add(p);
      _search.clear();
      setState(() => _found = []);
      return;
    }
    // весовой: 22PPPPPWWWWWK — товар по code, вес в граммах
    if (RegExp(r'^2[2-9]\d{11}$').hasMatch(q.trim())) {
      final code = int.parse(q.trim().substring(2, 7));
      final grams = int.parse(q.trim().substring(7, 12));
      final p = await (db.select(db.products)..where((t) => t.code.equals(code))).getSingleOrNull();
      if (p != null) {
        _add(p, qty: grams / 1000);
        _search.clear();
        setState(() => _found = []);
        return;
      }
    }
    _found = await (db.select(db.products)
          ..where((t) => (t.name.contains(q.trim()) | t.nameKk.contains(q.trim())) & t.archived.equals(false))
          ..limit(12))
        .get();
    setState(() {});
  }

  void _add(Product p, {double qty = 1}) {
    final session = context.read<PosSession>();
    if (session.currentShift == null) {
      _needShift();
      return;
    }
    session.cart.add(
      productId: p.id, name: p.name, price: p.price, qty: qty,
      cost: p.cost, minPrice: p.minPrice, vatRate: p.vatRate, ntin: p.ntin);
    setState(() {});
    _searchFocus.requestFocus();
  }

  void _needShift() {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: const Text('Смена не открыта'),
        action: SnackBarAction(label: 'Открыть', onPressed: _openShiftScreen)));
  }

  void _openShiftScreen() =>
      Navigator.push(context, MaterialPageRoute(builder: (_) => const ShiftScreen()))
          .then((_) => setState(() {}));

  Future<void> _pay() async {
    final session = context.read<PosSession>();
    if (session.currentShift == null) { _needShift(); return; }
    if (session.cart.lines.isEmpty) return;
    final done = await showModalBottomSheet<bool>(
      context: context, isScrollControlled: true,
      builder: (_) => const PaymentSheet());
    if (done == true) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final session = context.watch<PosSession>();
    final cart = session.cart;
    final cs = Theme.of(context).colorScheme;

    return Scaffold(
      appBar: AppBar(
        title: Row(children: [
          Text('${session.currentStaff?.firstName ?? ''} · '
              '${session.currentShift == null ? "смена закрыта" : "смена №${session.currentShift!.number}"}'),
        ]),
        actions: [
          if (_pending > 0)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8),
              child: Chip(label: Text('не отдано: $_pending'), backgroundColor: cs.tertiaryContainer),
            ),
          IconButton(tooltip: 'Возврат', icon: const Icon(Icons.keyboard_return),
              onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const RefundScreen()))),
          IconButton(tooltip: 'Смена', icon: const Icon(Icons.schedule), onPressed: _openShiftScreen),
          IconButton(tooltip: 'Сменить кассира', icon: const Icon(Icons.switch_account),
              onPressed: () { session.currentStaff = null; session.notifyListeners(); }),
        ],
      ),
      body: Row(children: [
        // ---------- каталог ----------
        Expanded(
          flex: 5,
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              TextField(
                controller: _search,
                focusNode: _searchFocus,
                autofocus: true,
                decoration: const InputDecoration(
                  prefixIcon: Icon(Icons.qr_code_scanner),
                  hintText: 'Сканируйте штрихкод или ищите по названию',
                  border: OutlineInputBorder(),
                ),
                onChanged: _query,
                onSubmitted: (v) { _query(v); },
              ),
              const SizedBox(height: 10),
              Expanded(
                child: _found.isNotEmpty
                    ? ListView(children: [
                        for (final p in _found)
                          ListTile(
                            title: Text(p.name),
                            trailing: Text('${p.price.toStringAsFixed(0)} ₸', style: const TextStyle(fontSize: 16)),
                            onTap: () { _add(p); _search.clear(); setState(() => _found = []); },
                          ),
                      ])
                    : GridView.count(
                        crossAxisCount: 4, mainAxisSpacing: 8, crossAxisSpacing: 8, childAspectRatio: 1.5,
                        children: [
                          for (final p in _quick)
                            FilledButton.tonal(
                              onPressed: () => _add(p),
                              child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
                                Text(p.name, maxLines: 2, overflow: TextOverflow.ellipsis, textAlign: TextAlign.center),
                                Text('${p.price.toStringAsFixed(0)} ₸',
                                    style: TextStyle(color: cs.primary, fontWeight: FontWeight.w600)),
                              ]),
                            ),
                        ],
                      ),
              ),
            ]),
          ),
        ),
        const VerticalDivider(width: 1),
        // ---------- чек ----------
        Expanded(
          flex: 4,
          child: Column(children: [
            Expanded(
              child: cart.lines.isEmpty
                  ? const Center(child: Text('Чек пуст — сканируйте товар'))
                  : ListView(children: [
                      for (final l in cart.lines)
                        Dismissible(
                          key: ValueKey(identityHashCode(l)),
                          direction: DismissDirection.endToStart,
                          background: Container(color: cs.errorContainer, alignment: Alignment.centerRight,
                              padding: const EdgeInsets.only(right: 16), child: const Icon(Icons.delete)),
                          confirmDismiss: (_) async {
                            // журнал отмен UMAG «100→98» пишется всегда
                            await session.cancelLine(l);
                            return false; // строку убрал session, Dismissible не нужен
                          },
                          child: ListTile(
                            dense: true,
                            title: Text(l.name),
                            subtitle: Text('${l.qty} × ${l.price.toStringAsFixed(0)}'
                                '${l.discountSum > 0 ? "  скидка ${l.discountSum.toStringAsFixed(0)}" : ""}'),
                            trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                              IconButton(icon: const Icon(Icons.remove), onPressed: () {
                                if (l.qty <= 1) { session.cancelLine(l); } else { l.qty -= 1; session.notifyListeners(); }
                              }),
                              Text('${l.total.toStringAsFixed(0)} ₸', style: const TextStyle(fontSize: 16)),
                              IconButton(icon: const Icon(Icons.add), onPressed: () { l.qty += 1; session.notifyListeners(); }),
                            ]),
                          ),
                        ),
                    ]),
            ),
            Container(
              padding: const EdgeInsets.all(14),
              color: cs.surfaceContainerHighest,
              child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                // покупатель в чеке: долг/лимит и бонусы видны кассиру сразу
                InkWell(
                  onTap: () => showModalBottomSheet(context: context, isScrollControlled: true,
                      builder: (_) => const CustomerSheet()).then((_) => setState(() {})),
                  child: Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: Row(children: [
                      Icon(Icons.person, size: 18, color: cs.primary),
                      const SizedBox(width: 6),
                      Expanded(child: Text(
                        cart.customerId == null
                            ? 'Покупатель не выбран'
                            : '${cart.customerName}'
                              '${cart.customerDebt > 0 ? " · долг ${cart.customerDebt.toStringAsFixed(0)}₸" : ""}'
                              '${cart.customerBonuses > 0 ? " · бонусы ${cart.customerBonuses.toStringAsFixed(0)}₸" : ""}',
                        overflow: TextOverflow.ellipsis)),
                      if (cart.customerId != null)
                        IconButton(icon: const Icon(Icons.close, size: 16),
                          onPressed: () { session.detachCustomer(); }),
                      // продавец в чеке (UMAG: «для учёта продаж консультантов»)
                      if (session.consultants.isNotEmpty)
                        TextButton.icon(
                          icon: const Icon(Icons.support_agent, size: 16),
                          label: Text(cart.consultantId == null
                              ? 'Продавец'
                              : (session.consultants.firstWhere(
                                    (x) => x['id'] == cart.consultantId,
                                    orElse: () => {'name': '—'})['name'] as String)),
                          onPressed: () async {
                            final picked = await showModalBottomSheet<String?>(
                              context: context,
                              builder: (_) => ListView(shrinkWrap: true, children: [
                                const ListTile(title: Text('Продавец в чеке',
                                    style: TextStyle(fontWeight: FontWeight.bold))),
                                ListTile(title: const Text('Без продавца'),
                                    onTap: () => Navigator.pop(context, '')),
                                for (final c in session.consultants)
                                  ListTile(title: Text(c['name'] as String),
                                      onTap: () => Navigator.pop(context, c['id'] as String)),
                              ]));
                            if (picked != null) {
                              cart.consultantId = picked.isEmpty ? null : picked;
                              session.notifyListeners();
                            }
                          },
                        ),
                    ]),
                  ),
                ),
                if (cart.discountSum > 0)
                  Text('Скидка: −${cart.discountSum.toStringAsFixed(0)} ₸'),
                if (cart.rounding != 0)
                  Text('Округление: ${cart.rounding.toStringAsFixed(0)} ₸ (в пользу покупателя)'),
                Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
                  const Text('ИТОГО', style: TextStyle(fontSize: 18)),
                  Text('${cart.total.toStringAsFixed(0)} ₸',
                      style: const TextStyle(fontSize: 26, fontWeight: FontWeight.bold)),
                ]),
                const SizedBox(height: 10),
                Row(children: [
                  Expanded(child: OutlinedButton(
                    onPressed: cart.lines.isEmpty ? null : () async {
                      try { await session.park(); } catch (e) {
                        if (context.mounted) {
                          ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.toString())));
                        }
                      }
                    },
                    child: const Text('Отложить'),
                  )),
                  const SizedBox(width: 8),
                  Expanded(child: OutlinedButton(
                    onPressed: () => _showParked(session),
                    child: const Text('Отложенные'),
                  )),
                ]),
                const SizedBox(height: 8),
                FilledButton(
                  onPressed: cart.lines.isEmpty ? null : _pay,
                  style: FilledButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 18)),
                  child: const Text('ОПЛАТА', style: TextStyle(fontSize: 18)),
                ),
              ]),
            ),
          ]),
        ),
      ]),
    );
  }

  Future<void> _showParked(PosSession session) async {
    final db = context.read<LocalDb>();
    final parked = await (db.select(db.sales)
          ..where((t) => t.status.equals('parked'))
          ..orderBy([(t) => OrderingTerm.desc(t.createdAt)]))
        .get();
    if (!mounted) return;
    await showModalBottomSheet(context: context, builder: (_) => ListView(children: [
      const ListTile(title: Text('Отложенные чеки', style: TextStyle(fontWeight: FontWeight.bold))),
      if (parked.isEmpty) const ListTile(title: Text('Пусто')),
      for (final s in parked)
        ListTile(
          title: Text('${s.total.toStringAsFixed(0)} ₸'),
          subtitle: Text('${s.createdAt.hour}:${s.createdAt.minute.toString().padLeft(2, '0')}'),
          onTap: () async {
            final changed = await session.unpark(s.id);
            if (context.mounted) {
              Navigator.pop(context);
              if (changed.isNotEmpty) {
                // деталь МС: цена могла измениться, пока чек лежал
                ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(content: Text('Цены обновились: ${changed.join('; ')}')));
              }
              setState(() {});
            }
          },
        ),
    ]));
  }
}
