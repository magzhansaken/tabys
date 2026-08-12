import { Controller, Get, Post, Patch, Body, Param, Query, Module, Injectable, BadRequestException } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { Ctx, RequirePermission } from '../auth/guards';
import { EmployeeContext } from '../auth/permissions';
import { FinanceService } from '../finance/finance.service';

/**
 * ДЕНЬГИ И ЛЮДИ (часть 24): зарплата, отделы, договоры, объединение дублей.
 *
 * Замысел — не копировать МойСклад, а взять из него правильную механику и
 * упростить под магазин у дома:
 *  • Зарплата = одна ведомость «к выплате»: оклад ИЛИ смены×ставку + комиссия
 *    консультанта (часть 18) + премия − удержание. Свести комиссию и оклад в
 *    один документ — то, чего нет ни у одного из троих.
 *  • Выплата ложится на готовый fin_move (статья «Зарплата») — сразу в ДДС/П&У.
 *  • Отделы — лёгкая группировка (задел на права, без переусложнения).
 *  • Договоры — минимум полей для ЭСФ/АВР и контроля сроков.
 *  • Объединение дублей — атомарный перенос ВСЕХ связей (после импорта частая боль).
 */

@Injectable()
export class PeopleService {
  constructor(private db: DbService, private finance: FinanceService) {}

