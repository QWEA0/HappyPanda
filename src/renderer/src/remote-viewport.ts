export function observeRemoteViewport(element: HTMLElement) {
  const viewport = window.visualViewport;
  let frame = 0;
  const update = () => {
    frame = 0;
    element.style.setProperty('--remote-viewport-height', `${viewport?.height || window.innerHeight}px`);
    element.style.setProperty('--remote-viewport-width', `${viewport?.width || window.innerWidth}px`);
    element.style.setProperty('--remote-viewport-top', `${viewport?.offsetTop || 0}px`);
    element.style.setProperty('--remote-viewport-left', `${viewport?.offsetLeft || 0}px`);
  };
  const schedule = () => {
    if (!frame) frame = window.requestAnimationFrame(update);
  };
  update();
  viewport?.addEventListener('resize', schedule);
  viewport?.addEventListener('scroll', schedule);
  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);
  return () => {
    window.cancelAnimationFrame(frame);
    viewport?.removeEventListener('resize', schedule);
    viewport?.removeEventListener('scroll', schedule);
    window.removeEventListener('resize', schedule);
    window.removeEventListener('orientationchange', schedule);
  };
}
