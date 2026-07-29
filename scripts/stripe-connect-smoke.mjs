#!/usr/bin/env node
/**
 * BE-S11 — exercise Stripe Connect against a real test-mode account.
 *
 * WHY THIS EXISTS
 * The e2e suite forces Stripe into mock mode (`NODE_ENV=test`), and production
 * has never run with a key, so **only the mock branches of StripeService have
 * ever executed**. The line that actually moves money —
 * `transfers.create({ source_transaction })` in `src/payments/stripe.service.ts`
 * — has never run against Stripe. Neither has webhook signature verification:
 * mock mode skips `constructWebhookEvent` entirely.
 *
 * This script closes that gap without a browser. It is NOT part of
 * `npm run test:e2e`: it hits the network and creates real test-mode objects.
 * Run it manually, and before each release.
 *
 *   node scripts/stripe-connect-smoke.mjs
 *
 * PREREQUISITES
 *   STRIPE_SECRET_KEY   a test-mode key (sk_test_…) in .env
 *   Connect enabled on that account — https://dashboard.stripe.com/connect
 *   STRIPE_WEBHOOK_SECRET  only for step 8; skipped when absent
 *
 * WHAT IT CANNOT DO
 * The hosted Express onboarding form has no API. Step 2 creates the account and
 * the onboarding link and stops there. To exercise the *transfer* path without a
 * human, step 3 creates a **Custom** account with prefilled individual details,
 * which test mode enables immediately — a deliberate substitution, and the
 * reason the Express link is only checked for existence.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Stripe from 'stripe';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv() {
  for (const file of ['.env', '.env.local']) {
    try {
      for (const raw of readFileSync(join(ROOT, file), 'utf8').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim();
        if (!(key in process.env)) process.env[key] = line.slice(eq + 1).trim();
      }
    } catch {
      /* file is optional */
    }
  }
}

const results = [];
function record(step, ok, detail) {
  results.push({ step, ok, detail });
  const mark = ok === 'skip' ? '–' : ok ? '✓' : '✗';
  console.log(`${mark} ${step}${detail ? `  ${detail}` : ''}`);
}

