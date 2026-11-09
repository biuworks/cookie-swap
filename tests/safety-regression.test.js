import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveClassification, createSiteBinding, learnedIsConfirmed, evaluateLiveCookies } from '../src/refresh.js';

const cookie = (name, value, domain = '.shop.test') => ({ name, value, domain, path: '/', secure: true, session: false, expirationDate: 4_000_000_000 });

test('manual rotation must not promote language preferences to account identity', () => {
  const before = [cookie('sid', 'A1'), cookie('lang', 'zh')];
  const after = [cookie('sid', 'A2'), cookie('lang', 'zh')];
  const classification = resolveClassification({ siteKey: 'shop.test', baseline: before, live: after });
  const binding = createSiteBinding({ profile: { id: 'A', siteKey: 'shop.test' }, cookies: after, classification });
  assert.equal(learnedIsConfirmed(binding), false);
  const switched = [cookie('sid', 'B1'), cookie('lang', 'zh')];
  const decision = evaluateLiveCookies({ classification, baseline: after, live: switched, learnedConfirmed: learnedIsConfirmed(binding) });
  assert.equal(decision.write, false);
});

test('GitHub logged_in alone must never authorize account overwrite', () => {
  const before = [cookie('user_session', 'A', '.github.com'), cookie('logged_in', 'yes', '.github.com')];
  const live = [cookie('user_session', 'B', '.github.com'), cookie('logged_in', 'yes', '.github.com')];
  const classification = resolveClassification({ siteKey: 'github.com', baseline: before, live });
  assert.equal(evaluateLiveCookies({ classification, baseline: before, live }).write, false);
});
