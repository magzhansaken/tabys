import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../core/session.dart';
import '../../domain/cart.dart';

/// ЭКРАН ОПЛАТЫ. Решения части 4 в железе:
/// - кнопки номиналов (500…20000 ₸) — находка Wipon, сдача сама;
/// - смешанная: ввёл одну сумму — вторая подставилась;
/// - «в долг» активна только при выбранном покупателе (правило Wipon);
/// - QR — отдельный способ (Kaspi — половина оборота в Казахстане).
class PaymentSheet extends StatefulWidget {
  const PaymentSheet({super.key});
  @override
  State<PaymentSheet> createState() => _PaymentSheetState();
}

class _PaymentSheetState extends State<PaymentSheet> {
  String _method = 'cash';                       // cash / card / qr / credit / mixed
  final _cashGiven = TextEditingController();
  final _mixedCash = TextEditingController();
  final _bonusSpend = TextEditingController();   // бонусы поверх любого метода
  String _err = '';
  bool _busy = false;

  double get _given => double.tryParse(_cashGiven.text.replaceAll(',', '.')) ?? 0;

  Future<void> _complete(PosSession session, Payment pay) async {
    setState(() { _err = ''; _busy = true; });
    try {
      await session.completeSale(pay);
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      setState(() { _err = e.toString(); _busy = false; });
    }
  }

  @override
  Widget build(BuildContext context) {
    final session = context.watch<PosSession>();
    final cart = session.cart;
    final bonus = double.tryParse(_bonusSpend.text) ?? 0;
    final total = (cart.total - bonus).clamp(0, double.infinity).toDouble(); // к доплате
    final cs = Theme.of(context).colorScheme;

    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('К оплате: ${total.toStringAsFixed(0)} ₸',
              style: const TextStyle(fontSize: 26, fontWeight: FontWeight.bold), textAlign: TextAlign.center),
          if (cart.customerId != null && cart.maxBonusSpend > 0) ...[
            const SizedBox(height: 8),
            // МС-модель: оплата баллами — на кассе, правила — из кабинета
            Row(children: [
              Expanded(child: TextField(
                controller: _bonusSpend, keyboardType: TextInputType.number,
                decoration: InputDecoration(
                  labelText: 'Списать бонусы (до ${cart.maxBonusSpend.toStringAsFixed(0)} ₸)',
                  border: const OutlineInputBorder(), isDense: true),
                onChanged: (_) => setState(() {}))),
              const SizedBox(width: 8),
              OutlinedButton(
                onPressed: () => setState(() => _bonusSpend.text = cart.maxBonusSpend.toStringAsFixed(0)),
                child: const Text('Все')),
            ]),
            if (cart.bonusEarnPreview(bonus) > 0)
              Padding(padding: const EdgeInsets.only(top: 4),
                child: Text('Будет начислено: +${cart.bonusEarnPreview(bonus).toStringAsFixed(0)} ₸',
                  style: TextStyle(fontSize: 12, color: cs.primary))),
          ],
          const SizedBox(height: 14),
          SegmentedButton<String>(
            segments: [
              const ButtonSegment(value: 'cash', label: Text('Наличные')),
              const ButtonSegment(value: 'card', label: Text('Карта')),
              const ButtonSegment(value: 'qr', label: Text('QR')),
              const ButtonSegment(value: 'mixed', label: Text('Смешанно')),
              ButtonSegment(value: 'credit',
                  label: Text(cart.creditAvailable == null ? 'В долг'
                      : 'В долг (до ${cart.creditAvailable!.toStringAsFixed(0)})'),
                  enabled: cart.customerId != null),   // правило Wipon
            ],
            selected: {_method},
            onSelectionChanged: (s) => setState(() { _method = s.first; _err = ''; }),
          ),
          if (cart.customerId == null && _method != 'credit')
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text('Для продажи в долг выберите покупателя',
                  style: TextStyle(fontSize: 12, color: cs.outline)),
            ),
          const SizedBox(height: 14),

