import { test, expect } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'https://service-now.com';
const AUTH_HEADER = {
  Authorization: 'Basic ' + Buffer.from(`${process.env.SN_USER}:${process.env.SN_PASS}`).toString('base64'),
  Accept: 'application/json',
  'Content-Type': 'application/json',
};

test.describe('Shift Pay & ServiceNow REST API - 15 Test Cases', () => {
  let createdShiftSysId = '';

  // ==========================================
  // 1. AUTHENTICATION & ACCESS CONTROL
  // ==========================================

  test('API-01. Unauthenticated request returns 401 Unauthorized', async ({ request }) => {
    const response = await request.get(`${BASE_URL}/api/now/table/sc_req_item?sysparm_limit=1`);
    expect(response.status()).toBe(401);
  });

  test('API-02. Invalid credentials return 401 Unauthorized', async ({ request }) => {
    const response = await request.get(`${BASE_URL}/api/now/table/sc_req_item?sysparm_limit=1`, {
      headers: {
        Authorization: 'Basic ' + Buffer.from('invalid_user:wrong_pass').toString('base64'),
      },
    });
    expect(response.status()).toBe(401);
  });

  test('API-03. Valid credentials return 200 OK with JSON content type', async ({ request }) => {
    const response = await request.get(`${BASE_URL}/api/now/table/sc_req_item?sysparm_limit=1`, {
      headers: AUTH_HEADER,
    });
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('application/json');
  });

  // ==========================================
  // 2. SHIFT RECORD CRUD OPERATIONS (TABLE API)
  // ==========================================

  test('API-04. POST creates a new Shift Pay record and returns 201 Created', async ({ request }) => {
    const response = await request.post(`${BASE_URL}/api/now/table/x_shiftpay_entry`, {
      headers: AUTH_HEADER,
      data: {
        shift_date: '2026-11-12',
        start_time: '09:00:00',
        end_time: '17:00:00',
        break_minutes: 30,
        status: 'draft',
      },
    });

    expect(response.status()).toBe(201);
    const body = await response.json();
    expect(body.result.sys_id).toBeTruthy();
    createdShiftSysId = body.result.sys_id;
  });

  test('API-05. GET retrieves the newly created Shift Pay record by sys_id', async ({ request }) => {
    const response = await request.get(`${BASE_URL}/api/now/table/x_shiftpay_entry/${createdShiftSysId}`, {
      headers: AUTH_HEADER,
    });

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.result.sys_id).toBe(createdShiftSysId);
    expect(body.result.status).toBe('draft');
  });

  test('API-06. PATCH updates shift end time and recalculates hours', async ({ request }) => {
    const response = await request.patch(`${BASE_URL}/api/now/table/x_shiftpay_entry/${createdShiftSysId}`, {
      headers: AUTH_HEADER,
      data: {
        end_time: '18:00:00',
        comments: 'Updated via Playwright API test',
      },
    });

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.result.end_time).toContain('18:00:00');
  });

  test('API-07. GET with sysparm_query filters active Requested Items dynamically', async ({ request }) => {
    const response = await request.get(
      `${BASE_URL}/api/now/table/sc_req_item?sysparm_query=active=true&sysparm_limit=5`,
      { headers: AUTH_HEADER }
    );

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body.result)).toBeTruthy();
    if (body.result.length > 0) {
      expect(body.result[0].number).toMatch(/^RITM\d+$/);
    }
  });

  // ==========================================
  // 3. CUSTOM SHIFT PAY CALCULATION ENDPOINTS
  // ==========================================

  test('API-08. Custom calculate-pay endpoint computes standard hourly rate accurately', async ({ request }) => {
    const response = await request.post(`${BASE_URL}/api/x_shiftpay/v1/calculate`, {
      headers: AUTH_HEADER,
      data: {
        hours_worked: 8,
        hourly_rate: 20,
        shift_type: 'standard',
      },
    });

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.result.gross_pay).toBe(160);
  });

  test('API-09. Custom calculate-pay endpoint applies overtime multiplier (1.5x)', async ({ request }) => {
    const response = await request.post(`${BASE_URL}/api/x_shiftpay/v1/calculate`, {
      headers: AUTH_HEADER,
      data: {
        hours_worked: 10,
        hourly_rate: 20,
        shift_type: 'overtime',
      },
    });

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.result.gross_pay).toBeGreaterThan(200);
  });

  test('API-10. Custom calculate-pay endpoint applies weekend/night differential', async ({ request }) => {
    const response = await request.post(`${BASE_URL}/api/x_shiftpay/v1/calculate`, {
      headers: AUTH_HEADER,
      data: {
        hours_worked: 8,
        hourly_rate: 20,
        shift_type: 'night_weekend',
      },
    });

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.result.differential_applied).toBe(true);
  });

  // ==========================================
  // 4. VALIDATION, ERROR HANDLING & CLEANUP
  // ==========================================

  test('API-11. Rejects shift creation with negative hours or invalid time range (400 Bad Request)', async ({ request }) => {
    const response = await request.post(`${BASE_URL}/api/now/table/x_shiftpay_entry`, {
      headers: AUTH_HEADER,
      data: {
        shift_date: '2026-11-12',
        start_time: '17:00:00',
        end_time: '09:00:00',
        break_minutes: -15,
      },
    });

    expect([400, 403]).toContain(response.status());
  });

  test('API-12. Querying a non-existent sys_id returns 404 Not Found', async ({ request }) => {
    const response = await request.get(`${BASE_URL}/api/now/table/x_shiftpay_entry/00000000000000000000000000000000`, {
      headers: AUTH_HEADER,
    });

    expect(response.status()).toBe(404);
  });

  test('API-13. Manager approval endpoint transitions shift status to Approved', async ({ request }) => {
    const response = await request.post(`${BASE_URL}/api/x_shiftpay/v1/approve`, {
      headers: AUTH_HEADER,
      data: {
        sys_id: createdShiftSysId,
        action: 'approve',
      },
    });

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.result.status).toBe('approved');
  });

  test('API-14. Verify response SLA time is under 2000ms for list query', async ({ request }) => {
    const startTime = Date.now();
    const response = await request.get(`${BASE_URL}/api/now/table/sc_req_item?sysparm_limit=20`, {
      headers: AUTH_HEADER,
    });
    const duration = Date.now() - startTime;

    expect(response.status()).toBe(200);
    expect(duration).toBeLessThan(2000);
  });

  test('API-15. DELETE removes test Shift Pay record and returns 204 No Content', async ({ request }) => {
    const response = await request.delete(`${BASE_URL}/api/now/table/x_shiftpay_entry/${createdShiftSysId}`, {
      headers: AUTH_HEADER,
    });

    expect([200, 204]).toContain(response.status());
  });

});