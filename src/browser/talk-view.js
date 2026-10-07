// The parent owns every operation; this script-free frame only hosts the scene.
export function initializeTalkView(stage, { onPointerDown = () => {} } = {}) {
  const view = document.getElementById('talk-view'), frame = document.getElementById('talk-frame');
  const error = document.getElementById('talk-view-error');
  const ready = (async () => { try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { frame.onload = null; reject(new Error('雑談画面を読み込めませんでした。雑談モードを終了して、画面を再読み込みしてください。')); }, 10000);
      frame.onload = () => { clearTimeout(timeout); frame.onload = null; resolve(); };
      frame.srcdoc = '<!doctype html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="./style.css"></head><body class="talk-mode pokome-talk"><main class="pokome-workspace"></main></body></html>';
    });
    const doc = frame.contentDocument;
    if (!doc.querySelector('link').sheet?.cssRules.length) throw new Error('雑談画面のスタイルを読み込めませんでした。画面を再読み込みしてください。');
    doc.querySelector('main').append(stage); stage.hidden = false;
    for (const selector of ['#stage-chat-list', '.stage-speech-content']) stage.querySelector(selector).tabIndex = 0;
    doc.addEventListener('pointerdown', onPointerDown);
    doc.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      }
    });
    return true;
  } catch (failure) { frame.hidden = true; error.hidden = false; error.textContent = failure.message; return false; } })();
  function scale() {
    if (view.hidden) return;
    const width = parseFloat(frame.style.width), height = parseFloat(frame.style.height);
    if (!(width > 0 && height > 0)) return;
    const factor = Math.min(view.clientWidth / width, view.clientHeight / height);
    frame.style.transform = `scale(${factor})`;
    const viewport = document.getElementById('talk-viewport');
    viewport.style.width = `${width * factor}px`; viewport.style.height = `${height * factor}px`;
  }
  new ResizeObserver(scale).observe(view);
  return { ready, setSize(width, height) { frame.style.width = `${width}px`; frame.style.height = `${height}px`; scale(); }, scale };
}
