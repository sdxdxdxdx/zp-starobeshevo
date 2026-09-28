// Расчёт ЗП точки: чистые функции без DOM.
// В браузере доступен как window.ZpCalc, в Node — через require.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ZpCalc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Ставки — в десятых долях процента: 125 = 12,5%.
  const STAFF_BONUS = 25;      // +2,5% к тел и акс
  const STAFF_BONUS_MIN = 3;   // ...если в штате от 3 человек
  const AIR_RATE = 500;        // воздух — 50%
  const NET_PERCENT = 87;      // остаток после НДФЛ 13%

  const TARIFFS = [
    { key: 'smart', label: 'Смарт М', rate: 100 },
    { key: 'prosto', label: 'Просто М', rate: 150 },
    { key: 'super', label: 'Супер М', rate: 200 },
    { key: 'ultra', label: 'Ультра М', rate: 300 },
    { key: 'mega', label: 'Мега М', rate: 400 },
  ];

  // Шкала: первый порог (% выполнения), которого факт не достиг, задаёт ставку; иначе — last.
  const TEL_TIERS = { steps: [[90, 75], [95, 100], [105, 115]], last: 125 };
  const ACC_TIERS = { steps: [[90, 105], [100, 130]], last: 140 };

  const TIERS = { tel: TEL_TIERS, acc: ACC_TIERS };

  // Сравнение в целых копейках: во float 18003.6 * 100 < 20004 * 90, хотя это ровно 90%.
  function kopecks(amount) {
    return Math.round(amount * 100);
  }

  function tierRate(fact, plan, tiers) {
    for (const [threshold, rate] of tiers.steps) {
      if (kopecks(fact) * 100 < kopecks(plan) * threshold) return rate;
    }
    return tiers.last;
  }

  // Процент выполнения вниз до 0,1: 89,998% показываем как 89,9%, а не 90%.
  function percentOf(fact, plan) {
    return Math.floor(kopecks(fact) * 1000 / kopecks(plan)) / 10;
  }

  // Процент и ставка по одной строке маржи; null, если факт или план не годятся.
  function marginPreview(kind, fact, plan, staffCount) {
    if (!isNum(fact) || !isNum(plan) || fact < 0 || plan <= 0) return null;
    const bonus = staffCount >= STAFF_BONUS_MIN ? STAFF_BONUS : 0;
    return { percent: percentOf(fact, plan), rate: tierRate(fact, plan, TIERS[kind]) + bonus };
  }

  function premiumOf(amount, rate) {
    return Math.round(amount * rate / 1000);
  }

  function netOf(amount) {
    return Math.floor(Math.round(amount * NET_PERCENT) / 100);
  }

  function isNum(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  function validate(input) {
    const errors = [];
    const need = (field, label, value) => {
      if (!isNum(value)) errors.push({ field, message: `${label}: не заполнено` });
      else if (value < 0) errors.push({ field, message: `${label}: не может быть меньше 0` });
    };
    need('telFact', 'Маржа тел, факт', input.telFact);
    need('telPlan', 'Маржа тел, план', input.telPlan);
    need('accFact', 'Маржа акс, факт', input.accFact);
    need('accPlan', 'Маржа акс, план', input.accPlan);
    need('airFact', 'Воздух, факт', input.airFact);
    const sims = input.sims || {};
    for (const t of TARIFFS) need('sims.' + t.key, `${t.label}, шт`, sims[t.key]);
    need('salary', 'Оклад', input.salary);
    need('staffCount', 'Сотрудников в штате', input.staffCount);
    if (input.telPlan === 0) errors.push({ field: 'telPlan', message: 'Маржа тел, план: должен быть больше 0' });
    if (input.accPlan === 0) errors.push({ field: 'accPlan', message: 'Маржа акс, план: должен быть больше 0' });

    const employees = input.employees || [];
    if (employees.length === 0) {
      errors.push({ field: 'employees', message: 'Добавьте хотя бы одного сотрудника' });
    }
    employees.forEach((e, i) => {
      const who = `Сотрудник ${i + 1}`;
      if (!e.name || !String(e.name).trim()) {
        errors.push({ field: `employees.${i}.name`, message: `${who}: не указано ФИО` });
      }
      need(`employees.${i}.shifts`, `${who}: смены`, e.shifts);
      need(`employees.${i}.fine`, `${who}: штраф`, e.fine);
      need(`employees.${i}.advance`, `${who}: аванс`, e.advance);
    });
    const shiftsOk = employees.length > 0 && employees.every((e) => isNum(e.shifts) && e.shifts >= 0);
    if (shiftsOk && employees.reduce((s, e) => s + e.shifts, 0) === 0) {
      errors.push({ field: 'employees', message: 'Всего смен 0 — премию и оклад не на что делить' });
    }
    return errors;
  }

  function compute(input) {
    const errors = validate(input);
    if (errors.length) return { ok: false, errors };

    const staffBonus = input.staffCount >= STAFF_BONUS_MIN;
    const marginLine = (kind, fact, plan) => {
      const { percent, rate } = marginPreview(kind, fact, plan, input.staffCount);
      return { fact, plan, percent, rate, premium: premiumOf(fact, rate) };
    };

    const tel = marginLine('tel', input.telFact, input.telPlan);
    const acc = marginLine('acc', input.accFact, input.accPlan);
    const air = { fact: input.airFact, rate: AIR_RATE, premium: premiumOf(input.airFact, AIR_RATE) };
    const sims = TARIFFS.map((t) => ({
      key: t.key, label: t.label, rate: t.rate,
      count: input.sims[t.key], sum: input.sims[t.key] * t.rate,
    }));
    const simsTotal = sims.reduce((s, x) => s + x.sum, 0);

    const premiumTotal = tel.premium + acc.premium + air.premium + simsTotal;
    const premiumNet = netOf(premiumTotal);
    const totalShifts = input.employees.reduce((s, e) => s + e.shifts, 0);
    const premiumPerShift = Math.floor(premiumNet / totalShifts);
    const salaryNet = netOf(input.salary);
    const salaryPerShift = Math.floor(salaryNet / totalShifts);
    const perShift = premiumPerShift + salaryPerShift;

    const employees = input.employees.map((e) => {
      const earned = Math.round(perShift * e.shifts);
      return {
        name: String(e.name).trim(), shifts: e.shifts, fine: e.fine, advance: e.advance,
        earned, pay: earned - e.fine - e.advance,
      };
    });

    return {
      ok: true, staffBonus, tel, acc, air, sims, simsTotal,
      premiumTotal, premiumNet, totalShifts, premiumPerShift,
      salary: input.salary, salaryNet, salaryPerShift, perShift, employees,
    };
  }

  return { compute, marginPreview, TARIFFS };
});
