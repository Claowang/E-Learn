@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo 需要先安装 Node.js 22 或更高版本：https://nodejs.org
  pause
  exit /b 1
)

if not exist "web\node_modules" (
  echo [1/3] 首次运行，安装前端依赖，需要几分钟...
  pushd web
  call npm install --no-audit --no-fund
  popd
)

if not exist "web\dist\index.html" (
  echo [2/3] 构建前端页面...
  pushd web
  call npm run build
  popd
)

echo [3/3] 启动服务，浏览器打开 http://localhost:8787
echo 首次启动会打印登录密码，请记下来。按 Ctrl+C 停止服务。
node server\src\index.js
