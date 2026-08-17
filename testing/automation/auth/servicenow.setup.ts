import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { SN_INSTANCE, AUTH_STATE, TOKEN_STATE } from '../playwright.config';

/**
 * Authenticate once against ServiceNow and persist the session.
 *
 * Every spec then starts already logged in via `storageState`, so the login form
 * is exercised once per run rather than once per case. That matters for more
 * than speed: repeated failed logins on a PDI can lock the account, and a locked
 * account mid-suite looks exactly like a permissions defect.
 *
 * Nothing is written to disk except the session cookie jar and the user token,
 * both gitignored.
 */
test('authenticate against ServiceNow', async ({ page }) => {
  const user = process.env.SN_USER;
  const password = process.env.SN_PASSWORD;

  expect(
    user,
    'SN_USER is not set. Copy testing/automation/.env.example to .env and fill it in.'
  ).toBeTruthy();
  expect(
    password,
    'SN_PASSWORD is not set. Copy testing/automation/.env.example to .env and fill it in.'
  ).toBeTruthy();

  const response = await page.goto(`${SN_INSTANCE}/login.do`, {
    waitUntil: 'domcontentloaded',
  });

  // A Personal Developer Instance hibernates after inactivity. It still answers
  // on the URL, so this is not a connection error — it is a wall of HTML that no
  // selector matches, and the resulting timeout blames the wrong thing entirely.
  const bodyText = (await page.locator('body').innerText().catch(() => '')) || '';
  if (/hibernat/i.test(bodyText)) {
    throw new Error(
      'The instance is hibernating. Wake it from developer.servicenow.com and re-run. ' +
        `(HTTP ${response?.status()})`
    );
  }

  // Report an unexpected identity provider rather than timing out against a
  // selector that will never appear.
  const usernameField = page.locator('#user_name');
  const isNativeLogin = await usernameField.isVisible().catch(() => false);
  if (!isNativeLogin) {
    throw new Error(
      `Expected the native ServiceNow login form (#user_name) at ${page.url()}, but it is absent. ` +
        'The instance may be redirecting to an external identity provider, which this setup does not handle.'
    );
  }

  await usernameField.fill(user!);
  await page.locator('#user_password').fill(password!);
  await page.locator('#sysverb_login').click();

  // Success is "the login form is gone and the session works", not "we landed on
  // a particular page" — ServiceNow's post-login destination varies with user
  // preferences and UI version.
  await page.waitForLoadState('domcontentloaded');
  await expect(
    page.locator('#user_name'),
    'Still on the login form after submitting — check SN_USER / SN_PASSWORD.'
  ).toBeHidden({ timeout: 30_000 });

  const failureText = (await page.locator('body').innerText().catch(() => '')) || '';
  if (/invalid|incorrect|locked out/i.test(failureText.slice(0, 2000))) {
    throw new Error(
      `Login appears to have been rejected. Page text begins: ${failureText.slice(0, 200)}`
    );
  }

  // Capture the session's user token.
  //
  // ServiceNow refuses a REST call carrying only a session cookie: /api/now/table
  // returns 401 with the browser fully logged in. It wants X-UserToken as well,
  // which is the CSRF defence — a cookie alone would let any site issue
  // authenticated API calls as the signed-in user.
  const userToken = await page.evaluate(
    () => (window as unknown as { g_ck?: string }).g_ck || null
  );
  expect(
    userToken,
    'window.g_ck was not exposed on the post-login page, so the Table API cannot be called.'
  ).toBeTruthy();

  // Prove the session is real by using it, rather than trusting the redirect.
  const check = await page.request.get(
    `${SN_INSTANCE}/api/now/table/sys_user?sysparm_query=user_name=${encodeURIComponent(user!)}` +
      '&sysparm_fields=user_name,name,sys_id&sysparm_limit=1',
    { headers: { 'X-UserToken': userToken! } }
  );
  expect(
    check.ok(),
    `Session did not authenticate against the Table API (HTTP ${check.status()}).`
  ).toBeTruthy();

  fs.mkdirSync(path.dirname(AUTH_STATE), { recursive: true });
  await page.context().storageState({ path: AUTH_STATE });
  // The token is bound to the session the storage state restores, so the two
  // files are only meaningful together. Both are gitignored.
  fs.writeFileSync(
    TOKEN_STATE,
    JSON.stringify({ userToken, capturedAt: new Date().toISOString() }, null, 2)
  );

  const who = await check.json().catch(() => null);
  const me = who?.result?.[0];
  console.log(
    `[auth] signed in to ${SN_INSTANCE} as ${me?.name || user} (${me?.user_name}); ` +
      'session + token saved to .auth/'
  );

  // The manager cases need at least one direct reportee. Saying so here, once,
  // beats four cases failing later with "0 rows rendered" and reading as a
  // widget defect.
  const reportees = await page.request.get(
    `${SN_INSTANCE}/api/now/table/sys_user?sysparm_query=manager=${me?.sys_id}^active=true` +
      '&sysparm_fields=user_name&sysparm_limit=50',
    { headers: { 'X-UserToken': userToken! } }
  );
  const count = ((await reportees.json().catch(() => null))?.result ?? []).length;
  console.log(
    `[auth] ${count} direct reportee(s)` +
      (count === 0
        ? ' — TC-SP-006..009 will report the "Nobody reports to you" empty state, not a defect.'
        : '.')
  );
});
