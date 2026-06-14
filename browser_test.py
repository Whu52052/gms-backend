"""Headless browser test for login flow"""
import subprocess, time, sys, json
from playwright.sync_api import sync_playwright

# Start local server
print("Starting local server...")
proc = subprocess.Popen(["node", "server.js"], cwd=r"D:\HuaweiMoveData\Users\24492\Desktop\Shout",
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
time.sleep(5)

BASE = "http://localhost:8765"
errors = []

def log(msg):
    print(f"  {msg}")

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context()
    page = context.new_page()

    # Collect console errors
    page.on("console", lambda msg: errors.append(f"[{msg.type}] {msg.text}") if msg.type in ("error", "warning") else None)
    page.on("pageerror", lambda err: errors.append(f"[JS ERROR] {err}"))

    # === TEST 1: Login as yunying on index.html ===
    print("\n=== Test 1: yunying login on index.html ===")
    page.goto(f"{BASE}/index.html")
    page.wait_for_timeout(2000)
    log(f"Title: {page.title()}")
    log(f"URL: {page.url}")

    # Check if login form is visible
    login_visible = page.is_visible("#login-username")
    log(f"Login form visible: {login_visible}")

    if login_visible:
        # Fill login form
        page.fill("#login-username", "yunying")
        page.fill("#login-password", "yunying1025")
        page.click("#login-btn")
        page.wait_for_timeout(3000)

        log(f"After login URL: {page.url}")
        log(f"After login title: {page.title()}")

        # Should be on operations.html now
        if "operations" in page.url:
            log("Redirected to operations page")

            # Check if logged in
            logged_in = page.evaluate("() => document.body.classList.contains('logged-in')")
            log(f"Body has logged-in class: {logged_in}")
            current_user = page.evaluate("() => API.currentUser")
            log(f"API.currentUser: {current_user.get('username') if current_user else 'null'}")
        else:
            log("NOT redirected - still on index.html")
            # Check for API.currentUser
            current_user = page.evaluate("() => API.currentUser")
            log(f"API.currentUser: {current_user.get('username') if current_user else 'null'}")
            # Check sessionStorage/localStorage
            ls_token = page.evaluate("() => localStorage.getItem('gms_token')")
            log(f"localStorage token: {'present' if ls_token else 'null'}")
            ss_token = page.evaluate("() => sessionStorage.getItem('gms_token')")
            log(f"sessionStorage token: {'present' if ss_token else 'null'}")

    # === TEST 2: Login as admin on index.html ===
    print("\n=== Test 2: admin login on index.html ===")
    page.goto(f"{BASE}/index.html")
    page.wait_for_timeout(2000)

    login_visible = page.is_visible("#login-username")
    if login_visible:
        page.fill("#login-username", "admin")
        page.fill("#login-password", "admin123")
        page.click("#login-btn")
        page.wait_for_timeout(3000)

        log(f"After login URL: {page.url}")
        logged_in = page.evaluate("() => document.body.classList.contains('logged-in')")
        log(f"Logged in (admin): {logged_in}")
        current_user = page.evaluate("() => API.currentUser")
        log(f"API.currentUser: {current_user.get('username') if current_user else 'null'}")

        if not logged_in:
            log("Admin login failed! Checking...")
            page.screenshot(path=r"D:\HuaweiMoveData\Users\24492\Desktop\Shout\screenshot_admin.png")
            log("Screenshot saved")

    # Print all collected errors
    print(f"\n=== Console Errors ({len(errors)}) ===")
    for e in errors[:20]:
        print(f"  {e}")

    browser.close()

proc.terminate()
print("\nDone!")
