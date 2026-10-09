export function movePanelTab(event: KeyboardEvent): void {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  const tabList = event.currentTarget;
  const target = event.target;
  if (!(tabList instanceof HTMLElement) || !(target instanceof HTMLButtonElement)) return;
  const tabs = Array.from(tabList.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const currentIndex = tabs.indexOf(target);
  if (currentIndex < 0 || tabs.length === 0) return;
  event.preventDefault();
  const direction = event.key === 'ArrowRight' ? 1 : -1;
  const nextIndex = (currentIndex + direction + tabs.length) % tabs.length;
  const nextTab = tabs[nextIndex];
  if (!nextTab) return;
  nextTab.focus();
  nextTab.click();
}
