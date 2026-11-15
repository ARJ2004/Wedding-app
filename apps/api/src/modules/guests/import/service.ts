import type { Prisma, PrismaClient } from '@prisma/client';
import { ImportMapping, normaliseRow, rowStatus, suggestMapping, type NormalisedRow, type WeddingRole } from '@mehfil/domain';
import { z } from 'zod';
import { linkHashFor } from '../../../common/auth/link-token';
import { csvRow } from '../../../common/csv';
import { AppError } from '../../../common/errors';
import { defineJob, type JobQueue } from '../../../common/jobs';
import type { MediaService } from '../../media';
import { writeAudit } from '../../audit';
import { readSheet } from './read-sheet';

interface Deps {
  prisma: PrismaClient;
  jobs: JobQueue;
  media: MediaService;
  linkTokenKey: string;
}

const PREVIEW_ROWS = 20;
const BATCH = 200;

type Stats = { total: number; ok: number; warnings: number; errors: number; duplicates: number; imported?: number; merged?: number; skipped?: number };

/**
 * GST-02a import pipeline (04-gst §5): upload → parse (headers + suggested mapping) → mapping →
 * validate (normalise, group into parties, in-file + existing-phone duplicates) → preview →
 * commit (resumable, batches of 200) → done. One import in flight per wedding.
 */
export class ImportService {
  readonly jobs;

  constructor(private readonly deps: Deps) {
    this.jobs = {
      parse: defineJob({ name: 'gst.import.parse', lane: 'default', schema: z.object({ importId: z.string().uuid() }), handler: ({ importId }) => this.parse(importId) }),
      validate: defineJob({ name: 'gst.import.validate', lane: 'default', schema: z.object({ importId: z.string().uuid() }), handler: ({ importId }) => this.validate(importId) }),
      commit: defineJob({ name: 'gst.import.commit', lane: 'default', schema: z.object({ importId: z.string().uuid() }), handler: ({ importId }) => this.commit(importId) }),
    };
  }

  private get prisma() {
    return this.deps.prisma;
  }

  private async load(weddingId: string, importId: string) {
    const job = await this.prisma.import_jobs.findFirst({ where: { id: importId, wedding_id: weddingId } });
    if (!job) throw new AppError('GST_IMPORT_NOT_FOUND', 'Import not found', 404);
    return job;
  }

  async start(actor: { userId: string; role: WeddingRole; requestId?: string }, weddingId: string, mediaId: string) {
    const media = await this.deps.media.requireUploaded(mediaId, weddingId, 'other');
    const source = media.content_type.includes('spreadsheetml') ? 'xlsx' : 'csv';
    const active = await this.prisma.import_jobs.count({ where: { wedding_id: weddingId, status: { in: ['parsing', 'validating', 'committing'] } } });
    if (active) throw new AppError('GST_IMPORT_IN_PROGRESS', 'Another import is running for this wedding', 409);
    const job = await this.prisma.import_jobs.create({
      data: { wedding_id: weddingId, source, file_media_id: mediaId, status: 'parsing', created_by: actor.userId },
    });
    await this.deps.jobs.send(this.jobs.parse, { importId: job.id }, { singletonKey: job.id });
    return this.view(weddingId, job.id);
  }

  private async sheetFor(job: { file_media_id: string | null; sheet_name: string | null }, headerRow = 1) {
    if (!job.file_media_id) throw new AppError('GST_IMPORT_FILE_MISSING', 'The uploaded file is gone; upload it again', 410);
    const media = await this.prisma.media_objects.findUniqueOrThrow({ where: { id: job.file_media_id } });
    const body = await this.deps.media.read(media.id);
    return readSheet(body, media.content_type, { sheetName: job.sheet_name ?? undefined, headerRow });
  }

  private async fail(importId: string, err: unknown) {
    const code = err instanceof AppError ? err.code : 'GST_IMPORT_FAILED';
    await this.prisma.import_jobs.update({ where: { id: importId }, data: { status: 'failed', error_code: code, updated_at: new Date() } });
  }

  async parse(importId: string) {
    const job = await this.prisma.import_jobs.findUniqueOrThrow({ where: { id: importId } });
    if (job.status !== 'parsing') return;
    try {
      const sheet = await this.sheetFor(job);
      await this.prisma.import_jobs.update({
        where: { id: importId },
        data: {
          status: 'mapping',
          headers: sheet.headers,
          sheet_name: sheet.sheetName,
          stats: { total: sheet.rows.length, sheets: sheet.sheets, sample: sheet.rows.slice(0, PREVIEW_ROWS), suggested: suggestMapping(sheet.headers) } as Prisma.InputJsonValue,
          updated_at: new Date(),
        },
      });
    } catch (err) {
      await this.fail(importId, err);
    }
  }

