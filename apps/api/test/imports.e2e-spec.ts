import ExcelJS from 'exceljs';
import request from 'supertest';
import { createApp } from '../src/app';
import type { InlineJobQueue } from '../src/common/jobs';
import type { FakeObjectStore } from '../src/common/object-store';
import { boot, closePrisma, resetData, signInHost, silentLogger, testDeps, testPrisma } from './helpers';

beforeEach(resetData);
afterAll(closePrisma);

const deps = testDeps();
const app = createApp(deps).app;
const jobs = deps.jobs as InlineJobQueue;
const store = deps.objectStore as FakeObjectStore;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

async function setup() {
  const owner = await signInHost(app, 'owner@example.com');
  const w = await request(app).post('/v1/weddings').set(owner.auth).send({ title: 'Ananya & Rohan', startsOn: '2027-02-12', endsOn: '2027-02-14' }).expect(201);
  return { owner, W: `/v1/weddings/${w.body.id}`, weddingId: w.body.id as string };
}

async function upload(owner: { auth: Record<string, string> }, W: string, body: Buffer, contentType: string) {
  const ticket = await request(app).post(`${W}/uploads`).set(owner.auth).send({ purpose: 'import', contentType, byteSize: body.length }).expect(201);
  store.simulateUpload(ticket.body.uploadUrl, body, contentType);
  await request(app).post(`/v1/uploads/${ticket.body.mediaId}/complete`).set(owner.auth).expect(200);
  await jobs.drain(silentLogger);
  return ticket.body.mediaId as string;
}

async function messyWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Guests');
  ws.addRow(['S.No', 'Naam', 'Mobile No.', 'Family', 'Ladke wale / Ladki wale', 'Kids']);
  ws.addRow([1, 'Ravi Sharma', '098450 12345', 'Sharma', 'Ladki wale', 1]);
  ws.addRow([2, 'Anita Sharma', '+91 98450 12346', 'Sharma', 'Ladki wale', '']);
  ws.addRow([3, 'Mausi', '12345', 'Iyer', 'Ladke wale', '']);
  ws.addRow([4, '', '98450 12347', 'Nobody', '', '']);
  ws.addRow([5, 'Ravi again', '9845012345', 'Rao', 'Ladke wale', '']);
  ws.addRow([6, 'Existing Uncle', '98450 99999', 'Kumar', 'Ladke wale', '']);
  ws.getCell('F2').value = { formula: '0+1', result: 1 } as ExcelJS.CellFormulaValue; // formulas: cached value only
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('uploads (CAM-01a)', () => {
  it('presigns by policy, rejects wrong type/size and roles, and verifies the object on complete', async () => {
    const { owner, W } = await setup();
    const bad = await request(app).post(`${W}/uploads`).set(owner.auth).send({ purpose: 'import', contentType: 'image/png', byteSize: 10 }).expect(415);
    expect(bad.body.error.code).toBe('MEDIA_TYPE_NOT_ALLOWED');
    const big = await request(app).post(`${W}/uploads`).set(owner.auth).send({ purpose: 'cover', contentType: 'image/jpeg', byteSize: 50_000_000 }).expect(413);
    expect(big.body.error.code).toBe('MEDIA_TOO_LARGE');

    const ticket = await request(app).post(`${W}/uploads`).set(owner.auth).send({ purpose: 'cover', contentType: 'image/jpeg', byteSize: 3 }).expect(201);
    const missing = await request(app).post(`/v1/uploads/${ticket.body.mediaId}/complete`).set(owner.auth).expect(409);
    expect(missing.body.error.code).toBe('MEDIA_OBJECT_MISSING');
    store.simulateUpload(ticket.body.uploadUrl, Buffer.from('abcd'), 'image/jpeg');
    // wrong size (4 bytes vs 3 declared) is refused by the presign limit in real S3; here the size check catches it
    const mismatch = await request(app).post(`/v1/uploads/${ticket.body.mediaId}/complete`).set(owner.auth);
    expect([409, 422]).toContain(mismatch.status);

    const desk = await signInHost(app, 'desk@example.com');
    await testPrisma().wedding_members.create({ data: { wedding_id: W.split('/').pop()!, user_id: desk.userId, role: 'desk_staff' } });
    await request(app).post(`${W}/uploads`).set(desk.auth).send({ purpose: 'import', contentType: 'text/csv', byteSize: 10 }).expect(403);
    const other = await signInHost(app, 'other@example.com');
    await request(app).post(`/v1/uploads/${ticket.body.mediaId}/complete`).set(other.auth).expect(404);
  });
});

