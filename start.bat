@echo off
echo.
echo  JORD Golf Tournament System
echo  ================================

where node >nul 2>nul
if %errorlevel% neq 0 (
  echo  Node.js not found. Download from https://nodejs.org
  pause
  exit /b 1
)

echo  Node.js found.

if not exist node_modules (
  echo  Installing dependencies...
  npm install --silent
)

if not exist .env (
  copy .env.example .env
  echo.
  echo  IMPORTANT: Open .env and add your Mapbox token from mapbox.com
  pause
)

echo.
echo  Running tests...
node tests\run-tests.js

echo.
echo  Starting server...
echo.
echo  Open your browser to: http://localhost:3000/admin
echo  Default password: jord2026
echo.

node server.js
pause
