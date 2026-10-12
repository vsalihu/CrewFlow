import { expect, test, type Page } from '@playwright/test';

// Hours journey through the real UI: a coordinator records a client timesheet, cannot approve it,
// payroll approves it with a justification for the unbooked worker, exports it, downloads the
// stored file and records the manual payroll import. Nothing is sent anywhere.

async function signIn(page: Page, who: RegExp) {
  await page.goto('/login');
  await page.getByLabel('Synthetic staff member').selectOption({ label: (await page.getByRole('option', { name: who }).textContent())! });
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

function today(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
}

test('timesheet hours are approved by someone else and exported once', async ({ page, context }) => {
  await signIn(page, /Hana Lowell/);
  await expect(page.getByRole('link', { name: 'Payroll Exports' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Attendance' }).first().click();
  await page.getByRole('link', { name: 'Record Timesheet' }).click();

  await page.getByLabel('Client site').selectOption({ label: 'Marshland Growers: Haddon Fen Packhouse' });
  await page.getByLabel('Supplied by (supervisor)').fill('Site supervisor (synthetic)');
  await page.getByLabel('Timesheet exactly as received').fill('K Ruschev 07:00-15:00 (synthetic)');
  await page.getByLabel('Name as written').fill('K Ruschev');
  await page.getByLabel('Worker', { exact: true }).selectOption({ label: 'Kaloyan Ruschev' });
  await page.getByLabel('Start', { exact: true }).fill('07:00');
  await page.getByLabel('Finish', { exact: true }).fill('15:00');
  await page.getByRole('button', { name: 'Save Timesheet' }).click();

  await expect(page.getByRole('status')).toContainText('someone else approves it');
  await expect(page.getByText('K Ruschev 07:00-15:00 (synthetic)')).toBeVisible();
  await expect(page.getByText('K Ruschev has hours but no booking for this site and date.')).toBeVisible();
  await expect(page.getByText('You entered this timesheet, so someone else must approve it.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve Hours' })).toHaveCount(0);
  const timesheetUrl = page.url();

  // Payroll approves; the unbooked worker needs a written justification.
  await context.clearCookies();
  await signIn(page, /Tamsin Hale/);
  await page.goto(timesheetUrl);
  await page.getByLabel('Why approve despite the items to review').fill('Supervisor confirmed by phone he covered a late gap (synthetic)');
  await page.getByRole('button', { name: 'Approve Hours' }).click();
  await expect(page.getByRole('status')).toContainText('Timesheet approved');

  await page.getByRole('link', { name: 'Payroll Exports' }).click();
  await page.getByLabel('Work dates from').fill(today());
  await page.getByLabel('to', { exact: true }).fill(today());
  await page.getByRole('button', { name: 'Create Export' }).click();
  await expect(page.getByRole('status')).toContainText(/Export EXP-\S+ created \(hours, 1 rows\)/);

  const link = page.getByRole('link', { name: /^EXP-.*\.csv$/ });
  const res = await page.request.get((await link.getAttribute('href'))!);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('text/csv');
  const csv = await res.text();
  expect(csv.split('\n')[0]).toContain('export_reference,row_type');
  expect(csv).toContain('Kaloyan Ruschev');
  expect(csv).toContain(',480,');
  expect(res.headers()['x-content-sha256']).toMatch(/^[0-9a-f]{64}$/);

  // Nothing new to export the second time.
  await page.getByLabel('Work dates from').fill(today());
  await page.getByLabel('to', { exact: true }).fill(today());
  await page.getByRole('button', { name: 'Create Export' }).click();
  await expect(page.getByText(/^Nothing new to export/)).toBeVisible();

  await page.getByPlaceholder('Payroll batch or who confirmed…').fill('PAY-SYN-0001');
  await page.getByRole('button', { name: 'Record Import' }).click();
  await expect(page.getByRole('status')).toContainText('Payroll import recorded');
  await expect(page.getByText('PAY-SYN-0001')).toBeVisible();
});
