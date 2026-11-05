import {
  BadRequestException, CanActivate, createParamDecorator, ExecutionContext, ForbiddenException,
  Injectable, PipeTransform, SetMetadata, UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as jwt from 'jsonwebtoken';
import { ZodSchema } from 'zod';
import { config } from './config';

export type Role = 'owner' | 'admin' | 'manager' | 'viewer';
export interface AuthUser { id: string; orgId: string; role: Role; email: string; name: string }

const RANK: Record<Role, number> = { viewer: 0, manager: 1, admin: 2, owner: 3 };

/** Zod-based validation pipe: `@Body(new Zod(schema)) body`. */
export class Zod implements PipeTransform {
  constructor(private schema: ZodSchema) {}
  transform(value: unknown) {
    const r = this.schema.safeParse(value);
    if (!r.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return r.data;
  }
}

export const PUBLIC = 'isPublic';
export const Public = () => SetMetadata(PUBLIC, true);
export const MIN_ROLE = 'minRole';
/** Minimum role required. Default for all authenticated routes: viewer (read). Writes declare manager+. */
export const MinRole = (role: Role) => SetMetadata(MIN_ROLE, role);

export function signToken(u: AuthUser): string {
  return jwt.sign({ sub: u.id, org: u.orgId, role: u.role, email: u.email, name: u.name }, config.jwtSecret, { expiresIn: '12h' });
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector) {}
  canActivate(ctx: ExecutionContext): boolean {
    const handlers = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, handlers)) return true;
    const req = ctx.switchToHttp().getRequest();
    const header: string = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new UnauthorizedException('Missing bearer token');
    try {
      const p = jwt.verify(token, config.jwtSecret) as any;
      req.user = { id: p.sub, orgId: p.org, role: p.role, email: p.email, name: p.name } as AuthUser;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    const min = this.reflector.getAllAndOverride<Role>(MIN_ROLE, handlers) ?? 'viewer';
    if (RANK[req.user.role as Role] < RANK[min]) throw new ForbiddenException(`Requires ${min} role`);
    return true;
  }
}

export const CurrentUser = createParamDecorator((_d, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user);

export function paginate(query: any) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(query.pageSize) || 25));
  return { page, pageSize, offset: (page - 1) * pageSize };
}