          // ---------- наличные ----------
          if (_method == 'cash') ...[
            Wrap(spacing: 8, runSpacing: 8, children: [
              FilledButton.tonal(
                onPressed: () => setState(() => _cashGiven.text = total.toStringAsFixed(0)),
                child: const Text('Без сдачи')),
              for (final d in kztDenominations.where((d) => d >= total))
                OutlinedButton(
                  onPressed: () => setState(() => _cashGiven.text = '$d'),
                  child: Text('$d')),
            ]),
            const SizedBox(height: 10),
            TextField(
              controller: _cashGiven,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(labelText: 'Получено наличными', border: OutlineInputBorder()),
              onChanged: (_) => setState(() {}),
            ),
            const SizedBox(height: 8),
            Text('Сдача: ${cart.changeFor(_given).toStringAsFixed(0)} ₸',
                style: const TextStyle(fontSize: 20)),
          ],

          // ---------- смешанная ----------
          if (_method == 'mixed') ...[
            TextField(
              controller: _mixedCash,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(labelText: 'Наличными', border: OutlineInputBorder()),
              onChanged: (_) => setState(() {}),
            ),
            const SizedBox(height: 8),
            // вторая сумма подставляется сама (Wipon)
            Text('Картой: ${cart.remainderAfter(double.tryParse(_mixedCash.text) ?? 0).toStringAsFixed(0)} ₸',
                style: const TextStyle(fontSize: 18)),
          ],

          if (_err.isNotEmpty) ...[
            const SizedBox(height: 10),
            Text(_err, style: TextStyle(color: cs.error)),
          ],
          const SizedBox(height: 16),
          FilledButton(
            onPressed: _busy ? null : () {
              final p = switch (_method) {
                'cash' => Payment(bonus: bonus, cash: _given >= total ? _given : total,
                    change: (( _given >= total ? _given : total) - total).clamp(0, double.infinity).toDouble()),
                'card' => Payment(bonus: bonus, card: total),
                'qr' => Payment(bonus: bonus, qr: total),
                'credit' => Payment(bonus: bonus, credit: total),
                _ => () {
                    final c = double.tryParse(_mixedCash.text) ?? 0;
                    return Payment(bonus: bonus, cash: c,
                        card: (total - c).clamp(0, double.infinity).toDouble());
                  }(),
              };
              // долг сверх лимита — подтверждение старшего прямо здесь
              if (p.credit > 0 && cart.creditAvailable != null &&
                  p.credit > cart.creditAvailable! && cart.creditApprovedBy == null) {
                final pin = TextEditingController();
                final okd = await showDialog<bool>(context: context, builder: (ctx) => AlertDialog(
                  title: const Text('Долг сверх лимита'),
                  content: Column(mainAxisSize: MainAxisSize.min, children: [
                    Text('Доступно ${cart.creditAvailable!.toStringAsFixed(0)} ₸, нужно ${p.credit.toStringAsFixed(0)} ₸'),
                    TextField(controller: pin, obscureText: true, keyboardType: TextInputType.number,
                        decoration: const InputDecoration(labelText: 'PIN администратора')),
                  ]),
                  actions: [
                    TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Отмена')),
                    FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Разрешить')),
                  ]));
                if (okd != true) return;
                final approver = await session.auth.approve(
                    requestedBy: session.currentStaff!.id, action: 'credit_over_limit', pin: pin.text);
                if (approver == null) {
                  setState(() => _err = 'PIN старшего не подошёл');
                  return;
                }
                cart.creditApprovedBy = approver.id;
              }
              _complete(session, p);
            },
            style: FilledButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 18)),
            child: Text(_busy ? 'Проводим…' : 'ПРОБИТЬ ЧЕК', style: const TextStyle(fontSize: 18)),
          ),
        ]),
      ),
    );
  }
}
