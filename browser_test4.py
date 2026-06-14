"""Test WITHOUT debug override"""
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

    print("=== yunying login (no debug override) ===")
    page.goto(f"{BASE}/index.html")
    page.wait_for_timeout(2000)

    page.fill("#login-username", "yunying")
    page.fill("#login-password", "yunying1025")
    page.click("#login-btn")
    page.wait_for_timeout(3000)

    print(f"URL: {page.url}")
    state = page.evaluate("""
        () => ({
            URL: window.location.href,
            token: !!localStorage.getItem('gms_token'),
            user: !!localStorage.getItem('gms_user'),
            cu: API.currentUser,
            tokenVal: API.token,
            online: API.online,
            loggedClass: document.body.classList.contains('logged-in'),
            errorMsg: document.getElementById('login-error')?.textContent || ''
        })
    """)
    print(f"State: {state}")

    # Admin test
    print("\n=== admin login ===")
    page.goto(f"{BASE}/index.html")
    page.wait_for_timeout(2000)
    page.fill("#login-username", "admin")
    page.fill("#login-password", "admin123")
    page.click("#login-btn")
    page.wait_for_timeout(3000)

    state2 = page.evaluate("""
        () => ({
            URL: window.location.href,
            token: !!localStorage.getItem('gms_token'),
            cu: API.currentUser?.username,
            loggedClass: document.body.classList.contains('logged-in')
        })
    """)
    print(f"State: {state2}")

    print(f"\n=== Console ({len(logs)}) ===")
    for l in logs:
        print(f"  {l[:200]}")

    page.screenshot(path=r"D:\HuaweiMoveData\Users\24492\Desktop\Shout\screenshot4.png")
    browser.close()

proc.terminate()
