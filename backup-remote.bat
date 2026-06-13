@echo off
title 远程数据备份 - 10.5.50.240:8765
echo ========================================
echo   远程手套管理系统数据备份
echo   目标: http://10.5.50.240:8765
echo ========================================
echo.

set REMOTE=http://10.5.50.240:8765
set BACKUP_FILE=remote-backup-10.5.50.240-%date:~0,4%%date:~5,2%%date:~8,2%-%time:~0,2%%time:~3,2%%time:~6,2%.json
set BACKUP_FILE=%BACKUP_FILE: =0%

echo [1/4] 登录远程服务器...
curl -s -X POST %REMOTE%/api/auth/login -H "Content-Type: application/json" -d "{\"username\":\"admin\",\"password\":\"admin123\"}" > remote_token.json
node -e "const t=require('./remote_token.json');if(t.token){process.stdout.write(t.token)}else{console.error('登录失败: '+(t.error||''));process.exit(1)}" > remote_token.txt
set /p TOKEN=<remote_token.txt
if "%TOKEN%"=="" (
    echo [错误] 登录失败，请检查用户名密码或网络连接
    del remote_token.json remote_token.txt 2>nul
    pause
    exit /b 1
)
echo   登录成功

echo.
echo [2/4] 获取数据...
curl -s %REMOTE%/api/inventory -H "Authorization: Bearer %TOKEN%" > remote_inventory.json
curl -s %REMOTE%/api/machines -H "Authorization: Bearer %TOKEN%" > remote_machines.json
curl -s "http://10.5.50.240:8765/api/transactions?limit=99999" -H "Authorization: Bearer %TOKEN%" > remote_transactions.json
curl -s %REMOTE%/api/sn-registry -H "Authorization: Bearer %TOKEN%" > remote_registry.json
curl -s %REMOTE%/api/settings -H "Authorization: Bearer %TOKEN%" > remote_settings.json
curl -s %REMOTE%/api/audit-log -H "Authorization: Bearer %TOKEN%" > remote_audit.json
curl -s %REMOTE%/api/equipment-config -H "Authorization: Bearer %TOKEN%" > remote_eq_config.json
curl -s %REMOTE%/api/inventory-config -H "Authorization: Bearer %TOKEN%" > remote_inv_config.json
curl -s %REMOTE%/api/users -H "Authorization: Bearer %TOKEN%" > remote_users.json

echo   数据获取完成

echo.
echo [3/4] 合并为备份文件...
node -e "const fs=require('fs');const inv=JSON.parse(fs.readFileSync('remote_inventory.json','utf8'));const machines=JSON.parse(fs.readFileSync('remote_machines.json','utf8'));const txs=JSON.parse(fs.readFileSync('remote_transactions.json','utf8'));const reg=JSON.parse(fs.readFileSync('remote_registry.json','utf8'));const settings=JSON.parse(fs.readFileSync('remote_settings.json','utf8'));const audit=JSON.parse(fs.readFileSync('remote_audit.json','utf8'));const eqCfg=JSON.parse(fs.readFileSync('remote_eq_config.json','utf8'));const invCfg=JSON.parse(fs.readFileSync('remote_inv_config.json','utf8'));const users=JSON.parse(fs.readFileSync('remote_users.json','utf8'));const data={version:'2.0',exportedAt:new Date().toISOString(),source:'http://10.5.50.240:8765',inventory:inv,machines:machines,transactions:txs,snRegistry:reg,settings:settings,auditLog:audit,equipmentConfig:eqCfg,inventoryConfig:invCfg,users:users};const invMap={};inv.forEach(i=>{invMap[i.type]=i.quantity});data.inventoryQuantities=invMap;fs.writeFileSync('%BACKUP_FILE%',JSON.stringify(data,null,2));console.log('备份文件: %BACKUP_FILE%');console.log('  - 库存类型: '+inv.length);console.log('  - 机器记录: '+machines.length);console.log('  - 流水记录: '+txs.length);console.log('  - SN注册表: '+reg.length);console.log('  - 用户: '+users.length)"

echo.
echo [4/4] 清理临时文件...
del remote_token.json remote_token.txt remote_inventory.json remote_machines.json remote_transactions.json remote_registry.json remote_settings.json remote_audit.json remote_eq_config.json remote_inv_config.json remote_users.json 2>nul

echo.
echo ========================================
echo   备份完成！
echo   文件: %BACKUP_FILE%
echo ========================================
pause
