import { Injectable } from '@nestjs/common';
import { Db, pool, q } from '../common/db';

export type Level = 'info' | 'success' | 'warning' | 'error';

/** Activity log + notification center. Every important operation calls log(); user-facing alerts call notify(). */
@Injectable()
export class ActivityService {
  async log(e: {
    orgId: string; action: string; message: string; level?: Level; userId?: string | null;
    entityType?: string; entityId?: string; meta?: any;
  }, db: Db = pool) {
    await q(
      `INSERT INTO activity_log(org_id,user_id,action,entity_type,entity_id,message,level,meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [e.orgId, e.userId ?? null, e.action, e.entityType ?? null, e.entityId ?? null, e.message, e.level ?? 'info', e.meta ?? {}],
      db,
    );
  }

  /** dedupeKey: while an unread notification with this key exists, no duplicate is created. */
  async notify(n: {
    orgId: string; type: string; title: string; body?: string; severity?: 'info' | 'warning' | 'error';
    refType?: string; refId?: string; dedupeKey?: string;
  }, db: Db = pool) {
    await q(
      `INSERT INTO notifications(org_id,type,severity,title,body,ref_type,ref_id,dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [n.orgId, n.type, n.severity ?? 'info', n.title, n.body ?? null, n.refType ?? null, n.refId ?? null, n.dedupeKey ?? null],
      db,
    );
  }
}
