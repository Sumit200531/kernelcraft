import { test, expect, type Page } from '@playwright/test';

const open = async (page: Page, sample: string) => {
  await page.goto(`/#sample=${sample}`);
  await expect(page.locator('.status-pill')).toBeVisible();
  await page.keyboard.press('End');
};
const term = async (page: Page, cmd: string) => {
  const input = page.getByLabel('Terminal command');
  await input.fill(cmd);
  await input.press('Enter');
  await input.press('Escape');
};

test('deadlock: detect, inspect, recover from the terminal, replay identically', async ({ page }) => {
  await open(page, 'deadlock-abba');
  await expect(page.locator('.status-pill')).toHaveText(/deadlock/i);
  await expect(page.locator('.finding').first()).toContainText('Deadlock between transfer1.main, transfer2.main');
  await expect(page.locator('.finding .verdict').first()).toContainText('Confirmed');

  await term(page, 'locks');
  await expect(page.locator('.terminal')).toContainText('DEADLOCK: transfer1.main → transfer2.main');
  await term(page, 'kill 1');
  await expect(page.locator('.terminal')).toContainText('killed transfer2.main at t=8');
  await page.keyboard.press('End');
  await expect(page.locator('.status-pill')).toHaveText(/done/i);

  const hash = await page.locator('.view-meta').innerText();
  await page.keyboard.press('Home');
  await page.keyboard.press('End');
  await expect(page.locator('.view-meta')).toHaveText(hash);
});

test('race: lost updates are explained and the atomic fix is applied for real', async ({ page }) => {
  await open(page, 'race-counter');
  const card = page.locator('.finding').first();
  await expect(card).toContainText(/Data race on counter: \d+ updates lost/);
  await card.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByLabel('Workload source')).toHaveValue(/atomic_inc counter/);
  await expect(page.locator('.findings')).toContainText('no problems found');
  await term(page, 'vars');
  await expect(page.locator('.terminal')).toContainText('counter      = 80  (expected 80)');
});

test('time travel: scrubbing and stepping show the state computed at that tick', async ({ page }) => {
  await open(page, 'convoy');
  await page.keyboard.press('Home');
  await expect(page.locator('.tick-readout')).toContainText('t=0');
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  await expect(page.locator('.tick-readout')).toContainText('t=5');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(page.locator('.tick-readout')).toContainText('t=15');
  await term(page, 'ps');
  await expect(page.locator('.terminal')).toContainText(/render\.main\s+running/);
  // the state at t=30 is the state *before* tick 30 executes: pong has just exited, tick is ready
  await term(page, 'goto 30');
  await term(page, 'ps');
  await expect(page.locator('.terminal')).toContainText(/pong\.main\s+terminated/);
  await term(page, 'goto 31');
  await term(page, 'ps');
  await expect(page.locator('.terminal')).toContainText(/tick\.main\s+running/);
});

test('events: clicking a page fault explains it in the inspector', async ({ page }) => {
  await open(page, 'thrashing');
  await page.keyboard.press('Home');
  await page.getByLabel('Filter events').fill('page fault on page');
  await page.locator('.ev').first().click();
  await expect(page.locator('.inspector')).toContainText('PAGE_FAULT');
  await expect(page.locator('.inspector')).toContainText('cold miss');
  await page.keyboard.press('2');
  await expect(page.locator('.frame').first()).toBeVisible();
});

test('assistant answers from the trace with clickable citations', async ({ page }) => {
  await open(page, 'priority-inversion');
  await page.keyboard.press('/');
  const input = page.getByLabel('Ask the assistant');
  await expect(input).toBeFocused();
  await input.fill('why is control late?');
  await input.press('Enter');
  const answer = page.locator('.msg.assistant').last();
  await expect(answer).toContainText('Priority inversion');
  await expect(answer).toContainText('inherit=true');
  await answer.locator('.evref').first().click();
  await expect(page.locator('.inspector')).toBeVisible();
});

test('config edits through the terminal re-run the workload', async ({ page }) => {
  await open(page, 'convoy');
  await term(page, 'set scheduler=sjf');
  await expect(page.locator('.terminal')).toContainText('config updated');
  await expect(page.getByLabel('Workload source')).toHaveValue(/scheduler=sjf/);
  await expect(page.locator('.findings')).toContainText('no problems found');
});

test('editor reports errors with positions and blocks running', async ({ page }) => {
  await open(page, 'convoy');
  await page.getByLabel('Workload source').fill('config scheduler=lottery\nprocess A\n  lock nope');
  await expect(page.locator('.diag-bar')).toContainText('1:8');
  await expect(page.locator('.diag-bar')).toContainText('Unknown mutex `nope`');
  await expect(page.locator('header .btn.primary').first()).toBeDisabled();
});

test('recordings are saved through the API and verified as reproducible', async ({ page }) => {
  const name = `e2e recording ${Date.now()}`;
  await open(page, 'producer-consumer');
  await term(page, 'signal empty');
  await page.getByLabel('Save recording').click();
  await expect(page.getByLabel('Recording title')).toBeFocused();
  await page.getByLabel('Recording title').fill(name);
  await page.getByRole('button', { name: 'Save current run' }).click();
  await expect(page.locator('.toast')).toContainText(`saved "${name}"`);
  const row = page.locator('.rec', { hasText: name }).first();
  await row.getByRole('button', { name: 'Verify' }).click();
  await expect(row).toContainText('reproducible ✓');
  await row.getByRole('button', { name: 'Replay' }).click();
  await expect(page.locator('.toast')).toContainText('matches');
  await page.getByLabel('Recordings').click();
  const again = page.locator('.rec', { hasText: name }).first();
  await again.getByLabel(`Delete ${name}`).click();
  await again.getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('.rec', { hasText: name })).toHaveCount(0);
});

test('layout has no horizontal overflow on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#sample=web-stack');
  await expect(page.locator('.status-pill')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