  // ---------- ОТДЕЛЫ ----------
  async departments(accountId: string) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT d.id, d.name, count(e.id)::int AS employees
           FROM department d
           LEFT JOIN employee e ON e.department_id = d.id AND e.deleted_at IS NULL
          WHERE d.deleted_at IS NULL
          GROUP BY d.id ORDER BY d.name`)).rows);
  }

  async createDepartment(accountId: string, name: string) {
    if (!name?.trim()) throw new BadRequestException('Название отдела обязательно');
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(`INSERT INTO department (account_id, name) VALUES ($1,$2) RETURNING id, name`,
        [accountId, name.trim()])).rows[0]);
  }

  async assignDepartment(accountId: string, employeeId: string, departmentId: string | null) {
    return this.db.withTenant(accountId, async (c) => {
      await c.query(`UPDATE employee SET department_id=$2 WHERE id=$1`, [employeeId, departmentId]);
      return { ok: true };
    });
  }

  async setSalary(accountId: string, employeeId: string, d: { monthly?: number; perShift?: number }) {
    return this.db.withTenant(accountId, async (c) => {
      await c.query(`UPDATE employee SET salary_monthly=$2, salary_per_shift=$3 WHERE id=$1`,
        [employeeId, d.monthly ?? null, d.perShift ?? null]);
      return { ok: true };
    });
  }

  // ---------- ЗАРПЛАТА ----------

  /**
   * Ведомость «к выплате» за период: для каждого сотрудника считаем базу
   * (оклад или отработанные смены × ставку) и добавляем комиссию консультанта,
   * если сотрудник привязан к консультанту по имени/телефону. Это черновик —
   * владелец правит премию/удержание и проводит.
   */
  async payrollDraft(accountId: string, p: { from: string; to: string }) {
    return this.db.withTenant(accountId, async (c) => {
      const emps = (await c.query(
        `SELECT e.id, e.first_name, e.last_name, e.phone, e.position,
                e.salary_monthly, e.salary_per_shift, d.name AS department
           FROM employee e
           LEFT JOIN department d ON d.id = e.department_id
          WHERE e.deleted_at IS NULL AND e.dismissed_at IS NULL
          ORDER BY e.first_name`)).rows;

      const rows = [];
      for (const e of emps) {
        // смены сотрудника за период (по факту закрытых)
        const sh = (await c.query(
          `SELECT count(*)::int AS n FROM shift
            WHERE account_id=$1 AND opened_by=$2
              AND opened_at >= $3 AND opened_at < $4 AND closed_at IS NOT NULL`,
          [accountId, e.id, p.from, p.to])).rows[0]?.n ?? 0;

        // комиссия консультанта: сопоставляем по телефону (консультант-справочник
        // и сотрудник могут быть одним человеком)
        const comm = e.phone ? (await c.query(
          `SELECT coalesce(sum(cr.commission),0) AS commission
             FROM consultant con
             CROSS JOIN LATERAL consultant_report($1,$3,$4) cr
            WHERE con.phone = $2 AND cr.consultant_id = con.id AND con.deleted_at IS NULL`,
          [accountId, e.phone, p.from, p.to])).rows[0]?.commission ?? 0 : 0;

        const base = e.salary_monthly != null ? Number(e.salary_monthly)
          : e.salary_per_shift != null ? Number(e.salary_per_shift) * sh : 0;
        const commission = Number(comm);
        rows.push({
          employeeId: e.id, name: `${e.first_name} ${e.last_name ?? ''}`.trim(),
          position: e.position, department: e.department,
          salaryMonthly: e.salary_monthly != null ? Number(e.salary_monthly) : null,
          salaryPerShift: e.salary_per_shift != null ? Number(e.salary_per_shift) : null,
          shiftsCount: sh, base, commission,
          accrued: Math.round((base + commission) * 100) / 100,
        });
      }
      return { period: p, rows };
    });
  }

  /** Провести начисление сотруднику (с премией/удержанием от владельца) */
  async accrue(accountId: string, employeeId: string | null, d: {
    employeeId: string; from: string; to: string;
    base: number; shiftsCount?: number; commission?: number; bonus?: number; deduction?: number; comment?: string;
  }) {
    const total = Math.round(((d.base ?? 0) + (d.commission ?? 0) + (d.bonus ?? 0) - (d.deduction ?? 0)) * 100) / 100;
    if (total < 0) throw new BadRequestException('Итог к выплате не может быть отрицательным');
    return this.db.withTenant(accountId, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO payroll (account_id, employee_id, period_from, period_to, base_amount,
           shifts_count, commission, bonus, deduction, total_accrued, status, comment, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'accrued',$11,$12) RETURNING *`,
        [accountId, d.employeeId, d.from, d.to, d.base ?? 0, d.shiftsCount ?? 0,
         d.commission ?? 0, d.bonus ?? 0, d.deduction ?? 0, total, d.comment ?? null, employeeId]);
      return this.mapPayroll(rows[0]);
    });
  }

  /**
   * Выплата зарплаты. Проводим расход по статье «Зарплата» на сотрудника —
   * деньги уходят со счёта, видно в ДДС/П&У. Отмечаем начисление оплаченным.
   */
  async pay(accountId: string, employeeId: string | null, payrollId: string, d: { finAccountId?: string; amount?: number }) {
    return this.db.withTenant(accountId, async (c) => {
      const pr = (await c.query(`SELECT * FROM payroll WHERE id=$1`, [payrollId])).rows[0];
      if (!pr) throw new BadRequestException('Начисление не найдено');
      const remaining = Number(pr.total_accrued) - Number(pr.paid_amount);
      const amount = d.amount ?? remaining;
      if (amount <= 0) throw new BadRequestException('Нечего выплачивать — начисление уже оплачено');
      if (amount > remaining + 0.01) throw new BadRequestException(`К выплате осталось ${remaining} ₸`);

      const cat = (await c.query(
        `SELECT id FROM fin_category WHERE account_id=$1 AND name='Зарплата' LIMIT 1`, [accountId])).rows[0];

      // расход на сотрудника (fin_move сам спишет со счёта и попадёт в отчёты)
      await this.finance.expense(accountId, {
        finAccountId: d.finAccountId, amount, categoryId: cat?.id,
        employeeId: pr.employee_id, comment: `Зарплата за ${pr.period_from}–${pr.period_to}`,
      });

      const paid = Number(pr.paid_amount) + amount;
      await c.query(
        `UPDATE payroll SET paid_amount=$2, status=CASE WHEN $2 >= total_accrued THEN 'paid' ELSE 'accrued' END
           WHERE id=$1`, [payrollId, paid]);
      return { ok: true, paid, status: paid >= Number(pr.total_accrued) ? 'paid' : 'partial' };
    });
  }

  async payrollHistory(accountId: string) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT p.*, (e.first_name || ' ' || coalesce(e.last_name,'')) AS employee_name
           FROM payroll p JOIN employee e ON e.id = p.employee_id
          WHERE p.account_id=$1 ORDER BY p.created_at DESC LIMIT 100`, [accountId])).rows
        .map((r: any) => this.mapPayroll(r)));
  }

  private mapPayroll(r: any) {
    return {
      id: r.id, employeeId: r.employee_id, employeeName: r.employee_name,
      periodFrom: r.period_from, periodTo: r.period_to,
      base: Number(r.base_amount), shiftsCount: r.shifts_count,
      commission: Number(r.commission), bonus: Number(r.bonus), deduction: Number(r.deduction),
      totalAccrued: Number(r.total_accrued), paidAmount: Number(r.paid_amount),
      status: r.status, comment: r.comment, createdAt: r.created_at,
    };
  }

  // ---------- ДОГОВОРЫ ----------
  async contracts(accountId: string, counterpartyId?: string) {
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `SELECT ct.*, cp.name AS counterparty_name
           FROM contract ct JOIN counterparty cp ON cp.id = ct.counterparty_id
          WHERE ct.deleted_at IS NULL
            AND ($1::uuid IS NULL OR ct.counterparty_id = $1)
          ORDER BY ct.signed_date DESC NULLS LAST, ct.created_at DESC`,
        [counterpartyId ?? null])).rows.map((r: any) => ({
          id: r.id, counterpartyId: r.counterparty_id, counterpartyName: r.counterparty_name,
          number: r.number, kind: r.kind, signedDate: r.signed_date, validUntil: r.valid_until,
          amount: r.amount != null ? Number(r.amount) : null, isActive: r.is_active, comment: r.comment,
          // подсветка истечения: договор с валидностью в прошлом — просрочен
          expired: r.valid_until && new Date(r.valid_until) < new Date(),
        })));
  }

  async createContract(accountId: string, d: any) {
    if (!d.counterpartyId) throw new BadRequestException('Выберите контрагента');
    if (!d.number?.trim()) throw new BadRequestException('Укажите номер договора');
    if (!['sale', 'commission', 'supply'].includes(d.kind ?? 'sale'))
      throw new BadRequestException('Тип договора: купли-продажи, комиссии или поставки');
    return this.db.withTenant(accountId, async (c) =>
      (await c.query(
        `INSERT INTO contract (account_id, counterparty_id, number, kind, signed_date, valid_until, amount, comment)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [accountId, d.counterpartyId, d.number.trim(), d.kind ?? 'sale',
         d.signedDate ?? null, d.validUntil ?? null, d.amount ?? null, d.comment ?? null])).rows[0]);
  }

  // ---------- ОБЪЕДИНЕНИЕ ДУБЛЕЙ ----------
  /**
   * Атомарный перенос всех связей дублей на основного (модель МоегоСклада).
   * Отменить нельзя — поэтому проверяем вход и делаем в одной транзакции.
   */
  async mergeCounterparties(accountId: string, primaryId: string, dupeIds: string[]) {
    if (!primaryId) throw new BadRequestException('Выберите основного контрагента');
    if (!dupeIds?.length) throw new BadRequestException('Выберите хотя бы одного дубля');
    if (dupeIds.includes(primaryId)) throw new BadRequestException('Основной не может быть среди дублей');
    return this.db.withTenant(accountId, async (c) => {
      const { rows } = await c.query(
        `SELECT merge_counterparties($1,$2,$3::uuid[]) AS moved`,
        [accountId, primaryId, dupeIds]);
      return { ok: true, merged: rows[0].moved };
    });
  }
}

