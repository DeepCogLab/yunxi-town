# 云溪镇一键启动：安装依赖 → 构建前端 → 启动服务 → 打开浏览器
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path ".env")) { Copy-Item ".env.example" ".env"; Write-Host "已生成 .env，请填入 LLM_API_KEY（不填则为离线规则模式）" -ForegroundColor Yellow }

Write-Host "==> 检查 Python 依赖" -ForegroundColor Cyan
python -m pip install -q -r backend/requirements.txt

if (-not (Test-Path "frontend/dist/index.html") -or $args -contains "-rebuild") {
  Write-Host "==> 构建前端" -ForegroundColor Cyan
  Push-Location frontend
  if (-not (Test-Path "node_modules")) { npm install --no-audit --no-fund }
  npm run build
  Pop-Location
}

$port = if ($env:PORT) { $env:PORT } else { 8000 }
Write-Host "==> 启动云溪镇：http://localhost:$port" -ForegroundColor Green
Start-Job { Start-Sleep 3; Start-Process "http://localhost:$using:port" } | Out-Null
python -m uvicorn app.main:app --app-dir backend --host 0.0.0.0 --port $port
