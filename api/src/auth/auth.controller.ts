import { Body, Controller, Get, Post, UnauthorizedException, ConflictException, ForbiddenException } from '@nestjs/common';
import { config } from '../common/config';
import * as bcrypt from 'bcryptjs';
import { z } from 'zod';
import { AuthUser, CurrentUser, MinRole, Public, signToken, Zod } from '../common/http';
import { one, q, tx } from '../common/db';

const RegisterSchema = z.object({
  organization: z.string().min(2).max(120),
  name: z.string().min(1).max(120),
  email: z.string().email().toLowerCase(),
  password: z.string().min(10, 'Password must be at least 10 characters'),
});
const LoginSchema = z.object({ email: z.string().email().toLowerCase(), password: z.string().min(1) });
const InviteSchema = z.object({
  name: z.string().min(1), email: z.string().email().toLowerCase(), password: z.string().min(10),
  role: z.enum(['admin', 'manager', 'viewer']),
});

const toAuth = (u: any): AuthUser => ({ id: u.id, orgId: u.org_id, role: u.role, email: u.email, name: u.name });

@Controller('auth')
export class AuthController {
  @Public()
  @Post('register')
  async register(@Body(new Zod(RegisterSchema)) b: z.infer<typeof RegisterSchema>) {
    if (!config.allowSignup && (await one('SELECT 1 FROM users LIMIT 1'))) {
      throw new ForbiddenException('Sign-up is closed on this installation. Ask the owner to add you under Settings → Team.');
    }
    if (await one('SELECT 1 FROM users WHERE email=$1', [b.email])) throw new ConflictException('Email already registered');
    const user = await tx(async (c) => {
      const org = await one('INSERT INTO organizations(name) VALUES ($1) RETURNING id', [b.organization], c);
      await q(`INSERT INTO warehouses(org_id,name,is_default) VALUES ($1,'Main warehouse',true)`, [org!.id], c);
      return one(
        `INSERT INTO users(org_id,email,name,password_hash,role) VALUES ($1,$2,$3,$4,'owner') RETURNING *`,
        [org!.id, b.email, b.name, await bcrypt.hash(b.password, 12)], c,
      );
    });
    return { token: signToken(toAuth(user)), user: toAuth(user) };
  }

  @Public()
  @Post('login')
  async login(@Body(new Zod(LoginSchema)) b: z.infer<typeof LoginSchema>) {
    const u = await one('SELECT * FROM users WHERE email=$1', [b.email]);
    // Same error + always run bcrypt to avoid user-enumeration timing differences.
    const ok = await bcrypt.compare(b.password, u?.password_hash ?? '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
    if (!u || !ok) throw new UnauthorizedException('Invalid email or password');
    return { token: signToken(toAuth(u)), user: toAuth(u) };
  }

  @Get('me')
  async me(@CurrentUser() u: AuthUser) {
    const org = await one('SELECT id,name,currency,settings FROM organizations WHERE id=$1', [u.orgId]);
    return { user: u, organization: org };
  }

  @Get('users')
  @MinRole('admin')
  users(@CurrentUser() u: AuthUser) {
    return q('SELECT id,email,name,role,created_at FROM users WHERE org_id=$1 ORDER BY created_at', [u.orgId]);
  }

  @Post('users')
  @MinRole('admin')
  async invite(@CurrentUser() u: AuthUser, @Body(new Zod(InviteSchema)) b: z.infer<typeof InviteSchema>) {
    if (await one('SELECT 1 FROM users WHERE email=$1', [b.email])) throw new ConflictException('Email already registered');
    return one(
      `INSERT INTO users(org_id,email,name,password_hash,role) VALUES ($1,$2,$3,$4,$5) RETURNING id,email,name,role`,
      [u.orgId, b.email, b.name, await bcrypt.hash(b.password, 12), b.role],
    );
  }
}
