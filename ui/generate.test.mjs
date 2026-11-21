import { test } from 'node:test';
import assert from 'node:assert/strict';
import { businessDay, generateOptions, randomValid } from './generate.js';

test('random values respect the schema and stay everyday-sized', () => {
  for (let i = 0; i < 50; i++) {
    const amount = randomValid({ type: 'number', format: 'decimal', minimum: 0.01, maximum: 7.9e28 }).value;
    assert.ok(amount >= 0.01 && amount <= 10000.01, `amount ${amount} is in an everyday range`);
    assert.equal(Math.round(amount * 100) / 100, amount, 'at most two decimals');
    const text = randomValid({ type: 'string', maxLength: 12 }).value;
    assert.ok(text.length <= 12, 'length limit');
    const day = new Date(randomValid({ type: 'string', format: 'date' }).value + 'T00:00:00Z');
    assert.ok(![0, 6].includes(day.getUTCDay()), 'dates are business days');
  }
  assert.match(randomValid({ type: 'string', format: 'email' }).value, /^[a-z]+\.[a-z]+@example\.test$/);
  assert.match(randomValid({ type: 'string', pattern: '^[A-Z]{2}\\d{4}$' }).value, /^[A-Z]{2}\d{4}$/);
  assert.notEqual(randomValid({ type: 'string', enum: ['A', 'B'] }, 'A').value, 'A', 'enum picks another member');
  assert.ok(new Date(businessDay(1)) > new Date());
});

test('the menu separates valid values from deliberately invalid ones', () => {
  const { valid, invalid } = generateOptions({ type: 'number', minimum: 0.01 });
  assert.ok(valid.every(option => typeof option.value === 'number' && option.value >= 0.01));
  assert.deepEqual(invalid.map(option => option.value ?? option.text), [0, '10.005', 'abc']);
  const text = generateOptions({ type: 'string', maxLength: 5 });
  assert.ok(text.invalid.some(option => option.value?.length === 6), 'one character over the limit');
});
