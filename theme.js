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

// CSSOM handles comments, escapes and nested syntax before the scope check.
export function compileTheme(css, Sheet = globalThis.CSSStyleSheet) {
  if (typeof css !== 'string' || css.length > 100000) throw new Error('CSSは100KB以内にしてください。');
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

export function initializeTheme(storage) {
  document.querySelector('main').classList.add('pokome-workspace');
  document.querySelector('.sidebar').classList.add('pokome-workspace');
  const style = document.createElement('style');
  style.id = 'pokome-user-theme';
  document.head.append(style);
  const section = document.createElement('section');
  section.className = 'panel studio-form';
  section.innerHTML = `<div class="studio-fields"><h2>見た目の保存・読み込み</h2>
    <p>読み込んだ見た目やCSSで追加した見た目、ホーム・雑談画面の配置を保存して、後で戻したり、ほかの人と共有したりできます。</p>
    <label>保存した見た目を読み込む<input id="theme-import" type="file" accept=".css,.json,text/css,application/json" aria-describedby="theme-import-help"></label>
    <p id="theme-import-help">.cssのファイルは色や文字、枠などの見た目を変更します。.jsonのファイルは見た目とパネルの配置を変更します。読み込むと現在の設定が置き換わるため、残したい場合は先に保存してください。</p>
    <div><button id="design-export" class="button" aria-describedby="design-export-help">見た目と配置をファイルに保存</button></div>
    <p id="design-export-help">読み込んだ見た目やCSSで追加した見た目と、パネルの位置やサイズをまとめて保存します。上の配信デザイン設定、接続情報、コメントは含まれません。</p>
    <details><summary>詳しく見た目を編集する（CSS）</summary>
    <p>CSSは色や文字、枠などの見た目を指定するための記述です。使わなくても、上の配信デザイン設定で見た目を調整できます。自分でCSSを書きたい方だけご利用ください。</p>
    <label>見た目を指定するCSS<textarea id="theme-css" rows="12" spellcheck="false" aria-describedby="theme-css-help"></textarea></label>
    <p id="theme-css-help">入力後に「編集した見た目を反映」を押すと画面に反映され、自動で保存されます。「追加した見た目を解除」で、この欄のCSSによる変更を取り消せます。</p>
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
  let workspace;
  const persist = css => {
    try { storage?.setItem('pokome-theme-v1', css); return !!storage; }
    catch { return false; }
  };
  const beginChange = () => ++generation;
  const apply = (css, expected = beginChange(), { save = true } = {}) => {
    if (expected !== generation) return null;
    const compiled = compileTheme(css);
    style.textContent = compiled;
    current = css;
    input.value = css || DEFAULT_THEME_CSS;
    const saved = !save || persist(css);
    status.textContent = saved ? '見た目を反映・保存しました。' : '見た目を反映しました。保存できないため、再読み込みすると元に戻ります。';
    return saved;
  };
  const resetTheme = () => apply('');
  const run = action => { try { action(); } catch (error) { status.textContent = error.message; } };
  try { apply(storage?.getItem('pokome-theme-v1') || ''); } catch { resetTheme(); }
  section.querySelector('#theme-apply').onclick = () => run(() => apply(input.value));
  section.querySelector('#theme-reset').onclick = () => run(resetTheme);
  const download = (name, content, type) => {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement('a'); link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  section.querySelector('#theme-export').onclick = () => download('pokome-theme.css', current, 'text/css');
  section.querySelector('#design-export').onclick = () => download('pokome-design.json', JSON.stringify({
    manifest: { format: 'pokome-design', version: 1, themeApi: 1 }, theme: current, layout: workspace.getLayouts(),
  }, null, 2), 'application/json');
  section.querySelector('#theme-import').onchange = async event => {
    const file = event.target.files[0];
    if (!file) return;
    const expected = beginChange();
    try {
      if (file.size > 200000) throw new Error('ファイルは200KB以内にしてください。');
      const content = await file.text();
      if (expected !== generation) return;
      if (file.name.toLowerCase().endsWith('.css')) apply(content, expected);
      else {
        const design = JSON.parse(content);
        if (design.manifest?.format !== 'pokome-design' || design.manifest.version !== 1 || design.manifest.themeApi !== 1) throw new Error('対応しないデザイン形式です。');
        compileTheme(design.theme);
        workspace.applyLayouts(design.layout);
        apply(design.theme, expected);
      }
    } catch (error) { status.textContent = `読み込み失敗: ${error.message}`; }
    event.target.value = '';
  };
  return { resetTheme, applyTheme: apply, beginChange, getTheme: () => current, reflectTheme: css => apply(css, beginChange(), { save: false }), connectWorkspace(value) { workspace = value; } };
}
