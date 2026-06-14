"""Debug logout call"""
import subprocess, time,sys
from playwright.sync_api import sync_playwright
sys.stdout.reconfigure(encoding='utf-8')

subprocess.run(["taskkill", "/f", "/im", "node.exe"], capture_output=True)
time.sleep(2)
proc = subprocess.Popen(["node", "server.js"], cwd=r"D:\HuaweiMoveData\Users\24492\Desktop\Shout", stdout=subprocess.PIPE, stderr=subprocess.PIPE)
time.sleep(8)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    logs = []
    page.on("console", lambda msg: logs.append(f"[{msg.type}] {msg.text}"))
    page.on("pageerror", lambda err: logs.append(f"[ERR] {err}"))

    page.goto("http://localhost:8765/index.html")
    page.wait_for_timeout(2000)

    # Override API.logout to trace
    page.evaluate("""
        () => {
            const origLogout = API.logout.bind(API);
            API.logout = function() {
                console.log('[LOGOUT] called! Stack: ' + new Error().stack?.substring(0, 200));
                origLogout();
            };
            const origValidate = API._validateToken.bind(API);
            API._validateToken = async function() {
                console.log('[VALIDATE] called, token: ' + (!!this.token));
                const r = await origValidate();
                console.log('[VALIDATE] result: ' + r);
                return r;
            };
            const origCheckServer = API._checkServer.bind(API);
            API._checkServer = async function() {
                console.log('[CHECK] health check...');
                const r = await origCheckServer();
                console.log('[CHECK] result: ' + r);
                return r;
            };
            console.log('[DEBUG] overrides installed');
        }
    """)

    page.fill("#login-username", "yunying")
    page.fill("#login-password", "yunying1025")
    page.click("#login-btn")
    page.wait_for_timeout(5000)

    print(f"URL: {page.url}")
    state = page.evaluate("() => ({token: !!localStorage.getItem('gms_token'), cu: API.currentUser?.username})")
    print(f"State: {state}")

    print("\n=== Console ===")
    for l in logs:
        print(f"  {l[:300]}")

    browser.close()
proc.terminate()
