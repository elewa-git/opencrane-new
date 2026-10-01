// What POST /auth/logout answers with. The local session is already gone by
// then; endSessionUrl is the identity provider's own logout page, which the
// browser visits next so the provider's session ends too. It is null when
// there is no such page. Only http(s) addresses are accepted, so a bad value
// can never become a javascript: or data: address that the browser runs.
//
// This is z.url() limited to http(s), not z.httpUrl(): httpUrl also insists on
// a public domain name, so it refuses http://localhost:8080/... and an IP
// address, which is where a provider runs on a developer's machine or in a
// test. The sign-out would then silently skip the provider's logout page.
import { z } from 'zod';

export const logoutResponseSchema = z.object({
  endSessionUrl: z.url({ protocol: /^https?$/u }).nullable(),
});

export type LogoutResponse = z.infer<typeof logoutResponseSchema>;
