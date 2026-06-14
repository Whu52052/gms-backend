"""Debug localStorage and API.login directly"""
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

    # Override localStorage.setItem to log calls
    page.goto(f"{BASE}/index.html")
    page.wait_for_timeout(2000)

    page.evaluate("""
        () => {
            const origSet = localStorage.setItem.bind(localStorage);
            localStorage.setItem = function(key, value) {
                console.log('[LS SET] ' + key + ' = ' + (value ? value.substring(0, 30) : 'null'));
                return origSet(key, value);
            };
            const origGet = localStorage.getItem.bind(localStorage);
            localStorage.getItem = function(key) {
                const v = origGet(key);
                console.log('[LS GET] ' + key + ' = ' + (v ? 'FOUND' : 'null'));
                return v;
            };
            console.log('[DEBUG] localStorage override installed');
        }
    """)

    print("=== Login yunying ===")
    page.fill("#login-username", "yunying")
    page.fill("#login-password", "yunying1025")
    page.click("#login-btn")
    page.wait_for_timeout(4000)

    print(f"URL: {page.url}")
    state = page.evaluate("() => { return {token: !!localStorage.getItem('gms_token'), cu: API.currentUser?.username, url: window.location.href}; }")
    print(f"State: {state}")

    # Check for error message
    err = page.evaluate("() => document.getElementById('login-error')?.textContent || ''")
    print(f"Error: '{err}'")

    print(f"\n=== Console ===")
    for l in logs:
        if any(k in l for k in ['LS ', 'DEBUG', 'login', 'error', 'ERR', '401']):
            print(f"  {l[:250]}")

    page.screenshot(path="screenshot5.png")
    browser.close()

proc.terminate()
