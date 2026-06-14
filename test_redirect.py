"""Test redirect from index to operations"""
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

    # Step 1: Login on index.html, then manually go to operations.html
    print("=== Step 1: Login on index ===")
    page.goto("http://localhost:8765/index.html")
    page.wait_for_timeout(2000)

    page.fill("#login-username", "yunying")
    page.fill("#login-password", "yunying1025")
    page.click("#login-btn")
    page.wait_for_timeout(3000)

    state1 = page.evaluate("() => ({url: window.location.href, token: !!localStorage.getItem('gms_token'), cu: API.currentUser?.username, logged: document.body.classList.contains('logged-in')})")
    print(f"After login: {state1}")

    # Step 2: Manually navigate to operations.html
    print("\n=== Step 2: Go to operations.html ===")
    page.goto("http://localhost:8765/operations.html")
    page.wait_for_timeout(3000)

    state2 = page.evaluate("() => ({url: window.location.href, token: !!localStorage.getItem('gms_token'), cu: API.currentUser?.username, logged: document.body.classList.contains('logged-in')})")
    print(f"After ops page: {state2}")

    # Check ops init
    has_sidebar = page.evaluate("() => !!document.querySelector('.sidebar')")
    print(f"Sidebar: {has_sidebar}")

    print(f"\n=== Console ({len(logs)}) ===")
    for l in logs:
        if any(k in l.lower() for k in ['error', 'err', 'fail', '401', '500', 'validat', 'logout', 'check']):
            print(f"  {l[:250]}")

    page.screenshot(path="screenshot_ops.png")
    browser.close()
proc.terminate()
