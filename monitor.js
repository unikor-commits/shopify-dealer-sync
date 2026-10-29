// Daily summary + problem watcher, both written by the AI agent.

const agent = require('./agent');
const jobs = require('./jobs');
const { sendEmail } = require('./notify');

// 1) Daily summary
async function dailySummary() {
  const text = await agent.ask([
    {
      role: 'user',
      content:
        'Write my daily store summary for the last 24 hours. Include: number of orders and total sales, ' +
        'best-selling items, orders still waiting for tracking, any failed or stuck orders, and low-stock items. ' +
        'End with a short list of what I should do today (or say all is good). Plain text, no markdown tables.',
    },
  ]);
  await sendEmail(`Daily store summary – ${new Date().toLocaleDateString('en-US')}`, text);
}

// 2) Problem watcher: checks every hour, fixes what it safely can,
//    and only emails you when something new needs your attention.
let lastAlertKey = '';

async function watchForProblems() {
  let status = agent.getSyncStatus();

  // Automatic fix: retry orders that failed to reach the dealer
  if (status.failed.length) {
    await jobs.retryFailed();
    status = agent.getSyncStatus();
  }

  let lowStock = [];
  try {
    lowStock = await agent.getLowStock();
  } catch (err) {
    console.error('Low stock check failed:', err.message);
  }

  const problems = {
    failed: status.failed.map((o) => o.order),
    stuck: status.stuckNoTracking.map((o) => o.order),
    lowStock: lowStock.map((v) => v.sku || v.item),
  };
  const key = JSON.stringify(problems);
  const hasProblems = problems.failed.length || problems.stuck.length || problems.lowStock.length;

  if (!hasProblems) {
    lastAlertKey = '';
    return;
  }
  if (key === lastAlertKey) return; // already told you about these
  lastAlertKey = key;

  const text = await agent.ask([
    {
      role: 'user',
      content:
        'You are running as the automatic problem watcher. Failed orders were already retried once. ' +
        `Current problems: ${key}. Look up details with your tools, then write a short alert explaining ` +
        'each problem and exactly what I should do (for example contact the dealer about a stuck order, ' +
        'or restock / hide a low-stock item). Plain text.',
    },
  ]);
  await sendEmail('Store alert: something needs your attention', text);
}

module.exports = { dailySummary, watchForProblems };
