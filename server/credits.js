'use strict';
const { db, tx } = require('./db');

// One wallet for every paid action. 1 credit is priced at roughly $0.01 on paid plans.
const COSTS = {
  reveal_email: 1,        // per contact revealed (verified or risky email + phone)
  ai_criterion_row: 1,    // per company x criterion evaluated
  prompt_filter_row: 1,   // per company checked by a prompt filter
  gtm_email: 3,           // per AutoGTM email actually sent (about $0.03)
};
const FREE_SIGNUP_CREDITS = 500;

const PLANS = [
  { id: 'free', name: 'Free', price_usd: 0, monthly_credits: 500, ai_criteria_per_search: 1, seats: 1, features: ['Unlimited company search', '500 credits once', '1 AI criterion per search', 'CSV export of revealed contacts'] },
  { id: 'starter', name: 'Starter', price_usd: 49, monthly_credits: 5000, ai_criteria_per_search: 3, seats: 1, features: ['5,000 credits / month', '3 AI criteria per search', 'Lookalike search', 'Lists and saved searches'] },
  { id: 'growth', name: 'Growth', price_usd: 329, monthly_credits: 40000, ai_criteria_per_search: 5, seats: 3, features: ['40,000 credits / month', '5 AI criteria per search', 'AutoGTM agent', '3 seats'] },
  { id: 'scale', name: 'Scale', price_usd: 490, monthly_credits: 65000, ai_criteria_per_search: 10, seats: 10, features: ['65,000 credits / month', '10 AI criteria per search', 'Priority enrichment', '10 seats'] },
];
const TOPUPS = [{ id: 'topup_1k', credits: 1000, price_usd: 12 }, { id: 'topup_5k', credits: 5000, price_usd: 50 }, { id: 'topup_20k', credits: 20000, price_usd: 180 }];

class InsufficientCredits extends Error {
  constructor(needed, balance) { super(`This needs ${needed} credits; you have ${balance}.`); this.status = 402; this.needed = needed; this.balance = balance; }
}

function balance(userId) { return db.prepare('SELECT credits FROM users WHERE id = ?').get(userId)?.credits ?? 0; }

function charge(userId, amount, reason, ref = null, { inTx = false } = {}) {
  if (amount <= 0) return balance(userId);
  const run = () => {
    const bal = balance(userId);
    if (bal < amount) throw new InsufficientCredits(amount, bal);
    db.prepare('UPDATE users SET credits = credits - ? WHERE id = ?').run(amount, userId);
    db.prepare('INSERT INTO credit_ledger (user_id, delta, reason, ref, balance_after) VALUES (?,?,?,?,?)').run(userId, -amount, reason, ref, bal - amount);
    return bal - amount;
  };
  return inTx ? run() : tx(run);
}

function grant(userId, amount, reason, ref = null) {
  return tx(() => {
    db.prepare('UPDATE users SET credits = credits + ? WHERE id = ?').run(amount, userId);
    const bal = balance(userId);
    db.prepare('INSERT INTO credit_ledger (user_id, delta, reason, ref, balance_after) VALUES (?,?,?,?,?)').run(userId, amount, reason, ref, bal);
    return bal;
  });
}

const planFor = (user) => PLANS.find((p) => p.id === user.plan) || PLANS[0];

module.exports = { COSTS, PLANS, TOPUPS, FREE_SIGNUP_CREDITS, InsufficientCredits, balance, charge, grant, planFor };
