import 'package:drift/drift.dart' hide Column;
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../core/session.dart';
import '../../data/local_db.dart';

/// ВОЗВРАТ ПО ЧЕКУ.
/// Правила части 4: возврат по чеку — единожды (UMAG); чек чужой смены —
/// только с подтверждением старшего (бейдж или PIN, офлайн, две подписи
/// в журнале — наша механика из 1.2).
class RefundScreen extends StatefulWidget {
  const RefundScreen({super.key});
  @override
  State<RefundScreen> createState() => _RefundScreenState();
}

class _RefundScreenState extends State<RefundScreen> {
  List<Sale> _sales = [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final db = context.read<LocalDb>();
    _sales = await (db.select(db.sales)
          ..where((t) => t.status.equals('completed') & t.refundOfId.isNull())
          ..orderBy([(t) => OrderingTerm.desc(t.createdAt)])
          ..limit(50))
        .get();
    if (mounted) setState(() {});
  }

  Future<void> _refund(Sale s) async {
    final session = context.read<PosSession>();
    String? approvedBy;

    if (s.shiftId != session.currentShift?.id) {
      approvedBy = await _askApproval('Возврат по чеку другой смены');
      if (approvedBy == null) return;
    }
    try {
      final r = await session.refund(s.id, approvedBy: approvedBy);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text('Возврат ${r['total']} ₸ (${r['method'] == 'cash' ? 'наличными' : r['method']})')));
        _load();
      }
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.toString())));
    }
  }

  /// Подтверждение старшего: PIN администратора смены. Офлайн — по локальным
  /// хэшам; журнал Approvals получает две подписи.
  Future<String?> _askApproval(String action) async {
    final pin = TextEditingController();
    final ok = await showDialog<bool>(context: context, builder: (_) => AlertDialog(
      title: const Text('Нужно подтверждение старшего'),
      content: Column(mainAxisSize: MainAxisSize.min, children: [
        Text(action),
        TextField(controller: pin, obscureText: true, keyboardType: TextInputType.number,
            decoration: const InputDecoration(labelText: 'PIN администратора')),
      ]),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Отмена')),
        FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Подтвердить')),
      ],
    ));
    if (ok != true) return null;
    final session = context.read<PosSession>();
    final approver = await session.auth.approve(
        requestedBy: session.currentStaff!.id, action: 'refund_foreign_shift', pin: pin.text);
    if (approver == null && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('PIN старшего не подошёл')));
    }
    return approver?.id;
  }

  @override
  Widget build(BuildContext context) {
    final session = context.watch<PosSession>();
    return Scaffold(
      appBar: AppBar(title: const Text('Возврат по чеку')),
      body: _sales.isEmpty
          ? const Center(child: Text('Чеков пока нет'))
          : ListView(children: [
              for (final s in _sales)
                ListTile(
                  leading: Icon(s.shiftId == session.currentShift?.id ? Icons.receipt : Icons.lock_clock),
                  title: Text('Чек №${s.localNumber} · ${s.total.toStringAsFixed(0)} ₸'),
                  subtitle: Text('${s.createdAt.day}.${s.createdAt.month} '
                      '${s.createdAt.hour}:${s.createdAt.minute.toString().padLeft(2, '0')}'
                      '${s.shiftId == session.currentShift?.id ? '' : ' · другая смена'}'),
                  trailing: FilledButton.tonal(onPressed: () => _refund(s), child: const Text('Вернуть')),
                ),
            ]),
    );
  }
}