describe('guest import (GST-02a, GST-05a)', () => {
  it('parses xlsx, suggests a Hinglish mapping, validates with duplicates, and commits into parties and groups', async () => {
    const { owner, W, weddingId } = await setup();
    await request(app).post(`${W}/parties`).set(owner.auth).send({ members: [{ fullName: 'Existing Uncle', phone: '9845099999' }] }).expect(201);

    const mediaId = await upload(owner, W, await messyWorkbook(), XLSX);
    const started = await request(app).post(`${W}/imports`).set(owner.auth).send({ mediaId }).expect(201);
    expect(started.body.status).toBe('parsing');
    await jobs.drain(silentLogger);

    const parsed = await request(app).get(`${W}/imports/${started.body.id}`).set(owner.auth).expect(200);
    expect(parsed.body).toMatchObject({ status: 'mapping', sheets: ['Guests'], stats: { total: 6 } });
    expect(parsed.body.suggestedMapping.columns).toMatchObject({ Naam: 'fullName', 'Mobile No.': 'phone', Family: 'partyLabel', 'Ladke wale / Ladki wale': 'side', Kids: 'children' });

    await request(app)
      .put(`${W}/imports/${started.body.id}/mapping`)
      .set(owner.auth)
      .send({ columns: { Naam: 'phone' }, partyMode: 'row_is_party' })
      .expect(400);
    await request(app)
      .put(`${W}/imports/${started.body.id}/mapping`)
      .set(owner.auth)
      .send({ ...parsed.body.suggestedMapping, columns: { ...parsed.body.suggestedMapping.columns } })
      .expect(200);
    await jobs.drain(silentLogger);

    const preview = await request(app).get(`${W}/imports/${started.body.id}`).set(owner.auth).expect(200);
    expect(preview.body.status).toBe('preview');
    expect(preview.body.stats).toMatchObject({ total: 6, ok: 2, warnings: 1, errors: 1, duplicates: 2 });
    const dups = await request(app).get(`${W}/imports/${started.body.id}/rows?status=duplicate`).set(owner.auth).expect(200);
    expect(dups.body.items.map((r: { fullName: string; matchKind: string }) => [r.fullName, r.matchKind])).toEqual([
      ['Ravi again', 'in_file'],
      ['Existing Uncle', 'phone'],
    ]);

    const csv = await request(app).get(`${W}/imports/${started.body.id}/errors.csv`).set(owner.auth).expect(200);
    expect(csv.text.split('\n')[0]).toBe('Row,Problem,S.No,Naam,Mobile No.,Family,Ladke wale / Ladki wale,Kids');
    expect(csv.text).toContain('NAME_MISSING');

    const key = { 'Idempotency-Key': 'commit-key-0001' };
    const commit = await request(app).post(`${W}/imports/${started.body.id}/commit`).set(owner.auth).set(key).expect(202);
    expect(commit.body.status).toBe('committing');
    await request(app).post(`${W}/imports/${started.body.id}/commit`).set(owner.auth).set(key).expect(202);
    await jobs.drain(silentLogger);

    const done = await request(app).get(`${W}/imports/${started.body.id}`).set(owner.auth).expect(200);
    expect(done.body).toMatchObject({ status: 'done', stats: { imported: 3, skipped: 3 } });

    const parties = await request(app).get(`${W}/parties?limit=50`).set(owner.auth).expect(200);
    const sharma = parties.body.items.find((p: { label: string }) => p.label === 'Sharma');
    expect(sharma.members.map((m: { fullName: string; phone: string | null }) => [m.fullName, m.phone])).toEqual([
      ['Ravi Sharma', '+919845012345'],
      ['Anita Sharma', '+919845012346'],
      ['Child 1', null],
    ]);
    const groups = await request(app).get(`${W}/groups`).set(owner.auth).expect(200);
    const bride = groups.body.items.find((g: { systemKey: string }) => g.systemKey === 'bride_side');
    expect(sharma.groupIds).toEqual([bride.id]);
    expect(parties.body.items).toHaveLength(3); // existing uncle + Sharma + Iyer (Mausi)
    expect(await testPrisma().audit_log.count({ where: { wedding_id: weddingId, action: 'guest.import' } })).toBe(1);
  });

  it('reads CSV with a BOM and blocks a second concurrent import', async () => {
    const { owner, W } = await setup();
    const csv = Buffer.from('﻿Name,Phone,Members\n"Kiran Rao","+1 415 555 2671","Asha, 2 kids"\n');
    const mediaId = await upload(owner, W, csv, 'text/csv');
    const started = await request(app).post(`${W}/imports`).set(owner.auth).send({ mediaId }).expect(201);
    const second = await request(app).post(`${W}/imports`).set(owner.auth).send({ mediaId }).expect(409);
    expect(second.body.error.code).toBe('GST_IMPORT_IN_PROGRESS');
    await jobs.drain(silentLogger);
    const parsed = await request(app).get(`${W}/imports/${started.body.id}`).set(owner.auth).expect(200);
    expect(parsed.body.suggestedMapping).toEqual({ columns: { Name: 'fullName', Phone: 'phone', Members: 'members' }, partyMode: 'row_is_party' });
    await request(app).put(`${W}/imports/${started.body.id}/mapping`).set(owner.auth).send(parsed.body.suggestedMapping).expect(200);
    await jobs.drain(silentLogger);
    await request(app).post(`${W}/imports/${started.body.id}/commit`).set(owner.auth).expect(202);
    await jobs.drain(silentLogger);
    const parties = await request(app).get(`${W}/parties`).set(owner.auth).expect(200);
    expect(parties.body.items[0].members.map((m: { fullName: string }) => m.fullName)).toEqual(['Kiran Rao', 'Asha', 'Child 1', 'Child 2']);
  });
});

