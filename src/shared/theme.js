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

// Shows the applied theme CSS on the operating page. It is edited in the
// design editor and reflected here only after it is saved.
export function initializeTheme(designStore) {
  document.querySelector('main').classList.add('pokome-workspace');
  document.querySelector('.sidebar').classList.add('pokome-workspace');
  const style = document.createElement('style');
  style.id = 'pokome-user-theme';
  document.head.append(style);
  // Shows a theme that is already stored, such as one changed in another tab.
  const reflectTheme = css => {
    try { style.textContent = compileTheme(css); } catch { style.textContent = ''; }
  };
  reflectTheme(designStore.design.theme);
  return { reflectTheme };
}
