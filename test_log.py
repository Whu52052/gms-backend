"""Add debug logging to API.init on operations.html"""
import subprocess, time, sys
from playwright.sync_api import sync_playwright
sys.stdout.reconfigure(encoding='utf-8')

subprocess.run(["taskkill", "/f", "/im", "node.exe"], capture_output=True)
time.sleep(2)
proc = subprocess.Popen(["node", "server.js"], cwd=r"D:\HuaweiMoveData\Users\24492\Desktop\Shout", stdout=subprocess.PIPE, stderr=subprocess.PIPE)
time.sleep(8)

# Verify server is running
import requests
r = requests.get("http://localhost:8765/api/health")
print(f"Server health: {r.json()}")

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    logs = []
    page.on("console", lambda msg: logs.append(f"[{msg.type}] {msg.text}"))
    page.on("pageerror", lambda err: logs.append(f"[ERR] {err}"))

    # Login on index
    page.goto("http://localhost:8765/index.html")
    page.wait_for_timeout(2000)

    # Override API methods
    page.evaluate("""
        () => {
            const origInit = API.init.bind(API);
            API.init = async function() {
                console.log('[API.init] START');
                console.log('[API.init] token: ' + !!localStorage.getItem('gms_token'));
                console.log('[API.init] user: ' + !!localStorage.getItem('gms_user'));
                console.log('[API.init] baseURL: ' + this.baseURL);
                const r = await origInit();
                console.log('[API.init] END - online: ' + this.online + ', token: ' + !!this.token + ', cu: ' + !!this.currentUser);
                return r;
            };
            const origCheck = API._checkServer.bind(API);
            API._checkServer = async function() {
                console.log('[CHECK] start, url: ' + this.baseURL + '/api/health');
                const r = await origCheck();
                console.log('[CHECK] result: ' + r);
                return r;
            };
            console.log('[OVERRIDE] installed on index page');
        }
    """)

    page.fill("#login-username", "yunying")
    page.fill("#login-password", "yunying1025")
    page.click("#login-btn")
    page.wait_for_timeout(3000)

    print("Login done, navigating to operations...")

    # Navigate to operations
    page.goto("http://localhost:8765/operations.html")
    page.wait_for_timeout(4000)

    print(f"URL: {page.url}")
    state = page.evaluate("() => ({cu: !!API.currentUser, online: API.online, token: !!localStorage.getItem('gms_token')})")
    print(f"State: {state}")

    print(f"\n=== All logs ({len(logs)}) ===")
    for l in logs:
        print(f"  {l[:300]}")

    browser.close()
proc.terminate()
