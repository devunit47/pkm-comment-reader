import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { blockExternalFonts, chromium, executablePath, browserAvailable, temporaryDataDirectory, appReady, saveStudio, editorTarget, closeEditor, applyInEditor, talkStage } from './browser-support.js';

const browserTest = (name, run) => test(name, { skip: !browserAvailable }, run);
async function fixture(t, studio = {}) {
  const browser = await chromium.launch({ headless: true, executablePath });
  const directory = await mkdtemp(join(tmpdir(), 'pokome-identity-'));
  const server = createServer({ customizationDirectory: directory, dataDirectory: await temporaryDataDirectory() });
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  await saveStudio(base, studio);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await blockExternalFonts(context);
  const requests = [], errors = [];
  const png = await readFile(new URL('fixtures/presets/actor.png', import.meta.url));
  await context.route('https://static-cdn.jtvnw.net/**', route => {
    requests.push(route.request().url());
    return route.request().url().includes('/broken/') ? route.abort() : route.fulfill({ contentType: 'image/png', body: png });
  });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  await context.addInitScript(() => {
    window.testSockets = []; window.spoken = [];
    window.WebSocket = class { constructor() { window.testSockets.push(this); } send() {} close() {} };
    Object.defineProperty(window, 'speechSynthesis', { value: {
      getVoices: () => [{ name: '確認用音声', voiceURI: 'qa-voice', lang: 'ja-JP' }], addEventListener() {}, cancel() {},
      speak(utterance) { window.spoken.push(utterance.text); utterance.onstart?.(); utterance.onend?.(); },
    } });
  });
  const page = await context.newPage(); page.setDefaultTimeout(8000);
  await page.goto(base); await appReady(page);
  await page.evaluate(() => {
    document.querySelector('#read-name').checked = true; document.querySelector('#read-name').dispatchEvent(new Event('change'));
    document.querySelector('#twitch-channel').value = 'qa_channel';
    document.querySelector('#twitch-connect-form').requestSubmit();
  });
  await page.waitForFunction(() => window.testSockets.length === 1);
  await page.evaluate(() => { const socket = window.testSockets[0]; socket.onopen(); socket.onmessage({ data: ':server 366 anon #qa_channel :End\r\n' }); });
  await page.locator('#twitch-status').filter({ hasText: '接続済み' }).waitFor({ state: 'attached' });
  return { context, page, base, requests, errors };
}
async function receive(page, text, tags = 'color=#ffffff;badges=vip/1;emotes=25:2-6') {
  await page.evaluate(({ text, tags }) => window.testSockets[0].onmessage({ data: `@${tags} :viewer!viewer@host PRIVMSG #qa_channel :${text}\r\n` }), { text, tags });
}