  async setMapping(weddingId: string, importId: string, mapping: ImportMapping) {
    const job = await this.load(weddingId, importId);
    if (!['mapping', 'preview', 'failed'].includes(job.status)) throw new AppError('GST_IMPORT_NOT_MAPPING', 'This import is not waiting for a mapping', 409);
    const fields = Object.values(mapping.columns);
    if (!fields.includes('fullName') && !fields.includes('firstName')) {
      throw new AppError('GST_IMPORT_MAPPING_INVALID', 'Pick the column that has guest names', 400);
    }
    const headers = (job.headers as string[] | null) ?? [];
    const unknown = Object.keys(mapping.columns).filter((h) => !headers.includes(h));
    if (unknown.length) throw new AppError('GST_IMPORT_MAPPING_INVALID', `Unknown columns: ${unknown.join(', ')}`, 400);
    await this.prisma.import_jobs.update({
      where: { id: importId },
      data: { status: 'validating', mapping: mapping as Prisma.InputJsonValue, sheet_name: mapping.sheetName ?? job.sheet_name, error_code: null, updated_at: new Date() },
    });
    await this.deps.jobs.send(this.jobs.validate, { importId }, { singletonKey: `${importId}:validate` });
    return this.view(weddingId, importId);
  }

  async validate(importId: string) {
    const job = await this.prisma.import_jobs.findUniqueOrThrow({ where: { id: importId } });
    if (job.status !== 'validating') return;
    try {
      const mapping = ImportMapping.parse(job.mapping);
      const sheet = await this.sheetFor(job, mapping.headerRow);
      const existing = await this.prisma.guests.findMany({
        where: { wedding_id: job.wedding_id, deleted_at: null, phone_e164: { not: null } },
        select: { id: true, phone_e164: true },
      });
      const byPhone = new Map(existing.map((g) => [g.phone_e164!, g.id]));
      const seen = new Map<string, number>();
      const stats: Stats = { total: sheet.rows.length, ok: 0, warnings: 0, errors: 0, duplicates: 0 };
      const data = sheet.rows.map((raw, i) => {
        const rowNumber = mapping.headerRow + i + 1;
        const n = normaliseRow(raw, mapping, rowNumber);
        const phone = n.primary.phoneE164;
        let match: { id: string | null; kind: 'phone' | 'in_file' } | null = null;
        if (phone && byPhone.has(phone)) match = { id: byPhone.get(phone)!, kind: 'phone' };
        else if (phone && seen.has(phone)) {
          match = { id: null, kind: 'in_file' };
          n.issues.push({ field: 'phone', code: 'DUPLICATE_IN_FILE' });
        }
        if (phone && !seen.has(phone)) seen.set(phone, rowNumber);
        const status = rowStatus(n, match !== null);
        stats[status === 'ok' ? 'ok' : status === 'warning' ? 'warnings' : status === 'error' ? 'errors' : 'duplicates'] += 1;
        return {
          import_job_id: importId,
          wedding_id: job.wedding_id,
          row_number: rowNumber,
          party_key: n.partyKey,
          raw,
          normalized: n as unknown as Prisma.InputJsonValue,
          status,
          issues: n.issues as unknown as Prisma.InputJsonValue,
          match_guest_id: match?.id ?? null,
          match_kind: match?.kind ?? null,
          action: status === 'error' || status === 'duplicate' ? 'skip' : 'create',
        };
      });
      await this.prisma.$transaction(async (tx) => {
        await tx.import_rows.deleteMany({ where: { import_job_id: importId } });
        for (let i = 0; i < data.length; i += 500) await tx.import_rows.createMany({ data: data.slice(i, i + 500) });
        await tx.import_jobs.update({ where: { id: importId }, data: { status: 'preview', stats: stats as Prisma.InputJsonValue, updated_at: new Date() } });
      });
    } catch (err) {
      await this.fail(importId, err);
    }
  }

  async rows(weddingId: string, importId: string, status: string | undefined, cursor: number | undefined, limit: number) {
    await this.load(weddingId, importId);
    const rows = await this.prisma.import_rows.findMany({
      where: { import_job_id: importId, ...(status ? { status } : {}), ...(cursor ? { row_number: { gt: cursor } } : {}) },
      orderBy: { row_number: 'asc' },
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => {
        const n = r.normalized as unknown as NormalisedRow;
        return {
          rowNumber: r.row_number,
          status: r.status,
          action: r.action,
          partyKey: r.party_key,
          fullName: n.issues.some((i) => i.code === 'NAME_MISSING') ? '' : n.primary.fullName,
          phone: n.primary.phoneE164,
          members: n.extraMembers.length + 1,
          issues: (r.issues as { field: string; code: string }[]).map((i) => i.code),
          matchKind: r.match_kind,
        };
      }),
      nextCursor: rows.length > limit ? page[page.length - 1]!.row_number : null,
    };
  }