describe('dev fake S3 sink', () => {
  it('accepts a real HTTP PUT to the presigned URL when the fake store has a public base', async () => {
    const { FakeObjectStore } = await import('../src/common/object-store');
    const store2 = new FakeObjectStore('fake-bucket', '');
    const d = testDeps({ objectStore: store2 });
    const app2 = createApp(d).app;
    const owner = await signInHost(app2, 'sink@example.com');
    const w = await request(app2).post('/v1/weddings').set(owner.auth).send({ title: 'Sink test', startsOn: '2027-01-01', endsOn: '2027-01-01' }).expect(201);
    const t = await request(app2).post(`/v1/weddings/${w.body.id}/uploads`).set(owner.auth).send({ purpose: 'import', contentType: 'text/csv', byteSize: 9 }).expect(201);
    expect(t.body.uploadUrl).toMatch(/^\/v1\/dev\/fake-s3\//);
    await request(app2).put(t.body.uploadUrl).set('Content-Type', 'text/csv').send(Buffer.from('Name\nAsha')).expect(200);
    await request(app2).post(`/v1/uploads/${t.body.mediaId}/complete`).set(owner.auth).expect(200);
    const media = await testPrisma().media_objects.findUniqueOrThrow({ where: { id: t.body.mediaId } });
    const getUrl = await store2.presignGet(media.s3_key, { bucket: media.s3_bucket });
    const got = await request(app2).get(getUrl).expect(200);
    expect(got.headers['content-type']).toContain('text/csv');
    await request(boot({ config: { NODE_ENV: 'production' } })).put(t.body.uploadUrl).send('x').expect(404); // never in production
  });
});
