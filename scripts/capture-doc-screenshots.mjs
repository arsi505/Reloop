import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const debugPort = 9239;
const captureWidth = 1440;
const captureHeight = 900;
const outputDir = join(process.cwd(), 'docs', 'assets', 'screenshots');
const profileDir = join(process.cwd(), '.tmp-doc-screenshot-profile');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForDebugger() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      if (response.ok) return;
    } catch {
      // Chrome is still starting.
    }
    await delay(250);
  }
  throw new Error('Chrome remote debugging did not become available.');
}

async function createTarget(url) {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
  });
  if (!response.ok) throw new Error(`Could not create capture tab: ${response.status}`);
  return response.json();
}

function connect(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  const pending = new Map();
  let commandId = 0;

  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });

  return {
    ready,
    send(method, params = {}) {
      const id = ++commandId;
      const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      socket.send(JSON.stringify({ id, method, params }));
      return result;
    },
    close() {
      socket.close();
    },
  };
}

async function capturePage(client, route, filename) {
  await client.send('Page.navigate', { url: `http://localhost:3100${route}` });
  await delay(1_100);
  const screenshot = await client.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    fromSurface: true,
  });
  await writeFile(join(outputDir, filename), Buffer.from(screenshot.data, 'base64'));
}

async function getDemoSession() {
  const response = await fetch('http://localhost:3101/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'http://localhost:3100',
    },
    body: JSON.stringify({ email: 'operator@reloop.test', password: 'Password123!' }),
  });
  if (!response.ok) throw new Error(`Demo login failed: ${response.status}`);

  const cookieHeader = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie().join('; ')
    : response.headers.get('set-cookie') || '';
  const cookie = cookieHeader.match(/reloop_refresh=([^;]+)/)?.[1];
  if (!cookie) throw new Error('Demo login did not return a refresh session cookie.');

  return { cookie, accessToken: (await response.json()).accessToken };
}

async function getRecoveryRoute(accessToken) {
  const response = await fetch('http://localhost:3101/recoveries?page=1&pageSize=1', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) return null;
  const data = await response.json();
  const id = data.items?.[0]?.id;
  return id ? `/recoveries/${id}` : null;
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  const chrome = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    `--window-size=${captureWidth},${captureHeight}`,
    '--hide-scrollbars',
    '--force-color-profile=srgb',
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  try {
    await waitForDebugger();
    const target = await createTarget('http://localhost:3100/login');
    const client = connect(target.webSocketDebuggerUrl);
    await client.ready;
    await client.send('Page.enable');
    await client.send('Network.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: captureWidth,
      height: captureHeight,
      deviceScaleFactor: 1,
      mobile: false,
    });

    await capturePage(client, '/login', '01-login-screen.png');

    const session = await getDemoSession();
    await client.send('Network.setCookie', {
      name: 'reloop_refresh',
      value: session.cookie,
      url: 'http://localhost:3100/auth/refresh',
      path: '/auth',
      httpOnly: true,
      sameSite: 'Lax',
    });

    await capturePage(client, '/dashboard', '02-dashboard-overview.png');
    await capturePage(client, '/exceptions', '03-exceptions-queue.png');
    await capturePage(client, '/orders', '05-orders-reconciliation.png');
    await capturePage(client, '/integrations', '06-integrations-hub.png');
    await capturePage(client, '/health', '07-system-health.png');

    const recoveryRoute = await getRecoveryRoute(session.accessToken);
    if (recoveryRoute) await capturePage(client, recoveryRoute, '04-recovery-detail.png');
    client.close();
  } finally {
    chrome.kill();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
