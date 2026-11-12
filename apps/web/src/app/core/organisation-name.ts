export function organisationName(): string {
  const meta = document.querySelector<HTMLMetaElement>('meta[name=opencrane-org]');
  return meta?.content.trim() ?? '';
}