// =====================================================================
@Controller('people')
export class PeopleController {
  constructor(private svc: PeopleService) {}

  @Get('departments') @RequirePermission('employees', 'view')
  departments(@Ctx() ctx: EmployeeContext) { return this.svc.departments(ctx.accountId); }

  @Post('departments') @RequirePermission('employees', 'edit')
  createDepartment(@Ctx() ctx: EmployeeContext, @Body() d: { name: string }) {
    return this.svc.createDepartment(ctx.accountId, d.name);
  }

  @Post('employees/:id/department') @RequirePermission('employees', 'edit')
  assignDept(@Ctx() ctx: EmployeeContext, @Param('id') id: string, @Body() d: { departmentId: string | null }) {
    return this.svc.assignDepartment(ctx.accountId, id, d.departmentId);
  }

  @Post('employees/:id/salary') @RequirePermission('employees', 'edit')
  setSalary(@Ctx() ctx: EmployeeContext, @Param('id') id: string, @Body() d: any) {
    return this.svc.setSalary(ctx.accountId, id, d);
  }

  @Get('payroll/draft') @RequirePermission('finance', 'view')
  payrollDraft(@Ctx() ctx: EmployeeContext, @Query() q: any) {
    const to = q.to ?? new Date().toISOString().slice(0, 10);
    const from = q.from ?? `${to.slice(0, 7)}-01`;
    return this.svc.payrollDraft(ctx.accountId, { from, to: `${to}T23:59:59.999` });
  }

  @Post('payroll/accrue') @RequirePermission('finance', 'edit')
  accrue(@Ctx() ctx: EmployeeContext, @Body() d: any) {
    return this.svc.accrue(ctx.accountId, ctx.employeeId, d);
  }

  @Post('payroll/:id/pay') @RequirePermission('finance', 'edit')
  pay(@Ctx() ctx: EmployeeContext, @Param('id') id: string, @Body() d: any) {
    return this.svc.pay(ctx.accountId, ctx.employeeId, id, d);
  }

  @Get('payroll') @RequirePermission('finance', 'view')
  payrollHistory(@Ctx() ctx: EmployeeContext) { return this.svc.payrollHistory(ctx.accountId); }

  @Get('contracts') @RequirePermission('contragents', 'view')
  contracts(@Ctx() ctx: EmployeeContext, @Query('counterpartyId') cp?: string) {
    return this.svc.contracts(ctx.accountId, cp);
  }

  @Post('contracts') @RequirePermission('contragents', 'edit')
  createContract(@Ctx() ctx: EmployeeContext, @Body() d: any) {
    return this.svc.createContract(ctx.accountId, d);
  }

  @Post('counterparties/merge') @RequirePermission('contragents', 'edit')
  merge(@Ctx() ctx: EmployeeContext, @Body() d: { primaryId: string; dupeIds: string[] }) {
    return this.svc.mergeCounterparties(ctx.accountId, d.primaryId, d.dupeIds);
  }
}

@Module({
  imports: [],
  controllers: [PeopleController],
  providers: [PeopleService, DbService, FinanceService],
})
export class PeopleModule {}
