@echo off
setlocal
cd /d "%~dp0"

if not exist "web\node_modules" (
  pushd web
  call npm install --no-audit --no-fund
  popd
)

start "english-learn API" cmd /k "node server\src\index.js"
timeout /t 2 >nul

echo.
echo API   http://localhost:8787
echo 前端  http://localhost:5173  ^(开发模式，改代码自动刷新^)
echo.
pushd web
call npm run dev
