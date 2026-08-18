import type { Request, Response } from 'express';
import { z } from 'zod';
import * as authService from './service.js';
import { AppError } from '../../lib/errors.js';

export const otpRequestSchema = z.object({
  phone: z.string().min(6),
  channel: z.enum(['sms', 'whatsapp']).default('sms'),
});

export const otpVerifySchema = z.object({
  challengeId: z.string().min(1),
  code: z.string().length(4),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(10),
});

export const staffLoginSchema = z.object({
  tenantSlug: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(1),
});

export const deliveryLoginSchema = z.object({
  tenantSlug: z.string().min(1),
  phone: z.string().min(6),
  password: z.string().min(1),
});

export const platformLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  totp: z.string().length(6),
});

function requireTenant(req: Request) {
  if (!req.ctx.tenantId) {
    throw new AppError('TENANT_MISMATCH', 'X-Tenant-Id header is required for this route.');
  }
  return req.ctx.tenantId;
}

export async function requestOtp(req: Request, res: Response): Promise<void> {
  const tenantId = requireTenant(req);
  const result = await authService.requestOtp(tenantId, req.body.phone, req.body.channel);
  res.status(201).json(result);
}

export async function verifyOtp(req: Request, res: Response): Promise<void> {
  const tenantId = requireTenant(req);
  const { user, accessToken, refreshToken } = await authService.verifyOtp(
    tenantId,
    req.body.challengeId,
    req.body.code,
    { userAgent: req.headers['user-agent'], ip: req.ip },
  );
  res.status(200).json({ accessToken, refreshToken, user: user.toJSON() });
}

export async function refresh(req: Request, res: Response): Promise<void> {
  const pair = await authService.refreshTokenPair(req.body.refreshToken, {
    userAgent: req.headers['user-agent'],
    ip: req.ip,
  });
  res.status(200).json(pair);
}

export async function logout(req: Request, res: Response): Promise<void> {
  await authService.revokeRefreshToken(req.body.refreshToken);
  res.status(204).send();
}

export async function staffLogin(req: Request, res: Response): Promise<void> {
  const { user, accessToken, refreshToken } = await authService.staffLogin(
    req.body.tenantSlug,
    req.body.email,
    req.body.password,
    { userAgent: req.headers['user-agent'], ip: req.ip },
  );
  res.status(200).json({ accessToken, refreshToken, user: user.toJSON() });
}

export async function deliveryLogin(req: Request, res: Response): Promise<void> {
  const { user, accessToken, refreshToken } = await authService.deliveryLogin(
    req.body.tenantSlug,
    req.body.phone,
    req.body.password,
    { userAgent: req.headers['user-agent'], ip: req.ip },
  );
  res.status(200).json({ accessToken, refreshToken, user: user.toJSON() });
}

export async function platformLogin(req: Request, res: Response): Promise<void> {
  const pair = await authService.platformLogin(req.body.email, req.body.password, req.body.totp, {
    userAgent: req.headers['user-agent'],
    ip: req.ip,
  });
  res.status(200).json(pair);
}
