export const DEFAULT_THEME_CSS = `/* Pokome Theme API: 1 */
.pokome-workspace {
  --pk-text-color: #edf4e9;
  --pk-accent-color: #ace5cd;
}
.pokome-workspace .pokome-panel {
  border-radius: 16px;
}
.pokome-workspace .pokome-comment__author {
  color: var(--pk-accent-color);
}`;

// The bound limits parsing work; storage size no longer constrains it.
export const MAX_THEME_CSS_BYTES = 1_000_000;
export const themeByteLength = css => new TextEncoder().encode(css).length;

// CSSOM handles comments, escapes and nested syntax before the scope check.
// Self-contained (tests evaluate its source alone), so the limit is written
// out here; it equals MAX_THEME_CSS_BYTES.
export function compileTheme(css, Sheet = globalThis.CSSStyleSheet) {
  if (typeof css !== 'string' || new TextEncoder().encode(css).length > 1_000_000) throw new Error('CSSは1MB以内にしてください。');
  const sheet = new Sheet();
  sheet.replaceSync(css);
  const visit = rules => Array.from(rules, rule => {
    if (rule.selectorText) {
      if (rule.cssRules?.length) throw new Error('CSSのネストは展開して記述してください。');
      const selectors = rule.selectorText.split(',');
      if (selectors.some(selector => !/^\.pokome-workspace(?:\s+(?![+~])[^{}]+)?$/.test(selector.trim()))) {
        throw new Error('各セレクターは .pokome-workspace またはその子孫を指定してください。');
      }
      for (const property of Array.from({ length: rule.style.length }, (_, index) => rule.style[index])) {
        const value = rule.style.getPropertyValue(property);
        // Shared themes cannot initiate network requests or load executable assets.
        if (/url\s*\(|image-set\s*\(|\\/i.test(value)) throw new Error('テーマCSSの画像URL・外部フォントは使用できません。');
      }
      return rule.cssText;
    }
    if (rule.cssRules && /^@(media|supports)\b/.test(rule.cssText)) {
      return `${rule.cssText.slice(0, rule.cssText.indexOf('{'))}{${visit(rule.cssRules)}}`;
    }
    throw new Error('対応するCSSは通常のルール、@media、@supportsです。');
  }).join('\n');
  // replaceSync silently removes @import; reject it before accepting a theme.
  if (/@import/i.test(css.replace(/\/\*[\s\S]*?\*\//g, ''))) throw new Error('@importは使用できません。');
  const compiled = visit(sheet.cssRules);
  if (css.trim() && !compiled && !/^\s*(?:\/\*[\s\S]*?\*\/\s*)*$/.test(css)) throw new Error('有効なCSSルールがありません。');
  return compiled;
}

export function initializeTheme(designStore) {
  document.querySelector('main').classList.add('pokome-workspace');
  document.querySelector('.sidebar').classList.add('pokome-workspace');
  const style = document.createElement('style');
  style.id = 'pokome-user-theme';
  document.head.append(style);
  const section = document.createElement('section');
  section.className = 'panel studio-form';
  section.innerHTML = `<div class="studio-fields"><h2>CSSで見た目を変える</h2>
    <label>CSSファイルを読み込む<input id="theme-import" type="file" accept=".css,text/css" aria-describedby="theme-import-help"></label>
    <p id="theme-import-help">.cssのファイルは色や文字、枠などの見た目を変更します。読み込むと今のCSSが置き換わります。</p>
    <details><summary>詳しく見た目を編集する（CSS）</summary>
    <p>CSSは色や文字、枠などの見た目を指定するための記述です。使わなくても、上の配信デザイン設定で見た目を調整できます。自分でCSSを書きたい方だけご利用ください。</p>
    <label>見た目を指定するCSS<textarea id="theme-css" rows="12" spellcheck="false" aria-describedby="theme-css-help"></textarea></label>
    <p id="theme-css-help">入力後に「編集した見た目を反映」を押すと画面に反映され、customizationフォルダーに保存されます。「追加した見た目を解除」で、この欄のCSSによる変更を取り消せます。</p>
    <div><button id="theme-apply" class="button">編集した見た目を反映</button> <button id="theme-reset" class="button">追加した見た目を解除</button></div>
    <div><button id="theme-export" class="button">見た目だけを保存（CSS）</button></div>
    <p>この欄のCSSをファイルに保存します。パネルの配置や、上の配信デザイン設定は含まれません。</p>
    </details>
    <p id="theme-status" role="status"></p></div>`;
  document.getElementById('studio-page').append(section);
  const input = section.querySelector('textarea');
  const status = section.querySelector('#theme-status');
  let current = '';
  let generation = 0;
  const beginChange = () => ++generation;
  const show = css => {
    style.textContent = compileTheme(css);
    current = css;
    input.value = css || DEFAULT_THEME_CSS;
  };
  // Resolves true once saved, false if saving failed, null if superseded.
  const apply = async (css, expected = beginChange()) => {
    if (expected !== generation) return null;
    show(css);
    try { await designStore.save({ ...designStore.design, theme: css }); }
    catch (error) { status.textContent = `見た目を反映しましたが、保存できません。${error.message}`; return false; }
    if (expected === generation) status.textContent = '見た目を反映・保存しました。';
    return true;
  };
  // Shows a theme that is already stored, such as one changed in another tab.
  const reflectTheme = css => {
    beginChange();
    try { show(css); } catch (error) { style.textContent = ''; current = css; input.value = css; status.textContent = `保存されているCSSを適用できません：${error.message}`; }
  };
  const resetTheme = () => apply('');
  const run = async action => { try { await action(); } catch (error) { status.textContent = error.message; } };
  reflectTheme(designStore.design.theme);
  section.querySelector('#theme-apply').onclick = () => run(() => apply(input.value));
  section.querySelector('#theme-reset').onclick = () => run(resetTheme);
  section.querySelector('#theme-export').onclick = () => {
    const url = URL.createObjectURL(new Blob([current], { type: 'text/css' }));
    const link = document.createElement('a'); link.href = url; link.download = 'pokome-theme.css'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  section.querySelector('#theme-import').onchange = async event => {
    const file = event.target.files[0];
    if (!file) return;
    const expected = beginChange();
    try {
      if (file.size > MAX_THEME_CSS_BYTES) throw new Error('CSSは1MB以内にしてください。');
      const content = await file.text();
      if (expected !== generation) return;
      await apply(content, expected);
    } catch (error) { status.textContent = `読み込み失敗: ${error.message}`; }
    event.target.value = '';
  };
  return { resetTheme, applyTheme: apply, beginChange, getTheme: () => current, reflectTheme };
}
