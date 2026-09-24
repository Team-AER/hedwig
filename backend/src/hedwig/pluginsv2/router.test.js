import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { createPluginRouter, dispatch } from './router.js';
import { PermissionError } from './errors.js';

let server;
let base;
let seen;

beforeAll(async () => {
  const pr = createPluginRouter();
  pr.get('/echo/:name', (req) => { seen = req; return { hi: req.params.name, q: req.query.x }; });
  pr.get('/html', (req, res) => { res.type('text/html').send('<script>alert(1)</script>'); });
  pr.get('/csv', (req, res) => { res.attachment('a b"c.csv', 'x,y\r\n', 'text/csv'); });
  pr.get('/denied', () => { throw new PermissionError('acme.x', 'mail.read'); });
  pr.post('/mutate', (req) => { try { req.body.x = 2; } catch { return { frozen: true }; } return { frozen: false }; });
  pr.get('/header', (req, res) => { res.header('Set-Cookie', 'sid=evil'); return {}; });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { userId: 'u1', isAdmin: true }; next(); });
  app.use('/p', async (req, res) => {
    const handled = await dispatch(pr, req, res, { userId: req.session.userId, pluginId: 'acme.x' });
    if (!handled) res.status(404).json({ error: 'nf' });
  });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}/p`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

describe('plugin router', () => {
  it('hands the plugin a frozen plain request without the session', async () => {
    const res = await fetch(`${base}/echo/n%20a?x=1`);
    expect(await res.json()).toEqual({ hi: 'n a', q: '1' });
    expect(seen.userId).toBe('u1');
    expect(seen.session).toBeUndefined();
    expect(Object.isFrozen(seen)).toBe(true);
    expect(res.headers.get('content-security-policy')).toMatch(/default-src 'none'/);
    const m = await fetch(`${base}/mutate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"x":1}' });
    expect(await m.json()).toEqual({ frozen: true });
  });

  it('refuses active content types and unsafe headers', async () => {
    expect((await fetch(`${base}/html`)).status).toBe(500);
    const h = await fetch(`${base}/header`);
    expect(h.status).toBe(400);
    expect(h.headers.get('set-cookie')).toBeNull();
  });

  it('sends downloads with a sanitised filename', async () => {
    const res = await fetch(`${base}/csv`);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="a b_c.csv"');
    expect(res.headers.get('content-type')).toMatch(/^text\/csv/);
  });

  it('maps PermissionError to 403 and unknown routes to 404', async () => {
    expect((await fetch(`${base}/denied`)).status).toBe(403);
    expect((await fetch(`${base}/nothing`)).status).toBe(404);
  });
});
