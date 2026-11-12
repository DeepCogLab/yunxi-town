# 开发模式：后端热重载 + Vite 前端热更新（访问 http://localhost:5173）
Set-Location $PSScriptRoot
Start-Process powershell -ArgumentList "-NoExit", "-Command", "python -m uvicorn app.main:app --app-dir backend --reload --port 8000"
Set-Location frontend
npm run dev
