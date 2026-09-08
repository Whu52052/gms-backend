'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createEdgeHandlers = require('../../src/handlers/edge');
const createMachinesHandlers = require('../../src/handlers/machines');

function setup() {
  const calls = [];
  const responses = [];
  const events = [];
  const pool = {
    execute: async (sql, params) => {
      calls.push({ sql, params });
      if (/SELECT snCode, handType FROM sn_registry/.test(sql)) return [[]];
      if (/SELECT status, data FROM edge_hosts/.test(sql)) return [[]];
      return [[]];
    },
  };
  const handlers = createEdgeHandlers({
    pool,
    sendJSON: (res, body, status = 200) => responses.push({ body, status }),
    broadcastSSE: (event, data) => events.push({ event, data }),
  });
  return { handlers, calls, responses, events };
}

test('edge collector: stores snapshots and emits machine-level alerts', async t => {
  const oldToken = process.env.EDGE_TOKEN;
  process.env.EDGE_TOKEN = 'test-edge-token';
  t.after(() => {
    if (oldToken === undefined) delete process.env.EDGE_TOKEN;
    else process.env.EDGE_TOKEN = oldToken;
  });

  const { handlers, calls, responses } = setup();
  await handlers.handleHeartbeat(
    { headers: { authorization: 'Bearer test-edge-token' } },
    {},
    {
      machineNumber: 'WE-001',
      devices: { gloves: { left: { connected: false }, right: { connected: false } } },
      importer: { reachable: false, error: 'timeout' },
      hermes: {
        reachable: true,
        health: { allConnected: false, degraded: ['camera/vst_left'] },
        state: { emergencyStopped: true, healthSummary: { recorder: 'warming' }, errorCount: 1, errors: ['bad frame'] },
      },
    },
  );

  assert.equal(responses[0].status, 200);
  const codes = responses[0].body.alerts.map(alert => alert.code);
  assert.deepEqual(codes, ['importer_unreachable', 'collector_degraded', 'emergency_stopped', 'recorder_not_ready', 'hermes_errors']);
  const insert = calls.find(call => /INSERT INTO edge_hosts/.test(call.sql));
  assert.ok(insert);
  const stored = JSON.parse(insert.params[5]);
  assert.equal(stored.importer.reachable, false);
  assert.equal(stored.hermes.state.emergencyStopped, true);
});

test('edge collector: old heartbeat payload remains valid without collector fields', async t => {
  const oldToken = process.env.EDGE_TOKEN;
  process.env.EDGE_TOKEN = 'test-edge-token';
  t.after(() => {
    if (oldToken === undefined) delete process.env.EDGE_TOKEN;
    else process.env.EDGE_TOKEN = oldToken;
  });

  const { handlers, responses } = setup();
  await handlers.handleHeartbeat(
    { headers: { authorization: 'Bearer test-edge-token' } },
    {},
    { machineNumber: 'we-001', devices: { gloves: {} } },
  );
  assert.equal(responses[0].status, 200);
  assert.deepEqual(responses[0].body.alerts, []);
});

test('edge collector: unreachable Hermes does not replay stale health errors', async t => {
  const oldToken = process.env.EDGE_TOKEN;
  process.env.EDGE_TOKEN = 'test-edge-token';
  t.after(() => {
    if (oldToken === undefined) delete process.env.EDGE_TOKEN;
    else process.env.EDGE_TOKEN = oldToken;
  });

  const { handlers, responses } = setup();
  await handlers.handleHeartbeat(
    { headers: { authorization: 'Bearer test-edge-token' } },
    {},
    {
      machineNumber: 'we-001',
      devices: { gloves: {} },
      hermes: {
        reachable: false,
        health: { allConnected: false, degraded: ['camera/overlay'] },
        state: { emergencyStopped: true, errorCount: 4, errors: ['old error'] },
      },
    },
  );
  assert.deepEqual(responses[0].body.alerts.map(alert => alert.code), ['hermes_unreachable']);
});

test('machines: desktop list merges dynamic edge presence outside lifecycle cache', async () => {
  const responses = [];
  const handlers = createMachinesHandlers({
    pool: { execute: async () => [[{
      data: JSON.stringify({ id: 'm-1', machineNumber: 'we-001', status: 'online', updatedAt: '2026-01-01T00:00:00Z' }),
    }]] },
    sendJSON: (res, body) => responses.push(body),
    _cached: async (key, fn) => fn(),
    loadEdgePresence: async () => ({
      'we-001': {
        hostOnline: true,
        importer: { reachable: true },
        hermes: { reachable: true },
      },
    }),
  });

  await handlers.handleGetMachines({}, {}, {});
  assert.equal(responses[0][0].hostOnline, true);
  assert.equal(responses[0][0].hermes.reachable, true);
});
