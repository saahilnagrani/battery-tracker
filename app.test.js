const test = require('node:test');
const assert = require('node:assert');
const bt = require('./app.js');

const H = 3600e3;
const r = (h, level, charging = false) => ({ t: h * H, level, charging });

test('splits sessions on charging flips and computes rates', () => {
  const rs = [r(0, 100), r(1, 90), r(2, 80), r(3, 80, true), r(4, 100, true), r(5, 95)];
  const s = bt.buildSessions(rs);
  assert.deepStrictEqual(s.map((x) => x.charging), [false, true, false]);
  assert.strictEqual(s[0].rate, 10);
  assert.strictEqual(s[1].rate, 20);
  assert.strictEqual(bt.avgDischargeRate(s), 10);
});

test('breaks a discharge session when the level jumps up between logs', () => {
  const s = bt.buildSessions([r(0, 50), r(1, 40), r(5, 90), r(6, 85)]);
  assert.strictEqual(s.length, 2);
});

test('counts equivalent cycles including unlogged charges', () => {
  assert.strictEqual(bt.equivalentCycles([r(0, 20), r(1, 70), r(2, 30), r(3, 80)]), 1);
});

test('time in bands ignores long gaps', () => {
  const b = bt.timeInBands([r(0, 90), r(1, 85), r(2, 50), r(20, 10), r(21, 5)]);
  assert.strictEqual(b.hours, 3);
  assert.ok(Math.abs(b.high - 2 / 3) < 1e-9);
  assert.ok(Math.abs(b.low - 1 / 3) < 1e-9);
});

test('estimates remaining time while discharging and charging', () => {
  const dis = [r(0, 80), r(1, 70), r(2, 60)];
  assert.strictEqual(bt.estimateRemaining(dis, bt.buildSessions(dis), null), 6);
  const chg = [r(0, 40, true), r(1, 70, true)];
  assert.strictEqual(bt.estimateRemaining(chg, bt.buildSessions(chg), null), 1);
});

test('parses Termux CSV and round-trips its own export', () => {
  const csv = 'timestamp,percentage,status,plugged,temperature,current,health\n' +
    '2026-10-01T10:00:00Z,85,DISCHARGING,UNPLUGGED,31.2,-412000,GOOD\n' +
    '2026-10-01T10:15:00Z,86,CHARGING,PLUGGED_AC,33.0,1500000,GOOD\n' +
    'bad,line\n';
  const { readings } = bt.parseImport(csv);
  assert.strictEqual(readings.length, 2);
  assert.deepStrictEqual(readings[0], { t: Date.parse('2026-10-01T10:00:00Z'), level: 85, charging: false, temp: 31.2, current: -412000, health: 'GOOD', src: 'import' });
  assert.strictEqual(readings[1].charging, true);
  const again = bt.parseImport(bt.toCSV(readings)).readings;
  assert.deepStrictEqual(again.map(({ src, ...x }) => x), readings.map(({ src, ...x }) => x));
});

test('merge drops duplicate timestamps and sorts', () => {
  const m = bt.mergeReadings([r(2, 50), r(0, 60)], [r(2, 49), r(1, 55)]);
  assert.deepStrictEqual(m.map((x) => x.level), [60, 55, 50]);
});
