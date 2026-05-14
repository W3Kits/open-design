import { expect, test } from '@playwright/test';

const STORAGE_KEY = 'open-design:config';

test.beforeEach(async ({ page }) => {
  await page.addInitScript((key) => {
    window.localStorage.setItem(
      key,
      JSON.stringify({
        mode: 'daemon',
        apiKey: '',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-5',
        agentId: 'mock',
        skillId: null,
        designSystemId: null,
        onboardingCompleted: true,
        agentModels: {},
      }),
    );
  }, STORAGE_KEY);

  await page.route('**/api/agents', async (route) => {
    await route.fulfill({
      json: {
        agents: [
          {
            id: 'mock',
            name: 'Mock Agent',
            bin: 'mock-agent',
            available: true,
            version: 'test',
            models: [{ id: 'default', label: 'Default' }],
          },
        ],
      },
    });
  });
});

test('entry chrome settings menu opens with brand header and no pet rail', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.entry-nav-rail')).toBeVisible();
  await expect(page.getByTestId('entry-nav-logo')).toBeVisible();
  await expect(page.getByTestId('entry-nav-new-project')).toBeVisible();
  await expect(page.locator('.entry-brand')).toHaveCount(0);

  // The pet picker rail was removed; pet adoption now lives in
  // Settings → Pet exclusively. Make sure no rail leaks back into the
  // entry layout.
  await expect(page.locator('.pet-rail')).toHaveCount(0);

  const openSettings = page.getByRole('button', { name: /open settings/i });
  await openSettings.click();
  const settingsMenu = page.locator('.avatar-popover[role="menu"]');
  await expect(settingsMenu).toBeVisible();
  await expect(settingsMenu.getByRole('button', { name: /hide pet picker/i })).toHaveCount(0);
  await expect(settingsMenu.getByRole('button', { name: /show pet picker/i })).toHaveCount(0);
});

test('entry top navigation matches the current home tab structure', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('entry-nav-home')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('entry-nav-new-project')).toBeVisible();
  await expect(page.getByTestId('entry-nav-projects')).toBeVisible();
  await expect(page.getByTestId('entry-nav-tasks')).toBeVisible();
  await expect(page.getByTestId('entry-nav-plugins')).toBeVisible();
  await expect(page.getByTestId('entry-nav-design-systems')).toBeVisible();
  await expect(page.getByTestId('entry-nav-integrations')).toBeVisible();
});

test('entry chrome avoids horizontal overflow on compact desktop width', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 900 });
  await page.goto('/');
  await expect(page.locator('.entry-nav-rail')).toBeVisible();
  await expect(page.locator('.entry-main__topbar')).toBeVisible();

  // The shared app chrome header should stay one row and avoid pushing
  // the entry layout sideways on compact desktop widths.
  const headerOverflow = await page.evaluate(() => {
    const header = document.querySelector('.entry-main__topbar');
    if (!(header instanceof HTMLElement)) return null;
    return Math.max(0, header.scrollWidth - header.clientWidth);
  });
  expect(headerOverflow).not.toBeNull();
  expect(headerOverflow!).toBeLessThanOrEqual(2);

  const pageOverflow = await page.evaluate(() =>
    Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
  );
  expect(pageOverflow).toBeLessThanOrEqual(2);
});