browserTest('Twitch emotes and service colors reach live, preview and output; failed images become text and speech excludes emotes', async t => {
  const { context, page, base, requests, errors } = await fixture(t, { commentAuthorColor: 'service', commentPanel: 'light' });
  await receive(page, '😀 Kappa hello');
  await page.locator('.nav[data-page="studio"]').click();
  await talkStage(page).locator('#stage-chat-list img.pokome-comment__emote').waitFor({ state: 'attached' });
  const output = await context.newPage(); await output.goto(`${base}/output.html`);
  await output.locator('#stage-chat-list img.pokome-comment__emote').waitFor({ state: 'attached' });
  await page.locator('#open-design-preview').click(); await editorTarget(page, 'chat');
  const frame = page.frameLocator('#design-preview-frame');
  await frame.locator('img.pokome-comment__emote').first().waitFor({ state: 'attached' });
  const color = locator => locator.evaluate(element => getComputedStyle(element).color);
  const liveColor = await color(talkStage(page).locator('#stage-chat-list .stage-comment').filter({ hasText: 'viewer' }).first().locator('strong'));
  assert.equal(await color(output.locator('#stage-chat-list .stage-comment').filter({ hasText: 'viewer' }).first().locator('strong')), liveColor);
  assert.equal(await color(frame.locator('.stage-comment').first().locator('strong')), liveColor);
  assert.ok(requests.every(url => /^https:\/\/static-cdn\.jtvnw\.net\/emoticons\/v2\/[A-Za-z0-9_]+\/default\/dark\/3\.0$/.test(url)));
  await closeEditor(page);
  assert.deepEqual(await page.evaluate(() => window.spoken), ['viewerさん。😀 hello']);
  await receive(page, 'Kappa', 'emotes=25:0-4');
  assert.equal(await page.evaluate(() => window.spoken.length), 1);
  await receive(page, 'Broken', 'emotes=broken:0-5');
  await page.waitForFunction(() => [...document.getElementById('talk-frame').contentDocument.querySelectorAll('#stage-chat-list .pokome-comment__body')].some(element => element.textContent === 'Broken' && !element.querySelector('img')));
  assert.equal(await talkStage(page).locator('#stage-chat-list .stage-comment').filter({ hasText: 'Broken' }).locator('.pokome-comment__emote-piece').count(), 0, 'failed images use normal text spacing');
  assert.equal(await page.locator('#comment-list img').count(), 0);
  await applyInEditor(page, async editor => { await editorTarget(editor, 'chat'); await editor.locator('#draft-commentEmotes').selectOption('text'); });
  await output.waitForFunction(() => !document.querySelector('#stage-chat-list img.pokome-comment__emote'));
  const count = requests.length;
  await receive(page, '😀 Kappa hello');
  await page.locator('#open-design-preview').click();
  await frame.locator('.stage-comment').nth(9).waitFor({ state: 'attached' });
  assert.equal(await frame.locator('img.pokome-comment__emote').count(), 0);
  await page.waitForTimeout(150);
  assert.equal(requests.length, count, 'text mode never requests the CDN, including preview and new comments');
  assert.deepEqual(errors, []);
});

