import 'dart:io' show Platform;
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../core/api_client.dart';
import '../../core/session.dart';

/// ПРИВЯЗКА КАССЫ. Владелец в кабинете нажимает «Сгенерировать код»
/// (модель UMAG: одноразовый ключ авторизации кассы), кассир вводит его
/// здесь один раз. Дальше устройство узнаётся по токену из хранилища ОС —
/// логин и пароль владельца в торговом зале не светятся (в отличие от Wipon).
class PairingScreen extends StatefulWidget {
  const PairingScreen({super.key, required this.onPaired});
  final VoidCallback onPaired;

  @override
  State<PairingScreen> createState() => _PairingScreenState();
}

class _PairingScreenState extends State<PairingScreen> {
  final _code = TextEditingController();
  String _err = '';
  bool _busy = false;

  String get _platform {
    if (kIsWeb) return 'web';
    if (Platform.isWindows) return 'windows';
    if (Platform.isAndroid) return 'android';
    if (Platform.isIOS) return 'ios';
    return 'other';
  }

  Future<void> _pair() async {
    setState(() { _err = ''; _busy = true; });
    try {
      await context.read<PosSession>().pair(_code.text.trim(),
          platform: _platform, appVersion: '1.0.0');
      widget.onPaired();
    } on OfflineException {
      setState(() => _err = 'Нет связи с сервером. Для первой привязки нужен интернет — дальше касса работает и без него.');
    } catch (e) {
      setState(() => _err = e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 420),
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Icon(Icons.point_of_sale, size: 56),
                const SizedBox(height: 12),
                Text('Привязка кассы', style: Theme.of(context).textTheme.headlineSmall, textAlign: TextAlign.center),
                const SizedBox(height: 8),
                const Text(
                  'В кабинете: Точки и кассы → выберите кассу → «Код привязки». Код действует 10 минут.',
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 20),
                TextField(
                  controller: _code,
                  autofocus: true,
                  textAlign: TextAlign.center,
                  style: const TextStyle(fontSize: 28, letterSpacing: 6),
                  decoration: const InputDecoration(hintText: '000000', border: OutlineInputBorder()),
                  onSubmitted: (_) => _pair(),
                ),
                if (_err.isNotEmpty) ...[
                  const SizedBox(height: 12),
                  Text(_err, style: TextStyle(color: Theme.of(context).colorScheme.error)),
                ],
                const SizedBox(height: 16),
                FilledButton(
                  onPressed: _busy ? null : _pair,
                  style: FilledButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 16)),
                  child: Text(_busy ? 'Привязываем…' : 'Привязать'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
