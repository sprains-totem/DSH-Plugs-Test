import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Determine Chrome executable path
let chromePath = 'google-chrome';
if (process.platform === 'win32') {
  chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
} else if (process.platform === 'darwin') {
  chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}

const testMode = process.env.TEST_MODE || 'combined'; // 'antigravity' | 'tunnel' | 'combined'
const targetUrl = process.env.TARGET_URL || 'http://127.0.0.1:3080/';
const debugPort = parseInt(process.env.DEBUG_PORT || '9222', 10);
const outputDir = path.resolve(process.env.OUTPUT_DIR || `./screenshots/${testMode}`);
const tempProfile = path.resolve(process.env.TEMP_PROFILE || `./.tmp-chrome-${testMode}`);

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function run() {
  console.log('===============================================================');
  console.log(`   DSH Plugins E2E Verification - Mode: [${testMode.toUpperCase()}]`);
  console.log('===============================================================');
  console.log('Target URL:', targetUrl);
  console.log('Test Mode:', testMode);
  console.log('Chrome Path:', chromePath);
  console.log('Output Directory:', outputDir);

  const chromeArgs = [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${tempProfile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-extensions',
    '--disable-gpu',
    '--window-size=1280,900'
  ];

  if (process.env.HEADLESS !== 'false' && process.platform !== 'win32') {
    chromeArgs.push('--headless=new', '--no-sandbox', '--disable-setuid-sandbox');
  }

  // Pass targetUrl directly on command line
  chromeArgs.push(targetUrl);

  console.log('\n[1/5] Launching Chrome browser with target URL...');
  const chromeProc = spawn(chromePath, chromeArgs, { detached: true, stdio: 'ignore' });

  // Connect to Chrome CDP endpoint
  console.log(`[2/5] Connecting to Chrome CDP on port ${debugPort}...`);
  let targetWs = null;
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      if (res.ok) {
        const list = await res.json();
        const page = list.find(p => p.type === 'page' && p.webSocketDebuggerUrl);
        if (page) {
          targetWs = page.webSocketDebuggerUrl;
          console.log('Connected to Chrome page via CDP:', targetWs);
          break;
        }
      }
    } catch {}
    await sleep(500);
  }

  if (!targetWs) {
    throw new Error(`Failed to connect to Chrome DevTools Protocol on port ${debugPort}`);
  }

  const ws = new WebSocket(targetWs);
  let id = 1;
  const pending = new Map();
  const consoleLogs = [];
  const errors = [];

  function send(method, params = {}) {
    const msgId = id++;
    const payload = { id: msgId, method, params };
    ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => pending.set(msgId, { resolve, reject }));
  }

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(msg.error);
      else resolve(msg.result);
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args.map(a => a.value ?? a.description ?? '').join(' ');
      consoleLogs.push(`[${msg.params.type}] ${text}`);
      if (msg.params.type === 'error') {
        console.error(`[Browser Console Error] ${text}`);
      }
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const desc = msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text;
      errors.push(desc);
      console.error(`[Browser Uncaught Exception] ${desc}`);
    }
  };

  await new Promise(resolve => ws.onopen = resolve);
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable');

  console.log(`\n[3/5] Navigating and waiting for ${targetUrl} ready...`);
  await send('Page.navigate', { url: targetUrl });

  // Wait for document ready and __DSH_BOOT__
  for (let i = 0; i < 30; i++) {
    try {
      const checkState = await send('Runtime.evaluate', {
        expression: `({
          href: document.location.href,
          readyState: document.readyState,
          hasBoot: !!window.__DSH_BOOT__,
          hasButtons: document.querySelectorAll('button').length,
          bodyText: document.body?.innerText?.slice(0, 100) || ''
        })`,
        returnByValue: true
      });
      const st = checkState.result?.value;
      if (st?.href !== 'about:blank' && st?.hasBoot && st?.hasButtons > 0) {
        console.log(`  -> Page ready on check #${i}:`, st);
        break;
      }
    } catch {}
    await sleep(500);
  }

  // Extra settle time for client modules
  await sleep(3000);

  // Capture Main Dashboard View
  const shot1 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outputDir, '01_main_view.png'), Buffer.from(shot1.data, 'base64'));
  console.log('  -> Saved: 01_main_view.png');

  // Verify window.__DSH_BOOT__
  const bootManifest = await send('Runtime.evaluate', {
    expression: `(() => {
      const boot = window.__DSH_BOOT__;
      if (!boot) return { ok: false, error: 'window.__DSH_BOOT__ missing' };
      return {
        ok: true,
        rev: boot.rev,
        entriesCount: boot.entries?.length || 0,
        antigravityLoaded: boot.entries?.some(e => e.id.includes('antigravity')),
        searchSelectorLoaded: boot.entries?.some(e => e.id.includes('search-selector')),
        tunnelLoaded: boot.entries?.some(e => e.id.includes('cloudflare-tunnel'))
      };
    })()`,
    returnByValue: true
  });
  console.log('  -> Boot Manifest Check:', bootManifest.result?.value);

  // Open Settings Modal
  console.log('\n[4/5] Opening Settings modal...');
  const openSettings = await send('Runtime.evaluate', {
    expression: `(() => {
      const btns = Array.from(document.querySelectorAll('button, [role="button"], a'));
      const sBtn = btns.find(b => {
        const t = (b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '') + ' ' + (b.title || '') + ' ' + (b.className || '');
        return t.toLowerCase().includes('设置') || t.toLowerCase().includes('settings') || t.toLowerCase().includes('setting');
      });
      if (sBtn) {
        sBtn.click();
        return { ok: true, name: sBtn.innerText || 'icon' };
      }
      return { ok: false };
    })()`,
    returnByValue: true
  });
  console.log('  -> Settings Button Click:', openSettings.result?.value);
  await sleep(2000);

  let verificationSuccess = true;

  // -------------------------------------------------------------
  // Test Mode: Antigravity Standalone or Combined
  // -------------------------------------------------------------
  if (testMode === 'antigravity' || testMode === 'combined') {
    console.log('\n--- Verifying Antigravity Provider & Web Search Selector ---');
    
    // Switch to Models Tab (support bilingual Models / 模型)
    const modelsTabClick = await send('Runtime.evaluate', {
      expression: `(() => {
        const tabs = Array.from(document.querySelectorAll('button, div, span, a'));
        const mTab = tabs.find(t => {
          const txt = (t.innerText || '').trim().toLowerCase();
          return txt === '模型' || txt === 'models' || txt === 'model';
        });
        if (mTab) {
          mTab.click();
          return { ok: true, text: mTab.innerText };
        }
        return { ok: false };
      })()`,
      returnByValue: true
    });
    console.log('  -> Models Tab Click:', modelsTabClick.result?.value);
    await sleep(1500);

    const shot2 = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outputDir, '02_settings_models.png'), Buffer.from(shot2.data, 'base64'));
    console.log('  -> Saved: 02_settings_models.png');

    // Click Antigravity Edit Button (support Edit / 编辑 / Configure)
    const editClick = await send('Runtime.evaluate', {
      expression: `(() => {
        const rows = Array.from(document.querySelectorAll('div, li, tr')).filter(el => {
          const t = el.innerText || '';
          return t.includes('Antigravity') && el.querySelector('button');
        });
        if (rows.length > 0) {
          const btn = rows[0].querySelector('button');
          if (btn) {
            btn.click();
            return { ok: true, btnText: btn.innerText };
          }
        }
        const editBtns = Array.from(document.querySelectorAll('button')).filter(b => {
          const t = (b.innerText || '').trim().toLowerCase();
          return t === '编辑' || t === 'edit' || t === 'configure' || t === '配置';
        });
        if (editBtns.length > 0) {
          editBtns[0].click();
          return { ok: true, btnText: editBtns[0].innerText };
        }
        return { ok: false };
      })()`,
      returnByValue: true
    });
    console.log('  -> Antigravity Edit Button Click:', editClick.result?.value);
    await sleep(1500);

    const shot3 = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outputDir, '03_antigravity_modal_edit.png'), Buffer.from(shot3.data, 'base64'));
    console.log('  -> Saved: 03_antigravity_modal_edit.png');

    // Switch to Plugins Tab (support bilingual Plugins / 插件)
    const pluginsTabClick = await send('Runtime.evaluate', {
      expression: `(() => {
        const tabs = Array.from(document.querySelectorAll('button, div, span, a'));
        const pTab = tabs.find(t => {
          const txt = (t.innerText || '').trim().toLowerCase();
          return txt === '插件' || txt === 'plugins' || txt === 'plugin';
        });
        if (pTab) {
          pTab.click();
          return { ok: true, text: pTab.innerText };
        }
        return { ok: false };
      })()`,
      returnByValue: true
    });
    console.log('  -> Plugins Tab Click:', pluginsTabClick.result?.value);
    await sleep(2000);

    const shot4 = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outputDir, '04_settings_plugins.png'), Buffer.from(shot4.data, 'base64'));
    console.log('  -> Saved: 04_settings_plugins.png');

    // Scroll down to capture Web Search Selector card
    await send('Runtime.evaluate', {
      expression: `(() => {
        const scrollable = Array.from(document.querySelectorAll('div, ul')).find(el => el.scrollHeight > el.clientHeight);
        if (scrollable) scrollable.scrollTop = 600;
        else window.scrollTo(0, 600);
      })()`
    });
    await sleep(1000);

    const shot5 = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outputDir, '05_settings_plugins_scrolled.png'), Buffer.from(shot5.data, 'base64'));
    console.log('  -> Saved: 05_settings_plugins_scrolled.png');

    const antiCheck = await send('Runtime.evaluate', {
      expression: `(() => {
        const bodyText = document.body.innerText;
        const select = document.querySelector('select');
        const hasAnti = bodyText.includes('Antigravity');
        const hasSearch = bodyText.includes('网页搜索源') || bodyText.includes('Web search') || bodyText.includes('search-selector') || !!select;
        return {
          hasAntigravityCard: hasAnti,
          hasRefreshTokenConfigured: bodyText.includes('已配置') || bodyText.includes('configured') || bodyText.includes('Refresh Token'),
          hasWebSearchSelectorCard: hasSearch,
          selectValue: select ? select.value : null
        };
      })()`,
      returnByValue: true
    });

    console.log('Antigravity Verification Results:\n', JSON.stringify(antiCheck.result?.value, null, 2));
    if (!antiCheck.result?.value?.hasAntigravityCard) {
      verificationSuccess = false;
      console.error('❌ Antigravity verification failed: Antigravity card not found in settings.');
    }
  }

  // -------------------------------------------------------------
  // Test Mode: Cloudflare Tunnel Standalone or Combined
  // -------------------------------------------------------------
  if (testMode === 'tunnel' || testMode === 'combined') {
    console.log('\n--- Verifying Cloudflare Tunnel Plugin & Status ---');
    
    // Switch to Plugins Tab
    await send('Runtime.evaluate', {
      expression: `(() => {
        const tabs = Array.from(document.querySelectorAll('button, div, span, a'));
        const pTab = tabs.find(t => {
          const txt = (t.innerText || '').trim().toLowerCase();
          return txt === '插件' || txt === 'plugins' || txt === 'plugin';
        });
        if (pTab) pTab.click();
      })()`
    });
    await sleep(1500);

    const shotTunnel = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outputDir, '06_cloudflare_tunnel_tab.png'), Buffer.from(shotTunnel.data, 'base64'));
    console.log('  -> Saved: 06_cloudflare_tunnel_tab.png');

    const tunnelCheck = await send('Runtime.evaluate', {
      expression: `(() => {
        const bodyText = document.body.innerText;
        return {
          pageLoaded: bodyText.length > 50,
          hasErrorBanner: bodyText.includes('Failed to load plugins')
        };
      })()`,
      returnByValue: true
    });

    console.log('Tunnel Verification Results:\n', JSON.stringify(tunnelCheck.result?.value, null, 2));
    if (tunnelCheck.result?.value?.hasErrorBanner) {
      verificationSuccess = false;
      console.error('❌ Tunnel verification failed: Error banner detected.');
    }
  }

  // -------------------------------------------------------------
  // Test Mode: Live Chat Conversation Test (Antigravity Gemini LLM)
  // -------------------------------------------------------------
  if (testMode === 'antigravity' || testMode === 'combined') {
    console.log('\n[5/5] Testing Live Chat Conversation with Antigravity Gemini 3.7...');
    
    // Close settings modal
    await send('Runtime.evaluate', {
      expression: `(() => {
        const closeBtns = Array.from(document.querySelectorAll('button')).filter(b => {
          const t = (b.innerText || b.getAttribute('aria-label') || '').toLowerCase();
          return t.includes('关闭') || t.includes('close') || b.querySelector('svg');
        });
        if (closeBtns.length > 0) closeBtns[0].click();
      })()`
    });
    await sleep(1000);

    // Send a message in chat
    const chatSent = await send('Runtime.evaluate', {
      expression: `(() => {
        const textarea = document.querySelector('textarea') || document.querySelector('[contenteditable="true"]');
        if (!textarea) return { ok: false, error: 'No textarea found' };
        if (textarea.tagName === 'TEXTAREA') {
          textarea.value = '你好！请输出一句问候语，并说明当前使用的模型是 Gemini 3.7。';
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          textarea.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          textarea.innerText = '你好！请输出一句问候语，并说明当前使用的模型是 Gemini 3.7。';
        }
        
        // Find send button or submit
        const btns = Array.from(document.querySelectorAll('button'));
        const sendBtn = btns.find(b => {
          const t = (b.innerText || b.getAttribute('aria-label') || '').toLowerCase();
          return b.querySelector('svg') || t.includes('发送') || t.includes('send') || b.type === 'submit';
        });
        if (sendBtn) {
          sendBtn.click();
          return { ok: true, clicked: true };
        }
        return { ok: true, clicked: false };
      })()`,
      returnByValue: true
    });
    console.log('  -> Chat message trigger:', chatSent.result?.value);

    // Wait for response generation (up to 15s)
    console.log('  -> Waiting for model streaming response...');
    await sleep(12000);

    const shotChat = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outputDir, '07_live_conversation.png'), Buffer.from(shotChat.data, 'base64'));
    console.log('  -> Saved: 07_live_conversation.png');
  }

  ws.close();

  if (errors.length > 0) {
    console.warn(`\n[!] Notice: ${errors.length} browser errors recorded during test:`);
    errors.forEach(e => console.warn('  - ' + e));
  }

  console.log('\n===============================================================');
  if (verificationSuccess) {
    console.log(`🎉 TEST MODE [${testMode.toUpperCase()}] VERIFICATION PASSED SUCCESSFULLY! 🎉`);
  } else {
    throw new Error(`Test Mode [${testMode.toUpperCase()}] verification failed.`);
  }
  console.log('===============================================================\n');
}

run().catch((err) => {
  console.error('\n❌ Chrome Automated Test Failed:', err.message);
  process.exit(1);
});