browserTest('identity rendering preserves line limits and clipping across six presets, four themes, two schemes and three ratios', async t => {
  const { normalizeStudio, applyCommentPreset, COMMENT_PRESETS } = await import('../src/shared/studio.js');
  const { saveDesign } = await import('./browser-support.js');
  const { context, page, base, errors } = await fixture(t, { commentBadges: true, commentAuthorColor: 'service' });
  await receive(page, '😀 Kappa hello', 'color=#ffffff;badges=broadcaster/1,moderator/1,vip/1,subscriber/12;emotes=25:2-6');
  await receive(page, 'Kappa '.repeat(12).trimEnd(), 'color=#000000;badges=vip/1;emotes=25:' + Array.from({ length: 12 }, (_, i) => `${i * 6}-${i * 6 + 4}`).join(','));
  await receive(page, 'Broken', 'emotes=broken:0-5');
  await receive(page, '😀 Kappa ' + '長めの文章を折り返して確認します。'.repeat(35));
  const output = await context.newPage(); await output.goto(`${base}/output.html`);
  await output.locator('img.pokome-comment__emote').first().waitFor({ state: 'attached' });
  await page.locator('#enter-talk').click();
  const inspect = (list, maxLines) => list.evaluate((element, maxLines) => {
    const bounds = element.getBoundingClientRect();
    const cards = [...element.querySelectorAll('.stage-comment')];
    return {
      viewportHeight: bounds.height,
      overflow: cards.flatMap((card, index) => {
        const body = card.querySelector('p'), style = getComputedStyle(body);
        const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
        const rowHeight = body.querySelector('img') ? Math.max(parseFloat(style.lineHeight), parseFloat(style.fontSize) * 2) : parseFloat(style.lineHeight);
        return body.scrollWidth > body.clientWidth + 1 || (maxLines > 0 && (body.clientHeight - padding > rowHeight * maxLines + 1 || Number(style.webkitLineClamp) !== maxLines)) ? [index] : [];
      }),
      clipping: cards.flatMap((card, index) => {
        const rect = card.getBoundingClientRect();
        const expected = rect.height <= bounds.height && (rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1);
        return expected !== card.classList.contains('stage-comment-clipped') ? [index] : [];
      }),
      badges: cards[0]?.querySelectorAll('.pokome-comment__badge').length,
      color: getComputedStyle(cards[0].querySelector('strong')).color,
      emoteHeight: getComputedStyle(element.querySelector('img.pokome-comment__emote')).height,
      fontSize: getComputedStyle(cards[0].querySelector('p')).fontSize,
      partialImages: cards.flatMap((card, index) => {
        const body = card.querySelector('p'), bounds = body.getBoundingClientRect();
        return [...body.querySelectorAll('img')].some(image => {
          const rect = image.getBoundingClientRect();
          return rect.bottom > bounds.top + 1 && rect.top < bounds.bottom - 1 && (rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1);
        }) ? [index] : [];
      }),
      imageBounds: cards.flatMap((card, index) => {
        const rect = card.getBoundingClientRect(), body = card.querySelector('p').getBoundingClientRect();
        return [...card.querySelectorAll('img')].some(image => {
          const imageRect = image.getBoundingClientRect();
          if (imageRect.bottom <= body.top + 1 || imageRect.top >= body.bottom - 1) return false;
          return imageRect.top < rect.top - 1 || imageRect.bottom > rect.bottom + 1 || imageRect.left < rect.left - 1 || imageRect.right > rect.right + 1
            || (!card.classList.contains('stage-comment-clipped') && (imageRect.left < bounds.left - 1 || imageRect.right > bounds.right + 1));
        }) ? [index] : [];
      }),
      imageOverlap: cards.flatMap((card, index) => {
        const images = [...card.querySelectorAll('img')].map(image => image.getBoundingClientRect());
        return images.some((a, i) => images.slice(i + 1).some(b => Math.abs(a.top - b.top) > 1 && a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1)) ? [index] : [];
      }),
    };
  }, maxLines);
  let combinations = 0;
  for (const scheme of ['light', 'dark']) for (const theme of ['mint', 'rose', 'violet', 'paper']) for (const preset of Object.keys(COMMENT_PRESETS)) for (const fontSize of [16, 64]) {
    await page.emulateMedia({ colorScheme: scheme }); await output.emulateMedia({ colorScheme: scheme });
    const studio = { ...applyCommentPreset(normalizeStudio({ theme }), preset), fontSize, commentAuthorColor: 'service', commentBadges: true, commentEmotes: 'image' };
    for (const [ratio, size, width, height] of [['16:9', '1280x720', 1280, 720], ['9:16', '1080x1920', 1080, 1920], ['4:3', '1440x1080', 1440, 1080]]) {
      const label = `${scheme}/${theme}/${preset}/${ratio}/${fontSize}px`;
      await output.setViewportSize({ width, height });
      await saveDesign(base, design => ({ ...design, outputSize: size, studio }));
      for (const target of [page, output]) await target.waitForFunction(({ theme, ratio, style, panel, fontSize }) => {
        const doc = document.getElementById('talk-frame')?.contentDocument ?? document;
        const stage = doc.querySelector('#talk-stage');
        return stage.dataset.theme === theme && (stage.dataset.ratio || doc.body.dataset.ratio) === ratio && doc.querySelector('#stage-chat-list').dataset.commentStyle === style && (stage.dataset.commentPanel || 'theme') === panel && parseFloat(getComputedStyle(stage.querySelector('.pokome-comment__body')).fontSize) === fontSize;
      }, { theme, ratio, style: studio.commentStyle, panel: studio.commentPanel, fontSize });
      await page.bringToFront();
      await page.locator('#stage-design-edit').click(); await editorTarget(page, 'chat');
      await page.locator('#preview-ratio').selectOption(ratio);
      const preview = page.frameLocator('#design-preview-frame');
      await preview.locator('img.pokome-comment__emote').first().waitFor({ state: 'attached' });
      const results = [];
      for (const [owner, list] of [[page, talkStage(page).locator('#stage-chat-list')], [page, preview.locator('#stage-chat-list')], [output, output.locator('#stage-chat-list')]]) {
        await owner.bringToFront();
        await owner.waitForTimeout(50);
        await list.evaluate(element => Promise.all([...element.querySelectorAll('img')].map(image => image.decode().catch(() => {}))));
        results.push(await inspect(list, studio.commentMaxLines));
      }
      for (const result of results) {
        assert.ok(result.viewportHeight > 0, `${label}: visible viewport`);
        assert.deepEqual(result.overflow, [], `${label}: overflow/line clamp`);
        assert.deepEqual(result.clipping, [], `${label}: clipping`);
        assert.equal(result.badges, 4, `${label}: role symbols`);
        assert.deepEqual(result.partialImages, [], `${label}: whole emotes inside line clamp`);
        assert.deepEqual(result.imageBounds, [], `${label}: images inside chips and panel width`);
        assert.equal(parseFloat(result.fontSize), fontSize, `${label}: requested font size`);
        assert.deepEqual(result.imageOverlap, [], `${label}: wrapped emotes do not cover each other`);
        assert.equal(parseFloat(result.emoteHeight), parseFloat(result.fontSize) * 2, `${label}: emote height`);
      }
      assert.ok(results.every(result => result.color === results[0].color), `${label}: same name color`);
      await page.bringToFront();
      await closeEditor(page);
      combinations++;
    }
  }
  assert.equal(combinations, 288);
  t.diagnostic('Edge: 288 preset/theme/scheme/ratio/font combinations, each compared across live, preview and output');
  assert.deepEqual(errors, []);
});

