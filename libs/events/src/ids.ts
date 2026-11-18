import { z } from 'zod';

export const recordIdPattern = /^[\w-]{1,200}$/u;
export const recordIdSchema = z.string().regex(recordIdPattern);