  async setActions(weddingId: string, importId: string, input: { rowNumbers?: number[]; status?: 'duplicate' | 'warning'; action: 'create' | 'merge' | 'skip' }) {
    const job = await this.load(weddingId, importId);
    if (job.status !== 'preview') throw new AppError('GST_IMPORT_NOT_PREVIEW', 'Changes are only possible in preview', 409);
    const where: Prisma.import_rowsWhereInput = { import_job_id: importId, status: { not: 'error' } };
    if (input.rowNumbers) where.row_number = { in: input.rowNumbers };
    if (input.status) where.status = input.status;
    if (input.action === 'merge') where.match_guest_id = { not: null };
    const res = await this.prisma.import_rows.updateMany({ where, data: { action: input.action } });
    return { updated: res.count };
  }

  async requestCommit(weddingId: string, importId: string) {
    const job = await this.load(weddingId, importId);
    if (job.status !== 'preview') throw new AppError('GST_IMPORT_NOT_PREVIEW', 'Only a previewed import can be committed', 409);
    await this.prisma.import_jobs.update({ where: { id: importId }, data: { status: 'committing', updated_at: new Date() } });
    await this.deps.jobs.send(this.jobs.commit, { importId }, { singletonKey: `${importId}:commit` });
    return this.view(weddingId, importId);
  }

  async commit(importId: string) {
    const job = await this.prisma.import_jobs.findUniqueOrThrow({ where: { id: importId } });
    if (job.status !== 'committing') return;
    const mapping = ImportMapping.parse(job.mapping);
    const groupIds = new Map(
      (await this.prisma.guest_groups.findMany({ where: { wedding_id: job.wedding_id } })).flatMap((g) => [
        [g.name.toLowerCase(), g.id] as const,
        ...(g.system_key ? [[g.system_key, g.id] as const] : []),
      ]),
    );
    const groupId = async (tx: Prisma.TransactionClient, name: string) => {
      const key = name.toLowerCase();
      if (groupIds.has(key)) return groupIds.get(key)!;
      if (!mapping.createMissingGroups) return null;
      const g = await tx.guest_groups.create({ data: { wedding_id: job.wedding_id, name } });
      groupIds.set(key, g.id);
      return g.id;
    };

    // Resumable: each batch applies whole parties whose rows are not yet applied.
    for (;;) {
      const pending = await this.prisma.import_rows.findMany({
        where: { import_job_id: importId, result: null },
        orderBy: { row_number: 'asc' },
        take: BATCH,
      });
      if (pending.length === 0) break;
      const lastKey = pending[pending.length - 1]!.party_key;
      const more = pending.length === BATCH ? await this.prisma.import_rows.findMany({ where: { import_job_id: importId, result: null, party_key: lastKey, row_number: { gt: pending[pending.length - 1]!.row_number } } }) : [];
      const rows = [...pending, ...more];
      await this.prisma.$transaction(async (tx) => {
        const byParty = new Map<string, typeof rows>();
        for (const r of rows) byParty.set(r.party_key ?? `row-${r.row_number}`, [...(byParty.get(r.party_key ?? `row-${r.row_number}`) ?? []), r]);
        for (const partyRows of byParty.values()) {
          const create = partyRows.filter((r) => r.action === 'create');
          for (const r of partyRows.filter((x) => x.action === 'skip')) await tx.import_rows.update({ where: { id: r.id }, data: { result: 'skipped' } });
          for (const r of partyRows.filter((x) => x.action === 'merge' && x.match_guest_id)) {
            const n = r.normalized as unknown as NormalisedRow;
            const g = await tx.guests.findUniqueOrThrow({ where: { id: r.match_guest_id! } });
            await tx.guests.update({ where: { id: g.id }, data: { email: g.email ?? n.primary.email, relation: g.relation ?? n.primary.relation } });
            await tx.import_rows.update({ where: { id: r.id }, data: { result: 'merged', result_guest_id: g.id } });
          }
          if (create.length === 0) continue;
          const first = create[0]!.normalized as unknown as NormalisedRow;
          const party = await tx.parties.create({
            data: {
              wedding_id: job.wedding_id,
              label: first.partyLabel ?? (create.length > 1 || first.extraMembers.length ? `${first.primary.fullName} & family` : first.primary.fullName),
              plus_ones_allowed: first.plusOnes,
              is_outstation: first.isOutstation ?? false,
              preferred_language: first.language ?? 'en',
              city: first.city,
              notes: first.notes,
              source: 'import_file',
              import_job_id: importId,
              updated_by: job.created_by,
            },
          });
          await tx.parties.update({ where: { id: party.id }, data: { link_token_hash: linkHashFor(this.deps.linkTokenKey, party.id) } });
          const groups = new Set<string>();
          for (const [i, r] of create.entries()) {
            const n = r.normalized as unknown as NormalisedRow;
            const members = [n.primary, ...n.extraMembers];
            let resultGuest: string | null = null;
            for (const [j, m] of members.entries()) {
              const g = await tx.guests.create({
                data: {
                  wedding_id: job.wedding_id,
                  party_id: party.id,
                  is_primary: i === 0 && j === 0,
                  full_name: m.fullName,
                  phone_e164: m.phoneE164,
                  phone_status: m.phoneStatus,
                  phone_raw: m.phoneStatus === 'valid' ? null : m.phoneRaw,
                  email: m.email,
                  relation: m.relation,
                  age_band: m.ageBand,
                  updated_by: job.created_by,
                },
              });
              if (j === 0) resultGuest = g.id;
            }
            for (const name of n.groups) {
              const id = await groupId(tx, name);
              if (id) groups.add(id);
            }
            if (n.side) groups.add(groupIds.get(n.side)!);
            await tx.import_rows.update({ where: { id: r.id }, data: { result: 'imported', result_guest_id: resultGuest } });
          }
          if (groups.size) await tx.party_groups.createMany({ data: [...groups].filter(Boolean).map((group_id) => ({ party_id: party.id, group_id })) });
        }
      });
    }

    const counts = await this.prisma.import_rows.groupBy({ by: ['result'], where: { import_job_id: importId }, _count: true });
    const n = (k: string) => counts.find((c) => c.result === k)?._count ?? 0;
    const stats = { ...(job.stats as Stats), imported: n('imported'), merged: n('merged'), skipped: n('skipped') };
    await this.prisma.$transaction(async (tx) => {
      await tx.import_jobs.update({ where: { id: importId }, data: { status: 'done', stats, committed_at: new Date(), updated_at: new Date() } });
      await writeAudit(tx, {
        weddingId: job.wedding_id,
        actor: { type: 'user', id: job.created_by },
        action: 'guest.import',
        entityType: 'import_job',
        entityId: importId,
        after: { imported: stats.imported, merged: stats.merged, skipped: stats.skipped },
      });
    });
  }

