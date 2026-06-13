import paramiko, sys, time
sys.stdout.reconfigure(encoding='utf-8')
ssh=paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())

for attempt in range(5):
    try:
        print(f"Attempt {attempt+1}...")
        ssh.connect('123.207.74.164', username='ubuntu', password='Wh111852', timeout=15)
        print("SSH connected!")
        break
    except Exception as e:
        print(f"  Failed: {e}")
        if attempt < 4:
            time.sleep(5)

def run(cmd):
    stdin,stdout,stderr=ssh.exec_command(cmd,get_pty=True)
    stdout.channel.recv_exit_status()
    return stdout.read().decode('utf-8',errors='replace')

# Check current config
print("\n=== Current config.js ===")
out = run("grep '__GMS_SERVER_URL__' ~/app/js/config.js")
print(out.strip())

# Fix it - set to empty to use same-origin
print("\n=== Fixing config.js ===")
run("sed -i \"s|window.__GMS_SERVER_URL__ = '.*'|window.__GMS_SERVER_URL__ = ''|\" ~/app/js/config.js")
out = run("grep '__GMS_SERVER_URL__' ~/app/js/config.js")
print(f"Fixed: {out.strip()}")

# Restart service
run("sudo systemctl restart gms")
print("Service restarted!")
time.sleep(3)

# Verify
out = run("curl -s http://localhost:8765/api/health")
print(f"API: {out.strip()}")

out = run("curl -s http://localhost:8765/ | head -c 200")
print(f"Main page: {out[:100]}...")

ssh.close()
print("\nDone! Config fixed - login should work now.")
