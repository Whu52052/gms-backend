"""Test login flow with error checking"""
import subprocess, time
from playwright.sync_api import sync_playwright

subprocess.run(["taskkill", "/f", "/im", "node.exe"], capture_output=True)
time.sleep(2)

proc = subprocess.Popen(["node", "server.js"], cwd=r"D:\HuaweiMoveData\Users\24492\Desktop\Shout",
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
time.sleep(8)

BASE = "http://localhost:8765"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()

    logs = []
    page.on("console", lambda msg: logs.append(f"[{msg.type}] {msg.text}"))
    page.on("pageerror", lambda err: logs.append(f"[ERR] {err}"))

    print("=== yunying login ===")
    page.goto(f"{BASE}/index.html")
    page.wait_for_timeout(2000)

    # Override API.login to log details
    page.evaluate("""
        () => {
            const orig = API.login.bind(API);
            API.login = async function(u, p) {
                console.log('[API.login] called with:', u, p);
                const r = await orig(u, p);
                console.log('[API.login] result:', JSON.stringify({success: r.success, user: r.user?.username, system: r.user?.system, msg: r.message}));
                return r;
            };
        }
    """)

    page.fill("#login-username", "yunying")
    page.fill("#login-password", "yunying1025")
    page.click("#login-btn")
    page.wait_for_timeout(3000)

    # Check error message
    err = page.evaluate("() => document.getElementById('login-error')?.textContent || 'no error'")
    print(f"Error msg: {err}")
    print(f"URL: {page.url}")

    # Check API
    ls = page.evaluate("() => ({token: !!localStorage.getItem('gms_token'), user: !!localStorage.getItem('gms_user'), online: API.online, cu: !!API.currentUser})")
    print(f"State: {ls}")

    # Now try admin
    print("\n=== admin login ===")
    page.goto(f"{BASE}/index.html")
    page.wait_for_timeout(2000)

    page.fill("#login-username", "admin")
    page.fill("#login-password", "admin123")
    page.click("#login-btn")
    page.wait_for_timeout(3000)

    err = page.evaluate("() => document.getElementById('login-error')?.textContent || 'no error'")
    print(f"Error msg: {err}")
    print(f"URL: {page.url}")
    ls = page.evaluate("() => ({token: !!localStorage.getItem('gms_token'), user: !!localStorage.getItem('gms_user'), cu: !!API.currentUser, logged: document.body.classList.contains('logged-in')})")
    print(f"State: {ls}")

    # Logs
    print(f"\n=== Console ({len(logs)}) ===")
    for l in logs:
        print(f"  {l[:250]}")

    page.screenshot(path=r"D:\HuaweiMoveData\Users\24492\Desktop\Shout\screenshot_final.png")
    browser.close()

proc.terminate()