  async cancel(weddingId: string, importId: string) {
    const job = await this.load(weddingId, importId);
    if (['committing', 'done'].includes(job.status)) throw new AppError('GST_IMPORT_NOT_CANCELLABLE', 'This import can no longer be cancelled', 409);
    await this.prisma.import_jobs.update({ where: { id: importId }, data: { status: 'cancelled', updated_at: new Date() } });
    return this.view(weddingId, importId);
  }

  async errorsCsv(weddingId: string, importId: string) {
    const job = await this.load(weddingId, importId);
    const headers = (job.headers as string[] | null) ?? [];
    const rows = await this.prisma.import_rows.findMany({
      where: { import_job_id: importId, status: { in: ['error', 'warning', 'duplicate'] } },
      orderBy: { row_number: 'asc' },
    });
    const lines = [csvRow(['Row', 'Problem', ...headers])];
    for (const r of rows) {
      const problem = (r.issues as { code: string }[]).map((i) => i.code).join(' ') || r.status.toUpperCase();
      const raw = r.raw as Record<string, string>;
      lines.push(csvRow([r.row_number, problem, ...headers.map((h) => raw[h])]));
    }
    return `${lines.join('\n')}\n`;
  }

  async view(weddingId: string, importId: string) {
    const job = await this.load(weddingId, importId);
    const stats = job.stats as Record<string, unknown>;
    return {
      id: job.id,
      status: job.status as 'uploaded' | 'parsing' | 'mapping' | 'validating' | 'preview' | 'committing' | 'done' | 'failed' | 'cancelled',
      source: job.source,
      headers: (job.headers as string[] | null) ?? [],
      sheets: (stats.sheets as string[] | undefined) ?? [],
      sheetName: job.sheet_name,
      sample: (stats.sample as Record<string, string>[] | undefined) ?? [],
      suggestedMapping: (stats.suggested as Record<string, unknown> | undefined) ?? null,
      mapping: (job.mapping as Record<string, unknown> | null) ?? null,
      stats: {
        total: Number(stats.total ?? 0),
        ok: Number(stats.ok ?? 0),
        warnings: Number(stats.warnings ?? 0),
        errors: Number(stats.errors ?? 0),
        duplicates: Number(stats.duplicates ?? 0),
        imported: Number(stats.imported ?? 0),
        merged: Number(stats.merged ?? 0),
        skipped: Number(stats.skipped ?? 0),
      },
      errorCode: job.error_code,
    };
  }
}
