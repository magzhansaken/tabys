import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'core/api_client.dart';
import 'core/session.dart';
import 'core/sync_engine.dart';
import 'data/local_db.dart';
import 'features/pairing/pairing_screen.dart';
import 'features/pin/pin_screen.dart';
import 'features/sale/sale_screen.dart';

/// КАССА. Один код — Windows, Android, iOS, Sunmi (решение части 1.4).
/// Маршрут определяется состоянием: не привязана → привязка;
/// нет кассира → PIN; есть — продажа. Никаких «загрузок из сети» на пути
/// к чеку: всё, что нужно для продажи, уже в локальной базе.
/// Версия кассы. Задаётся при сборке, видна на экране входа.
/// Урок с боевой кассы: без видимой версии на вопрос «какая у тебя
/// версия?» не ответит ни кассир, ни владелец — а без этого нельзя
/// понять, доехало ли обновление.
const kAppVersion = String.fromEnvironment('APP_VERSION', defaultValue: 'dev');

/// Адрес сервера — тоже задаётся при сборке, чтобы касса из коробки
/// знала, куда подключаться, и кассиру не пришлось ничего вводить.
const kApiUrl = String.fromEnvironment('API_URL', defaultValue: 'http://localhost:3000');

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  final db = LocalDb();
  final api = ApiClient(baseUrl: kApiUrl);
  final sync = SyncEngine(db, api);
  runApp(PosApp(db: db, api: api, sync: sync));
}

class PosApp extends StatelessWidget {
  const PosApp({super.key, required this.db, required this.api, required this.sync});
  final LocalDb db;
  final ApiClient api;
  final SyncEngine sync;

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        Provider.value(value: db),
        Provider.value(value: api),
        Provider.value(value: sync),
        ChangeNotifierProvider(create: (_) => PosSession(db, api, sync)),
      ],
      child: MaterialApp(
        title: 'Касса',
        debugShowCheckedModeBanner: false,
        theme: ThemeData(
          useMaterial3: true,
          colorSchemeSeed: const Color(0xFF00AA77),
          brightness: Brightness.dark,          // тёмная: не слепит в зале и меньше жрёт батарею Sunmi
          visualDensity: VisualDensity.comfortable,
        ),
        home: const _Root(),
      ),
    );
  }
}

class _Root extends StatefulWidget {
  const _Root();
  @override
  State<_Root> createState() => _RootState();
}

class _RootState extends State<_Root> {
  bool? _paired;

  @override
  void initState() {
    super.initState();
    context.read<ApiClient>().deviceToken().then((t) {
      if (mounted) setState(() => _paired = t != null);
      if (t != null) {
        final api = context.read<ApiClient>();
        context.read<SyncEngine>().start(
              wsUrl: api.baseUrl.replaceFirst('http', 'ws'),
              deviceToken: t,
            );
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final session = context.watch<PosSession>();
    if (_paired == null) return const Scaffold(body: Center(child: CircularProgressIndicator()));
    if (_paired == false && !session.paired) {
      return PairingScreen(onPaired: () => setState(() => _paired = true));
    }
    if (session.currentStaff == null) return const PinScreen();
    return const SaleScreen();
  }
}
