import { expect, test, type Page } from '@playwright/test';

// Minimum coordinator journey through the real UI: capture a late request beside its source,
// accept a quantity, assign an eligible worker, record their reply, and draft/send a booking.

async function signIn(page: Page, who: RegExp) {
  await page.goto('/login');
  await page.getByLabel('Synthetic staff member').selectOption({ label: (await page.getByRole('option', { name: who }).textContent())! });
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/operations/);
}

function tomorrow(): string {
  const d = new Date(Date.now() + 24 * 3600 * 1000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(d);
}

test('coordinator takes a request from paste to a sent booking', async ({ page }) => {
  await signIn(page, /Hana Lowell/);

  // 1. Capture the request with its original text.
  await page.getByRole('link', { name: 'New Order' }).first().click();
  await page.getByLabel('Message or call notes, exactly as received').fill('Need 2 graders at the packhouse tomorrow, 7am start please (synthetic)');
  await page.getByLabel('Client').selectOption({ label: 'Marshland Growers' });
  await page.getByLabel('Work date').fill(tomorrow());
  await page.getByLabel('Site').selectOption({ label: 'Haddon Fen Packhouse' });
  await page.getByLabel('Entrance / field').selectOption({ label: 'Packhouse staff gate' });
  await page.getByLabel('Role').fill('Grader');
  await page.getByLabel('Requested').fill('2');
  await page.getByLabel('Arrive by').fill('06:50');
  await page.getByLabel('Paid start').fill('07:00');
  await page.getByLabel('Expected end (blank if unknown)').fill('15:00');
  await page.getByRole('button', { name: 'Save Request' }).click();
  await expect(page.getByRole('status')).toContainText('Nothing is accepted until you decide');
  await expect(page.getByText('Agency has not decided how many it accepts.')).toBeVisible();
  await expect(page.getByText('Need 2 graders at the packhouse tomorrow')).toBeVisible();

  // 2. Agency decision.
  await page.getByLabel('Line 1 (requested 2)').fill('2');
  await page.getByRole('button', { name: 'Record Decision' }).click();
  await expect(page.getByRole('status')).toContainText('accepted');

  // 3. Assign an eligible worker; an ineligible one is explained and cannot be selected.
  await page.getByRole('link', { name: 'Assign Workers' }).click();
  await expect(page.getByRole('row', { name: /Emil Garvanov/ })).toContainText('expired');
  await expect(page.getByLabel('Select Emil Garvanov')).toBeDisabled();
  await page.getByLabel('Select Kaloyan Ruschev').check();
  await page.getByLabel('Transport label for Kaloyan Ruschev').fill('OWN');
  await page.getByRole('button', { name: 'Propose Selected' }).click();
  await expect(page.getByRole('status')).toContainText('Proposed is not confirmed');
  await expect(page.getByText('Roster label: “OWN” (not interpreted)')).toBeVisible();

  // 4. Record the worker's reply for the current version.
  await page
    .getByRole('row', { name: /Kaloyan Ruschev/ })
    .getByRole('button', { name: 'Save' })
    .click();
  await expect(page.getByRole('status')).toContainText('Response recorded');

  // 5. Draft the booking, then record a manual send. Copying is not sending.
  await page
    .getByRole('row', { name: /Kaloyan Ruschev/ })
    .getByRole('button', { name: 'Draft' })
    .click();
  await expect(page.getByRole('heading', { name: 'Worker Booking' })).toBeVisible();
  await expect(page.getByText(/Arrive by: 06:50/)).toBeVisible();
  await page.getByRole('button', { name: 'I Have Sent It' }).click();
  await expect(page.getByRole('status')).toContainText('not delivery or agreement');

  // 6. The board reflects it, with remaining blockers stated.
  await page.getByRole('link', { name: 'Operations' }).first().click();
  await page.getByRole('link', { name: 'Tomorrow' }).click();
  const row = page.getByRole('row', { name: /Marshland Growers/ }).first();
  await expect(row).toContainText('2 / 2 / 1 / 0');
  await expect(row).toContainText('1 of 2 not confirmed by workers.');
});

test('a coordinator from another branch cannot open the order', async ({ page }) => {
  await signIn(page, /Hana Lowell/);
  await page.getByRole('link', { name: 'Tomorrow' }).click();
  const href = await page
    .getByRole('row', { name: /Marshland Growers/ })
    .first()
    .getByRole('link')
    .first()
    .getAttribute('href');
  await page.getByRole('button', { name: 'Sign Out' }).click();
  await signIn(page, /Calum Brisk/);
  const res = await page.goto(href!);
  expect(res?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Not Found' })).toBeVisible();
  await expect(page.getByText('Marshland Growers')).toHaveCount(0);
});
