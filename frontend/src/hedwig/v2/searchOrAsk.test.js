// node --test src/hedwig/v2/searchOrAsk.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchOrAsk } from './searchOrAsk.js';

test('questions and requests go to Ask', () => {
  for (const q of [
    'find out all the AI expenses my team has mailed to me',
    'show me the invoices from last month',
    'list every flight booking',
    'summarize the thread with the landlord',
    'what did Anna say about the deposit',
    'Did the bank reply',
    'invoice total for October?',
    'how much did we spend on AI',
    'please find the signed contract',
    'tell me what is waiting on me',
  ]) assert.equal(searchOrAsk(q), 'ask', q);
});

test('a sentence of five words or more goes to Ask', () => {
  assert.equal(searchOrAsk('AI expenses my team sent'), 'ask');
});

test('keywords, addresses and search operators stay a search', () => {
  for (const q of [
    'invoice',
    'AI expenditure',
    'Anna October invoice',
    'anna@example.com',
    'from:anna subject:"Invoice" has:attachment',
    'is:unread from:bank',
    '"find out all the AI expenses"',
    '',
    '   ',
  ]) assert.equal(searchOrAsk(q), 'search', q);
});
