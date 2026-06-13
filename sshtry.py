import paramiko,sys,time
sys.stdout.reconfigure(encoding='utf-8')
ssh=paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())

for i in range(3):
    try:
        print(f"Try {i+1}...")
        ssh.connect('123.207.74.164',username='ubuntu',password='Wh111852',timeout=10)
        print("SSH OK!")
        def run(cmd):
            stdin,stdout,stderr=ssh.exec_command(cmd,get_pty=True)
            stdout.channel.recv_exit_status()
            return stdout.read().decode('utf-8',errors='replace')

        # Fix config
        run("sed -i \"s|window.__GMS_SERVER_URL__ = '.*'|window.__GMS_SERVER_URL__ = ''|\" ~/app/js/config.js")
        print("config.js fixed")

        # Install nginx
        out=run("sudo apt-get install -y nginx 2>&1 | tail -3")
        print(f"nginx install: {out.strip()}")

        # Create nginx config
        cfg="""server {
    listen 80;
    server_name shout-zb.icu;

    location / {
        proxy_pass http://127.0.0.1:8765;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
    }
}"""
        run(f"echo '{cfg}' | sudo tee /etc/nginx/sites-available/gms > /dev/null")
        run("sudo ln -sf /etc/nginx/sites-available/gms /etc/nginx/sites-enabled/")
        run("sudo rm -f /etc/nginx/sites-enabled/default")
        run("sudo nginx -t 2>&1")
        run("sudo systemctl restart nginx")
        print("Nginx configured!")

        # Open port 80
        run("sudo ufw allow 80/tcp 2>&1")

        # Restart gms
        run("sudo systemctl restart gms")
        time.sleep(2)

        # Tests
        out=run("curl -s http://localhost:8765/api/health")
        print(f"App: {out.strip()}")
        out=run("curl -s http://localhost:80/api/health")
        print(f"Nginx: {out.strip()}")

        print("\n*** DONE! ***")
        print("Set DNS A record: shout-zb.icu -> 123.207.74.164")
        print("Then access: http://shout-zb.icu")
        break
    except Exception as e:
        print(f"Failed: {e}")
        time.sleep(3)

ssh.close()
