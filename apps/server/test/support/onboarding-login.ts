import { expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AuthConfig } from '@opencrane/auth';

export async function loginWithReturnPath(app: FastifyInstance, auth: AuthConfig, returnTo: string) {
  const loginQuery = new URLSearchParams({ returnTo });
  const login = await app.inject({ url: `/auth/login?${loginQuery}` });
  expect(login.statusCode).toBe(302);
  type LoginCookie = typeof login.cookies[number];
  function isFlow(cookie: LoginCookie) {
    return cookie.name === auth.flowCookieName;
  }
  const flow = login.cookies.find(isFlow);
  const authorisation = await fetch(String(login.headers.location), { redirect: 'manual' });
  const callback = new URL(authorisation.headers.get('location')!);
  const response = await app.inject({ url: callback.pathname + callback.search,
    cookies: { [auth.flowCookieName]: flow!.value } });
  expect(response.statusCode).toBe(302);
  return response.headers.location;
}
