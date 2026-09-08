const day = (ts) => new Date(ts).toISOString().slice(0, 10);

function series(list, days) {
  const map = {};
  const now = Date.now();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now - i * 86400000).toISOString().slice(0, 10);
    map[d] = { d, count: 0, amount: 0 };
  }
  for (const r of list) {
    const d = day(r.created_at || r.paid_at || r.requested_at || r.ts);
    if (map[d]) {
      map[d].count += 1;
      map[d].amount += Number(r.amount || 0);
    }
  }
  return Object.values(map);
}

async function userStats(db, user) {
  const pays = await db.payments.listByUser(user.id, 500);
  const wds = await db.withdrawals.listByUser(user.id, 500);
  const paid = pays.filter((p) => p.status === 'PAID');
  const paidWd = wds.filter((w) => w.status !== 'REJECTED');

  const totalDeposit = paid.reduce((a, p) => a + Number(p.amount || 0), 0);
  const totalFee = paid.reduce((a, p) => a + Number(p.fee || 0), 0);
  const totalPaidAmount = paid.reduce((a, p) => a + Number(p.pay_amount || 0), 0);
  const totalWithdraw = paidWd.reduce((a, w) => a + Number(w.amount || 0), 0);
  const pendingWithdraw = wds.filter((w) => w.status === 'PENDING').reduce((a, w) => a + Number(w.amount || 0), 0);

  const daily = series(paid, 14).map((s) => ({ ...s }));

  return {
    balance: Number(user.balance || 0),
    totalDeposit,
    totalFee,
    totalPaidAmount,
    totalWithdraw,
    pendingWithdraw,
    countPaid: paid.length,
    countAll: pays.length,
    pendingPayments: pays.filter((p) => p.status === 'PENDING').length,
    daily,
  };
}

async function ownerStats(db) {
  const [users, payments, withdrawals] = await Promise.all([
    db.users.list(),
    db.payments.list({ limit: 5000 }),
    db.withdrawals.list({ limit: 5000 }),
  ]);

  const paid = payments.filter((p) => p.status === 'PAID');
  const pendingPayments = payments.filter((p) => p.status === 'PENDING').length;
  const wdPending = withdrawals.filter((w) => w.status === 'PENDING');
  const wdDone = withdrawals.filter((w) => w.status === 'DONE');

  const volume = paid.reduce((a, p) => a + Number(p.pay_amount || 0), 0);
  const grossDeposit = paid.reduce((a, p) => a + Number(p.amount || 0), 0);
  const feesEarned = paid.reduce((a, p) => a + Number(p.fee || 0), 0);
  const successCount = paid.length;
  const totalWithdraw = wdDone.reduce((a, w) => a + Number(w.amount || 0), 0);
  const pendingWithdrawSum = wdPending.reduce((a, w) => a + Number(w.amount || 0), 0);
  const totalBalance = users.reduce((a, u) => a + Number(u.balance || 0), 0);

  const outflows = [...payments.map((p) => ({ amount: Number(p.amount || 0), ts: p.paid_at || p.created_at, d: day(p.paid_at || p.created_at) })), ...wdDone.map((w) => ({ amount: Number(w.amount || 0), ts: w.processed_at || w.requested_at }))];

  return {
    users: users.length,
    payments: payments.length,
    successCount,
    successRate: payments.length ? Math.round((successCount / payments.length) * 100) : 0,
    pendingPayments,
    volume,
    grossDeposit,
    feesEarned,
    totalWithdraw,
    pendingWithdraw: wdPending.length,
    pendingWithdrawSum,
    totalBalance,
    daily: series(paid, 14),
  };
}

module.exports = { userStats, ownerStats, series };