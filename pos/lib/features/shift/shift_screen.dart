import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../core/session.dart';

/// СМЕНА. Модель части 4: X-отчёт — промежуточный, Z — закрытие;
/// расхождение факта и расчёта требует комментария. Всё считается локально
/// и работает без сети; смена ККМ закрывается тем же действием (часть 5),
/// как «одной кнопкой» у Wipon.
class ShiftScreen extends StatefulWidget {
  const ShiftScreen({super.key});
  @override
  State<ShiftScreen> createState() => _ShiftScreenState();
}

class _ShiftScreenState extends State<ShiftScreen> {
  Map<String, double>? _x;
  String _err = '';

  Future<void> _refreshX() async {
    final s = context.read<PosSession>();
    if (s.currentShift != null) {
      _x = await s.xReport();
      if (mounted) setState(() {});
    }
  }

  @override
  void initState() {
    super.initState();
    _refreshX();
  }

  @override
  Widget build(BuildContext context) {
    final session = context.watch<PosSession>();
    final shift = session.currentShift;
    final cs = Theme.of(context).colorScheme;

    return Scaffold(
      appBar: AppBar(title: Text(shift == null ? 'Открытие смены' : 'Смена №${shift.number}')),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 460),
          child: Padding(
            padding: const EdgeInsets.all(20),
            child: shift == null ? _openForm(session) : _shiftView(session, cs),
          ),
        ),
      ),
    );
  }

  // ---------- открытие ----------
  final _float = TextEditingController(text: '0');

  Widget _openForm(PosSession session) {
    return Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      TextField(
        controller: _float,
        keyboardType: TextInputType.number,
        decoration: const InputDecoration(
          labelText: 'Размен на начало смены, ₸', border: OutlineInputBorder()),
      ),
      const SizedBox(height: 8),
      if (_err.isNotEmpty) Text(_err, style: TextStyle(color: Theme.of(context).colorScheme.error)),
      const SizedBox(height: 8),
      FilledButton(
        onPressed: () async {
          try {
            await session.openShift(double.tryParse(_float.text) ?? 0);
            _err = '';
            await _refreshX();
          } catch (e) { setState(() => _err = e.toString()); }
        },
        style: FilledButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 16)),
        child: const Text('Открыть смену'),
      ),
    ]);
  }

  // ---------- открытая смена: X-отчёт и операции ----------
  Widget _shiftView(PosSession session, ColorScheme cs) {
    final x = _x;
    return ListView(children: [
      if (x != null) Card(child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          const Text('X-отчёт (без закрытия)', style: TextStyle(fontWeight: FontWeight.bold)),
          const SizedBox(height: 8),
          _row('Чеков', x['receipts']!.toStringAsFixed(0)),
          _row('Выручка', _m(x['revenue']!)),
          if (x['returns']! != 0) _row('Возвраты', _m(x['returns']!)),
          const Divider(),
          _row('Наличными', _m(x['cash']!)),
          _row('Картой', _m(x['card']!)),
          _row('QR', _m(x['qr']!)),
          if (x['credit']! > 0) _row('В долг', _m(x['credit']!)),
          const Divider(),
          _row('Размен', _m(x['openingFloat']!)),
          _row('Внесения', _m(x['deposits']!)),
          _row('Изъятия', _m(x['withdrawals']!)),
          const Divider(),
          _row('Должно быть в кассе', _m(x['expectedCash']!), bold: true),
        ]),
      )),
      const SizedBox(height: 10),
      Row(children: [
        Expanded(child: OutlinedButton(
          onPressed: () => _cashOpDialog(session, 'deposit', 'Внесение'),
          child: const Text('Внесение'))),
        const SizedBox(width: 8),
        Expanded(child: OutlinedButton(
          onPressed: () => _cashOpDialog(session, 'withdrawal', 'Изъятие'),
          child: const Text('Изъятие'))),
      ]),
      const SizedBox(height: 16),
      FilledButton(
        onPressed: () => _closeDialog(session),
        style: FilledButton.styleFrom(
          backgroundColor: cs.errorContainer, foregroundColor: cs.onErrorContainer,
          padding: const EdgeInsets.symmetric(vertical: 16)),
        child: const Text('Закрыть смену (Z-отчёт)'),
      ),
    ]);
  }

  String _m(double v) => '${v.toStringAsFixed(0)} ₸';

  Widget _row(String l, String r, {bool bold = false}) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 2),
        child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
          Text(l),
          Text(r, style: TextStyle(fontWeight: bold ? FontWeight.bold : null)),
        ]),
      );

  Future<void> _cashOpDialog(PosSession session, String kind, String title) async {
    final amount = TextEditingController();
    final comment = TextEditingController();
    final ok = await showDialog<bool>(context: context, builder: (_) => AlertDialog(
      title: Text(title),
      content: Column(mainAxisSize: MainAxisSize.min, children: [
        TextField(controller: amount, keyboardType: TextInputType.number,
            decoration: const InputDecoration(labelText: 'Сумма, ₸')),
        TextField(controller: comment, decoration: const InputDecoration(labelText: 'Комментарий')),
      ]),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Отмена')),
        FilledButton(onPressed: () => Navigator.pop(context, true), child: Text(title)),
      ],
    ));
    if (ok == true) {
      await session.cashOperation(kind, double.tryParse(amount.text) ?? 0,
          comment: comment.text.isEmpty ? null : comment.text);
      await _refreshX();
    }
  }

  Future<void> _closeDialog(PosSession session) async {
    await _refreshX();
    final expected = _x?['expectedCash'] ?? 0;
    final actual = TextEditingController(text: expected.toStringAsFixed(0));
    final comment = TextEditingController();
    String dialogErr = '';

    await showDialog(context: context, builder: (_) => StatefulBuilder(builder: (ctx, setD) {
      final a = double.tryParse(actual.text) ?? 0;
      final disc = a - expected;
      return AlertDialog(
        title: const Text('Закрытие смены'),
        content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('Должно быть в кассе: ${expected.toStringAsFixed(0)} ₸'),
          const SizedBox(height: 10),
          TextField(controller: actual, keyboardType: TextInputType.number,
              decoration: const InputDecoration(labelText: 'Пересчитано фактически, ₸'),
              onChanged: (_) => setD(() {})),
          if (disc.abs() >= 1) ...[
            const SizedBox(height: 8),
            Text(disc > 0 ? 'Излишек ${disc.toStringAsFixed(0)} ₸' : 'Недостача ${(-disc).toStringAsFixed(0)} ₸',
                style: TextStyle(color: Theme.of(ctx).colorScheme.error)),
            TextField(controller: comment,
                decoration: const InputDecoration(labelText: 'Объяснение расхождения (обязательно)')),
          ],
          if (dialogErr.isNotEmpty) Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(dialogErr, style: TextStyle(color: Theme.of(ctx).colorScheme.error))),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Отмена')),
          FilledButton(onPressed: () async {
            try {
              final z = await session.closeShift(double.tryParse(actual.text) ?? 0,
                  comment: comment.text.isEmpty ? null : comment.text);
              if (ctx.mounted) {
                Navigator.pop(ctx);
                _showZ(z);
              }
            } catch (e) { setD(() => dialogErr = e.toString()); }
          }, child: const Text('Закрыть')),
        ],
      );
    }));
  }

  void _showZ(Map<String, double> z) {
    showDialog(context: context, builder: (_) => AlertDialog(
      title: const Text('Z-отчёт: смена закрыта'),
      content: Column(mainAxisSize: MainAxisSize.min, children: [
        _row('Чеков', z['receipts']!.toStringAsFixed(0)),
        _row('Выручка', _m(z['revenue']!)),
        _row('Наличными в кассе', _m(z['actualCash']!)),
        if (z['discrepancy']! != 0) _row('Расхождение', _m(z['discrepancy']!), bold: true),
      ]),
      actions: [FilledButton(onPressed: () {
        Navigator.pop(context); Navigator.pop(context);
      }, child: const Text('Готово'))],
    ));
  }
}
