// Live updates arrive in bursts (ten orders shipped at once = ten events): wait a moment and reload once.
export function coalesce(run: () => void, ms = 700) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const later = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; run(); }, ms);
  };
  later.cancel = () => { if (timer) clearTimeout(timer); timer = null; };
  return later;
}