browserTest('one-comment previews retain role and emote samples in both newest positions', async t => {
  const { page } = await fixture(t, { maxVisible: 1, commentBadges: true, commentAuthorColor: 'service' });
  await page.locator('.nav[data-page="studio"]').click();
  await page.locator('#open-design-preview').click(); await editorTarget(page, 'chat');
  const frame = page.frameLocator('#design-preview-frame');
  for (const position of ['bottom', 'top']) {
    await page.locator('#draft-newestPosition').selectOption(position);
    await frame.locator('.stage-comment').waitFor({ state: 'attached' });
    assert.equal(await frame.locator('.stage-comment').count(), 1);
    assert.equal(await frame.locator('img.pokome-comment__emote').count(), 1, `${position}: emote sample`);
    assert.equal(await frame.locator('.pokome-comment__badge').count(), 4, `${position}: role samples`);
  }
});
browserTest('emotes are twice the text height, preserve their image ratio and remain whole inside clamped chips', async t => {
  const { page } = await fixture(t, { fontSize: 64, commentMaxLines: 2, commentLineHeight: 1.2, commentItemBackground: 'light' });
  await receive(page, 'Kappa Kappa', 'emotes=25:0-4,6-10');
  await page.locator('#enter-talk').click();
  await page.waitForFunction(() => [...document.getElementById('talk-frame').contentDocument.querySelectorAll('#stage-chat-list img')].every(image => image.complete && image.naturalHeight));
  const measured = await talkStage(page).locator('#stage-chat-list .stage-comment').first().evaluate(card => {
    const body = card.querySelector('p'), bounds = body.getBoundingClientRect(), cardBounds = card.getBoundingClientRect();
    return { font: parseFloat(getComputedStyle(body).fontSize), images: [...body.querySelectorAll('img')].map(image => {
      const rect = image.getBoundingClientRect(), style = getComputedStyle(image);
      return { height: parseFloat(style.height), width: parseFloat(style.width), ratio: image.naturalWidth / image.naturalHeight, src: image.getAttribute('src'),
        inBody: rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1,
        inCard: rect.top >= cardBounds.top - 1 && rect.bottom <= cardBounds.bottom + 1 && rect.left >= cardBounds.left - 1 && rect.right <= cardBounds.right + 1 };
    }) };
  });
  assert.equal(measured.font, 64);
  assert.equal(measured.images.length, 2);
  for (const image of measured.images) {
    assert.equal(image.height, measured.font * 2, 'Twitch-sized emote');
    assert.ok(Math.abs(image.width / image.height - image.ratio) < .01, 'intrinsic aspect ratio');
    assert.ok(image.src.endsWith('/3.0'), 'high-resolution image');
    assert.ok(image.inBody, 'line clamp preserves the full image');
    assert.ok(image.inCard, 'image stays inside the chip');
  }
});