async function main() {
  loadEnv();
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.error('STRIPE_SECRET_KEY is not set — nothing to verify.');
    process.exit(2);
  }
  if (!key.startsWith('sk_test_')) {
    console.error('Refusing to run: STRIPE_SECRET_KEY is not a test-mode key.');
    process.exit(2);
  }

  const stripe = new Stripe(key);
  const created = { accounts: [], paymentIntents: [] };

  // 1. Platform account and Connect eligibility --------------------------------
  let connectEnabled = true;
  try {
    const acct = await stripe.accounts.retrieve();
    record('1. platform account', true, `${acct.id} (${acct.country})`);
  } catch (err) {
    record('1. platform account', false, err.message);
    process.exit(1);
  }

  // 2. Express account + onboarding link --------------------------------------
  // Mirrors StripeService.createConnectedAccount / createAccountLink.
  try {
    const express = await stripe.accounts.create({
      type: 'express',
      country: 'DE',
      capabilities: { transfers: { requested: true } },
      business_type: 'individual',
    });
    created.accounts.push(express.id);
    const link = await stripe.accountLinks.create({
      account: express.id,
      refresh_url: process.env.STRIPE_CONNECT_REFRESH_URL || 'http://localhost:3000/inspector/onboarding',
      return_url: process.env.STRIPE_CONNECT_RETURN_URL || 'http://localhost:3000/inspector',
      type: 'account_onboarding',
    });
    record('2. express account + onboarding link', Boolean(link.url), express.id);
  } catch (err) {
    connectEnabled = false;
    record('2. express account + onboarding link', false, err.message);
  }

  if (!connectEnabled) {
    console.log(
      '\nConnect is not enabled on this account, so the money-moving steps cannot run.\n' +
        'Enable it at https://dashboard.stripe.com/connect and re-run.',
    );
    summarise();
    process.exit(1);
  }

  // 3. Custom account, payout-ready without a browser --------------------------
  let payee;
  try {
    payee = await stripe.accounts.create({
      type: 'custom',
      country: 'DE',
      business_type: 'individual',
      capabilities: { transfers: { requested: true }, card_payments: { requested: true } },
      individual: {
        first_name: 'Smoke',
        last_name: 'Test',
        email: `smoke-${Date.now()}@example.com`,
        dob: { day: 1, month: 1, year: 1980 },
        address: { line1: 'Teststraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' },
      },
      business_profile: { mcc: '7538', url: 'https://carsalepro.example' },
      tos_acceptance: { date: Math.floor(Date.now() / 1000), ip: '127.0.0.1' },
      external_account: {
        object: 'bank_account',
        country: 'DE',
        currency: 'eur',
        account_number: 'DE89370400440532013000',
      },
    });
    created.accounts.push(payee.id);
    record('3. payout-ready custom account', true, payee.id);
  } catch (err) {
    record('3. payout-ready custom account', false, err.message);
    await cleanup(stripe, created);
    summarise();
    process.exit(1);
  }

  // 4. Capability gating — the exact predicate syncConnectedAccount uses -------
  try {
    const fresh = await stripe.accounts.retrieve(payee.id);
    const eligible =
      (fresh.charges_enabled || fresh.payouts_enabled) && fresh.details_submitted;
    record(
      '4. capability gating',
      Boolean(eligible),
      `charges=${fresh.charges_enabled} payouts=${fresh.payouts_enabled} submitted=${fresh.details_submitted}`,
    );
  } catch (err) {
    record('4. capability gating', false, err.message);
  }

  // 5. Charge on the platform --------------------------------------------------
  let chargeId;
  try {
    const pi = await stripe.paymentIntents.create({
      amount: 5975, // a real quote total under the current tariff
      currency: 'eur',
      payment_method: 'pm_card_visa',
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      metadata: { purpose: 'order', smoke: 'true' },
    });
    created.paymentIntents.push(pi.id);
    chargeId = typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge?.id;
    record('5. charge on the platform', Boolean(chargeId), `${pi.id} → ${chargeId}`);
  } catch (err) {
    record('5. charge on the platform', false, err.message);
  }

  // 6. THE critical line: transfer with source_transaction ---------------------
  let transferId;
  if (chargeId) {
    try {
      const transfer = await stripe.transfers.create({
        amount: 4780, // the 80% inspector share of 5975
        currency: 'eur',
        destination: payee.id,
        source_transaction: chargeId,
        transfer_group: 'ORD-SMOKE',
      });
      transferId = transfer.id;
      record('6. transfer with source_transaction', true, transfer.id);
    } catch (err) {
      record('6. transfer with source_transaction', false, err.message);
    }
  } else {
    record('6. transfer with source_transaction', 'skip', 'no charge to draw from');
  }

  // 7. Refund ------------------------------------------------------------------
  if (created.paymentIntents.length > 0) {
    try {
      const refund = await stripe.refunds.create({
        payment_intent: created.paymentIntents[0],
        amount: 1000,
        // Reversing the transfer too, which is what a real partial refund on a
        // settled order has to do.
        refund_application_fee: false,
        reverse_transfer: Boolean(transferId),
      });
      record('7. partial refund', refund.status === 'succeeded', refund.id);
    } catch (err) {
      record('7. partial refund', false, err.message);
    }
  } else {
    record('7. partial refund', 'skip', 'no payment intent');
  }

  // 8. Webhook signature verification -----------------------------------------
  // Mock mode never runs constructWebhookEvent, so this is the only place the
  // signature path is exercised at all.
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (webhookSecret) {
    try {
      const payload = JSON.stringify({
        id: 'evt_smoke',
        type: 'transfer.created',
        data: { object: { id: transferId ?? 'tr_smoke' } },
      });
      const header = stripe.webhooks.generateTestHeaderString({
        payload,
        secret: webhookSecret,
      });
      const event = stripe.webhooks.constructEvent(payload, header, webhookSecret);
      record('8. webhook signature verification', event.id === 'evt_smoke', event.type);

      let rejected = false;
      try {
        stripe.webhooks.constructEvent(payload, 't=1,v1=deadbeef', webhookSecret);
      } catch {
        rejected = true;
      }
      record('8b. a forged signature is rejected', rejected);
    } catch (err) {
      record('8. webhook signature verification', false, err.message);
    }
  } else {
    record('8. webhook signature verification', 'skip', 'STRIPE_WEBHOOK_SECRET not set');
  }

  await cleanup(stripe, created);
  summarise();
  process.exit(results.some((r) => r.ok === false) ? 1 : 0);
}

async function cleanup(stripe, created) {
  // Test-mode connected accounts are deletable; charges are not, and do not need
  // to be. Leaving accounts behind clutters the dashboard on every run.
  for (const id of created.accounts) {
    try {
      await stripe.accounts.del(id);
    } catch {
      /* best effort */
    }
  }
}

function summarise() {
  const failed = results.filter((r) => r.ok === false);
  const skipped = results.filter((r) => r.ok === 'skip');
  console.log(
    `\n${results.length - failed.length - skipped.length} passed, ` +
      `${failed.length} failed, ${skipped.length} skipped`,
  );
  for (const f of failed) console.log(`  FAILED: ${f.step} — ${f.detail}`);
}

main().catch((err) => {
  console.error('smoke run threw:', err);
  process.exit(1);
});
