import 'package:drift/drift.dart' hide Column;
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../core/session.dart';
import '../../data/local_db.dart';

/// ВЫБОР ПОКУПАТЕЛЯ. Модель карточки UMAG: у клиента виден и долг (баланс),
/// и бонусы. Поиск по имени, телефону и карте лояльности — строка поиска
/// принимает и сканер (карта/QR печатает код + Enter). Работает офлайн
/// по локальному снимку; погашение долга — прямо отсюда (долговая книга Wipon).
class CustomerSheet extends StatefulWidget {
  const CustomerSheet({super.key});
  @override
  State<CustomerSheet> createState() => _CustomerSheetState();
}

class _CustomerSheetState extends State<CustomerSheet> {
  final _search = TextEditingController();
  List<Customer> _found = [];

  @override
  void initState() {
    super.initState();
    _query('');
  }

  Future<void> _query(String q) async {
    final db = context.read<LocalDb>();
    if (q.trim().isNotEmpty) {
      // карта лояльности — точное совпадение (скан)
      final byCard = await (db.select(db.customers)
            ..where((t) => t.loyaltyCard.equals(q.trim())))
          .getSingleOrNull();
      if (byCard != null) {
        if (mounted) {
          await context.read<PosSession>().attachCustomer(byCard);
          if (mounted) Navigator.pop(context);
        }
        return;
      }
    }
    _found = await (db.select(db.customers)
          ..where((t) => q.trim().isEmpty
              ? const Constant(true)
              : (t.name.contains(q.trim()) | t.phone.contains(q.trim())))
          ..orderBy([(t) => OrderingTerm.asc(t.name)])
          ..limit(30))
        .get();
    if (mounted) setState(() {});
  }

  Future<void> _payDebt(Customer c) async {
    final session = context.read<PosSession>();
    final amount = TextEditingController(text: c.debt.toStringAsFixed(0));
    final ok = await showDialog<bool>(context: context, builder: (_) => AlertDialog(
      title: Text('Погашение долга: ${c.name}'),
      content: Column(mainAxisSize: MainAxisSize.min, children: [
        Text('Долг: ${c.debt.toStringAsFixed(0)} ₸'),
        TextField(controller: amount, keyboardType: TextInputType.number,
            decoration: const InputDecoration(labelText: 'Принято наличными, ₸')),
      ]),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Отмена')),
        FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Принять')),
      ],
    ));
    if (ok != true) return;
    try {
      final paid = await session.payCustomerDebt(c, double.tryParse(amount.text) ?? 0);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Принято ${paid.toStringAsFixed(0)} ₸ — долг обновлён')));
        _query(_search.text);
      }
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.toString())));
    }
  }

  @override
  Widget build(BuildContext context) {
    final session = context.read<PosSession>();
    final cs = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        TextField(
          controller: _search, autofocus: true,
          decoration: const InputDecoration(
            prefixIcon: Icon(Icons.badge),
            hintText: 'Имя, телефон или скан карты',
            border: OutlineInputBorder()),
          onChanged: _query,
        ),
        const SizedBox(height: 10),
        OutlinedButton.icon(
          icon: const Icon(Icons.person_add),
          label: const Text('Новый покупатель'),
          onPressed: () async {
            final name = TextEditingController(text: _search.text);
            final phone = TextEditingController();
            final ok = await showDialog<bool>(context: context, builder: (_) => AlertDialog(
              title: const Text('Новый покупатель'),
              content: Column(mainAxisSize: MainAxisSize.min, children: [
                TextField(controller: name, decoration: const InputDecoration(labelText: 'Имя')),
                TextField(controller: phone, decoration: const InputDecoration(labelText: 'Телефон (не обязателен)')),
              ]),
              actions: [
                TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Отмена')),
                FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Создать')),
              ]));
            if (ok == true && name.text.trim().isNotEmpty && context.mounted) {
              final c = await session.createCustomer(name.text, phone: phone.text.isEmpty ? null : phone.text);
              await session.attachCustomer(c);
              if (context.mounted) Navigator.pop(context);
            }
          },
        ),
        const SizedBox(height: 6),
        Flexible(
          child: _found.isEmpty
              ? const Padding(padding: EdgeInsets.all(20), child: Text('Покупателей не найдено'))
              : ListView(shrinkWrap: true, children: [
                  for (final c in _found)
                    ListTile(
                      title: Text(c.name),
                      subtitle: Wrap(spacing: 10, children: [
                        if (c.phone != null) Text(c.phone!),
                        if (c.debt > 0)
                          Text('долг ${c.debt.toStringAsFixed(0)} ₸'
                              '${c.debtLimit != null ? " / лимит ${c.debtLimit!.toStringAsFixed(0)}" : ""}',
                              style: TextStyle(color: cs.error)),
                        if (c.bonuses > 0)
                          Text('бонусы ${c.bonuses.toStringAsFixed(0)} ₸',
                              style: TextStyle(color: cs.primary)),
                      ]),
                      trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                        if (c.debt > 0)
                          TextButton(onPressed: () => _payDebt(c), child: const Text('Погасить')),
                        FilledButton.tonal(
                          onPressed: () async {
                            await session.attachCustomer(c);
                            if (context.mounted) Navigator.pop(context);
                          },
                          child: const Text('Выбрать')),
                      ]),
                    ),
                ]),
        ),
      ]),
    );
  }
}
