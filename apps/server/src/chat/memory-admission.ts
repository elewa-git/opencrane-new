// Explain which unfinished or failed checks keep private memory disabled.
export const memoryAdmission = {
  state: 'disabled',
  failing: ['The private memory checks have not all passed.'],
} as const;
