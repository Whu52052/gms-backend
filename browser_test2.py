"""Detailed browser test"""
import subprocess, time
from playwright.sync_api import sync_playwright

# Kill existing
subprocess.run(["taskkill", "/f", "/im", "node.exe"], capture_output=True)
time.sleep(2)

print("Starting server...")
proc = subprocess.Popen(["node", "server.js"], cwd=r"D:\HuaweiMoveData\Users\24492\Desktop\Shout",
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
time.sleep(8)  # More time for DB connection

BASE = "http://localhost:8765"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()

    # Log ALL console messages
    logs = []
    page.on("console", lambda msg: logs.append(f"[{msg.type}] {msg.text}"))
    page.on("pageerror", lambda err: logs.append(f"[PAGE ERROR] {err}"))

    print("\n=== Testing yunying login ===")
    page.goto(f"{BASE}/index.html")
    page.wait_for_timeout(2000)

    # Check state before login
    sys_check = page.evaluate("""
        () => ({
            online: API.online,
            token: !!API.token,
            currentUser: API.currentUser,
            baseURL: API.baseURL,
            loginForm: !!document.getElementById('login-username')
        })
    """)
    print(f"Before login: {sys_check}")

    # Check yunying API login manually first
    result = page.evaluate("""
        async () => {
            const r = await fetch('/api/auth/login', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({username:'yunying', password:'yunying1025'})
            });
            const d = await r.json();
            return {status: r.status, system: d.user?.system, hasToken: !!d.token};
        }
    """)
    print(f"Manual API login: {result}")

    # Now do the actual login flow
    page.fill("#login-username", "yunying")
    page.fill("#login-password", "yunying1025")

    # Intercept and check what doLogin does
    page.evaluate("""
        () => {
            const orig = App.doLogin;
            App.doLogin = async function() {
                console.log('[DEBUG] doLogin called');
                const result = await orig.call(this);
                console.log('[DEBUG] doLogin result:', JSON.stringify(result));
                return result;
            };
        }
    """)

    page.click("#login-btn")
    page.wait_for_timeout(3000)

    print(f"After login URL: {page.url}")
    ls = page.evaluate("() => ({token: !!localStorage.getItem('gms_token'), user: localStorage.getItem('gms_user')})")
    print(f"localStorage: {ls}")
    cu = page.evaluate("() => API.currentUser")
    print(f"API.currentUser: {cu}")

    # Take screenshot
    page.screenshot(path=r"D:\HuaweiMoveData\Users\24492\Desktop\Shout\screenshot_after.png")
    print("Screenshot saved")

    # Print all logs
    print(f"\n=== Console ({len(logs)} messages) ===")
    for l in logs:
        if any(k in l.lower() for k in ['error', 'debug', 'login', 'auth', 'token', 'fail', '401', '500']):
            print(f"  {l[:200]}")

    browser.close()

proc.terminate()
