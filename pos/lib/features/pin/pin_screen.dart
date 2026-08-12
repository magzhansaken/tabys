import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../core/offline_auth.dart';
import '../../core/session.dart';
import '../../main.dart' show kAppVersion;   // версия сборки

/// ВХОД ПО PIN. 4 цифры, крупная клавиатура — кассир входит за две секунды,
/// в том числе без интернета (хэши приехали при привязке). Пять неверных —
/// блок на 5 минут, тоже офлайн.
class PinScreen extends StatefulWidget {
  const PinScreen({super.key});
  @override
  State<PinScreen> createState() => _PinScreenState();
}

class _PinScreenState extends State<PinScreen> {
  String _pin = '';
  String _err = '';

  Future<void> _digit(String d) async {
    if (_pin.length >= 4) return;
    setState(() { _pin += d; _err = ''; });
    if (_pin.length == 4) {
      try {
        final ok = await context.read<PosSession>().login(_pin);
        if (!ok && mounted) setState(() { _err = 'Неверный PIN'; _pin = ''; });
      } on PosAuthException catch (e) {
        if (mounted) setState(() { _err = e.message; _pin = ''; });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Scaffold(
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Text('Введите PIN', style: TextStyle(fontSize: 22)),
            // Версия видна кассиру и владельцу: без неё невозможно понять,
            // доехало ли обновление до этой конкретной кассы.
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text('Табыс $kAppVersion',
                  style: TextStyle(fontSize: 12, color: cs.outline)),
            ),
            const SizedBox(height: 16),
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: List.generate(4, (i) => Container(
                    margin: const EdgeInsets.all(8),
                    width: 18, height: 18,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: i < _pin.length ? cs.primary : cs.surfaceContainerHighest,
                    ),
                  )),
            ),
            SizedBox(height: 8, child: _err.isEmpty ? null : null),
            Text(_err, style: TextStyle(color: cs.error)),
            const SizedBox(height: 16),
            for (final row in const [['1','2','3'], ['4','5','6'], ['7','8','9'], ['','0','⌫']])
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  for (final d in row)
                    Padding(
                      padding: const EdgeInsets.all(6),
                      child: SizedBox(
                        width: 84, height: 68,
                        child: d.isEmpty
                            ? const SizedBox()
                            : FilledButton.tonal(
                                onPressed: () => d == '⌫'
                                    ? setState(() => _pin = _pin.isEmpty ? '' : _pin.substring(0, _pin.length - 1))
                                    : _digit(d),
                                child: Text(d, style: const TextStyle(fontSize: 26)),
                              ),
                      ),
                    ),
                ],
              ),
          ],
        ),
      ),
    );
  }
}
