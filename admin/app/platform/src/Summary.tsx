/*
 * Сводка платформы: где мы сейчас и куда движемся.
 *
 * Живые таблицы знают только «сейчас». Чтобы ответить «месяц назад
 * было лучше или хуже», нужны снимки по дням — их пишет сервер при
 * каждом открытии этого экрана.
 *
 * Массовые действия отсюда ушли в «Настройки»: самая опасная функция
 * платформы не должна стоять между графиком и таблицей, где на неё
 * нажимают походя.
 */
import { useQuery } from '@tanstack/react-query';
import { humanError } from './ui/errors';
import { call, money } from './main';
import { Chart } from './ui/Chart';
import type { ChartPoint } from './ui/Chart';
import { Failed, PageHead, SkeletonCards, SkeletonMetrics } from './ui/States';

type Day = {
  day: string; tenants: number; paid: number; trial: number;
  expired: number; mrr: number; revenue: number;
  /* приходит только в снимке за сегодня */
  pending?: number;
};

type Partner = {
  place: number; animal: string; name: string;
  clients: number; paid: number; mrr: number;
};

const short = (iso: string): string =>
  new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });

const long = (iso: string): string =>
  new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });

const plural = (n: number, one: string, few: string, many: string): string => {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
};

export function Summary({ token }: { token: string }) {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ['metrics'],
    queryFn: () => call<{ today: Day; series: Day[]; partners: Partner[] }>(
      '/metrics?days=30', { token }),
  });

  if (isPending) {
    return (
      <>
        <PageHead title="Сводка платформы" sub="За 30 дней" />
        <SkeletonMetrics count={6} />
        <SkeletonCards count={2} height={220} />
      </>
    );
  }

  if (isError || !data) {
    return (
      <>
        <PageHead title="Сводка платформы" sub="За 30 дней" />
        <Failed text={humanError(error)} onRetry={() => void refetch()} />
      </>
    );
  }

  const t = data.today;
  const first = data.series[0];
  const deltaPaid = first ? t.paid - first.paid : 0;
  const deltaMrr = first ? t.mrr - first.mrr : 0;

  const paidPoints: ChartPoint[] = data.series.map((d) => ({ label: short(d.day), value: d.paid }));
  const mrrPoints: ChartPoint[] = data.series.map((d) => ({ label: short(d.day), value: d.mrr }));
  const since = first ? long(first.day) : null;

  const sign = (n: number): string => (n > 0 ? `+${n}` : String(n));

  return (
    <>
      <PageHead
        title="Сводка платформы"
        sub={since ? `С ${since} по сегодня` : 'За 30 дней'}
      />

      <div className="cards">
        <div className="card money">
          <span>Доход в месяц</span><b>{money(t.mrr)}</b>
          {first && (
            <div className="sub">
              {deltaMrr === 0 ? 'без изменений за месяц' : `${deltaMrr > 0 ? '+' : '−'}${money(Math.abs(deltaMrr))} за месяц`}
            </div>
          )}
        </div>
        <div className="card ok">
          <span>Платят</span><b>{t.paid}</b>
          {first && (
            <div className="sub">
              {deltaPaid === 0 ? 'без изменений за месяц' : `${sign(deltaPaid)} за месяц`}
            </div>
          )}
        </div>
        <div className="card"><span>На пробном</span><b>{t.trial}</b></div>
        <div className="card bad"><span>Просрочены</span><b>{t.expired}</b></div>
        <div className="card"><span>Ждут одобрения</span><b>{t.pending ?? 0}</b></div>
        <div className="card"><span>Всего заведений</span><b>{t.tenants}</b></div>
        <div className="card money"><span>Поступило сегодня</span><b>{money(t.revenue)}</b></div>
      </div>

      <div className="chart-grid">
        <section className="chart-box">
          <div className="chart-head">
            <h2>Платящие клиенты</h2>
            <span>{t.paid} сейчас · {sign(deltaPaid)} за месяц</span>
          </div>
          <Chart
            title="Платящие клиенты за 30 дней"
            points={paidPoints}
            format={(v) => String(Math.round(v))}
          />
        </section>

        <section className="chart-box">
          <div className="chart-head">
            <h2>Доход в месяц</h2>
            <span>{money(t.mrr)} сейчас</span>
          </div>
          <Chart
            title="Доход в месяц за 30 дней"
            points={mrrPoints}
            format={(v) => money(v)}
          />
        </section>
      </div>

      <h2 className="section-title">Партнёры за 30 дней</h2>
      {data.partners.length === 0 && (
        <p className="note">Партнёров пока нет — заведите их во вкладке «Партнёры».</p>
      )}
      {data.partners.length > 0 && (
        <table className="grid ranking">
          <thead>
            <tr>
              <th>Место</th><th>Партнёр</th>
              <th className="num">Клиентов</th>
              <th className="num">Платят</th>
              <th className="num">Их доход в месяц</th>
            </tr>
          </thead>
          <tbody>
            {data.partners.map((p) => (
              <tr key={p.name + p.place}>
                <td data-label="Место">
                  <span className="place">{p.place}</span>
                  <span className="animal" title="знак партнёра">{p.animal}</span>
                </td>
                <td data-label="Партнёр"><b>{p.name}</b></td>
                <td data-label="Клиентов" className="num">
                  {p.clients} {plural(p.clients, 'клиент', 'клиента', 'клиентов')}
                </td>
                <td data-label="Платят" className="num"><b>{p.paid}</b></td>
                <td data-label="Их доход в месяц" className="num">{money(p.mrr)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
